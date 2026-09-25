import * as THREE from 'three';
import { REGION_NAMES } from './sculpt.js';

// PS2-style single body texture: auto-unwrap the sculpted mesh into charts (one per dominant bone,
// split into side/cap projections), pack them, then paint the atlas from 3D. Fabric is sampled
// triplanar in bind space, so chart seams don't show; region boundaries (sleeves, waist, collar,
// shoes) are crisp regardless of triangulation; AO, hems, belt, buttons and grime are baked in.

// parts: [{ positions, normals, ao, indices, skinIndex, skinWeight }] (model space, head units)
// segs: bone index -> [a, b] (Vector3), the bone's axis used for cylindrical projection
export function unwrap(parts, segs, R, res) {
  const P = [], N = [], A = [], SI = [], SW = [], LY = [], AX = [], charts = new Map();
  let base = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  const tris = [];
  for (const part of parts) {
    const I = part.indices, nv = part.positions.length / 3;
    for (let t = 0; t < I.length; t += 3) {
      const v = [I[t] + base, I[t + 1] + base, I[t + 2] + base];
      tris.push(v);
    }
    P.push(part.positions); N.push(part.normals); A.push(part.ao); SI.push(part.skinIndex); SW.push(part.skinWeight);
    LY.push(new Float32Array(nv).fill(part.layer));
    AX.push(part.aux || new Float32Array(nv));
    base += nv;
  }
  const pos = concat(P, Float32Array), nor = concat(N, Float32Array), ao = concat(A, Float32Array);
  const si = concat(SI, Uint16Array), sw = concat(SW, Float32Array), ly = concat(LY, Float32Array), ax = concat(AX, Float32Array);

  // chart per (dominant bone, side|cap)
  for (const v of tris) {
    const score = new Map();
    for (const i of v) for (let k = 0; k < 4; k++) {
      const w = sw[i * 4 + k];
      if (w > 0) score.set(si[i * 4 + k], (score.get(si[i * 4 + k]) || 0) + w);
    }
    const bone = [...score.entries()].sort((x, y) => y[1] - x[1])[0][0];
    a.fromArray(pos, v[0] * 3); b.fromArray(pos, v[1] * 3); c.fromArray(pos, v[2] * 3);
    n.copy(b).sub(a).cross(c.clone().sub(a)).normalize();
    const seg = segs[bone];
    const axis = seg[1].clone().sub(seg[0]).normalize();
    const cap = Math.abs(n.dot(axis)) > 0.7;
    const layer = ly[v[0]]; // a garment and the skin under it must never share UV space
    const key = `${layer}:${bone}:${cap ? 'c' : 's'}`;
    if (!charts.has(key)) charts.set(key, { bone, cap, axis, origin: seg[0], layer, tris: [] });
    charts.get(key).tris.push(v);
  }

  const outP = [], outN = [], outA = [], outSI = [], outSW = [], outUV = [], outL = [], outX = [], outTri = [];
  const list = [...charts.values()];
  for (const ch of list) {
    const ax = ch.axis;
    const ref = [new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0)]
      .sort((x, y) => Math.abs(x.dot(ax)) - Math.abs(y.dot(ax)))[0];
    const e1 = ref.clone().addScaledVector(ax, -ref.dot(ax)).normalize(), e2 = ax.clone().cross(e1);
    const d = new THREE.Vector3();
    const local = (i) => d.fromArray(pos, i * 3).sub(ch.origin);
    let radius = 0, count = 0;
    if (!ch.cap) for (const v of ch.tris) for (const i of v) { local(i); radius += Math.hypot(d.dot(e1), d.dot(e2)); count++; }
    radius = count ? radius / count : 1;
    const map = new Map();
    ch.min = [Infinity, Infinity]; ch.max = [-Infinity, -Infinity];
    ch.verts = [];
    for (const v of ch.tris) {
      let uv = v.map((i) => {
        local(i);
        return ch.cap ? [d.dot(e1), d.dot(e2)] : [Math.atan2(d.dot(e2), d.dot(e1)), d.dot(ax)];
      });
      let wrapped = false;
      if (!ch.cap) {
        const angs = uv.map((q) => q[0]);
        if (Math.max(...angs) - Math.min(...angs) > Math.PI) { wrapped = true; uv = uv.map((q) => [q[0] < 0 ? q[0] + 2 * Math.PI : q[0], q[1]]); }
        uv = uv.map((q) => [q[0] * radius, q[1]]);
      }
      const tri = v.map((i, k) => {
        const key = `${i}:${wrapped && uv[k][0] > Math.PI * radius * 0.999 ? 1 : 0}`;
        if (!map.has(key)) {
          map.set(key, ch.verts.length);
          ch.verts.push({ i, uv: uv[k] });
          ch.min[0] = Math.min(ch.min[0], uv[k][0]); ch.min[1] = Math.min(ch.min[1], uv[k][1]);
          ch.max[0] = Math.max(ch.max[0], uv[k][0]); ch.max[1] = Math.max(ch.max[1], uv[k][1]);
        }
        return map.get(key);
      });
      (ch.local ||= []).push(tri);
    }
    ch.w = ch.max[0] - ch.min[0]; ch.h = ch.max[1] - ch.min[1];
    ch.rot = ch.h > ch.w;
    if (ch.rot) [ch.w, ch.h] = [ch.h, ch.w];
  }

  // shelf packing into a square, uniform texel density
  list.sort((x, y) => y.h - x.h);
  let side = Math.sqrt(list.reduce((s, ch) => s + ch.w * ch.h, 0)) * 1.02;
  for (let tries = 0; tries < 120; tries++) {
    const pad = (3 / res) * side;
    let x = pad, y = pad, shelf = 0, ok = true;
    for (const ch of list) {
      if (x + ch.w + pad > side) { x = pad; y += shelf + pad; shelf = 0; }
      ch.at = [x, y]; x += ch.w + pad; shelf = Math.max(shelf, ch.h);
      if (y + ch.h + pad > side) { ok = false; break; }
    }
    if (ok) break;
    side *= 1.03;
  }

  let vbase = 0;
  const regions = [];
  for (const ch of list) {
    for (const v of ch.verts) {
      outP.push(pos[v.i * 3], pos[v.i * 3 + 1], pos[v.i * 3 + 2]);
      outN.push(nor[v.i * 3], nor[v.i * 3 + 1], nor[v.i * 3 + 2]);
      outA.push(ao[v.i]);
      outL.push(ch.layer);
      outX.push(ax[v.i]);
      for (let k = 0; k < 4; k++) { outSI.push(si[v.i * 4 + k]); outSW.push(sw[v.i * 4 + k]); }
      const lu = v.uv[0] - ch.min[0], lv = v.uv[1] - ch.min[1];
      const [cu, cv] = ch.rot ? [lv, lu] : [lu, lv];
      outUV.push((cu + ch.at[0]) / side, (cv + ch.at[1]) / side);
    }
    for (const t of ch.local) {
      regions.push(ch.layer);
      outTri.push(t.map((k) => k + vbase));
    }
    vbase += ch.verts.length;
  }

  // triangles grouped by clothing region -> one primitive per region, all sharing the atlas
  const order = outTri.map((_, i) => i).sort((x, y) => regions[x] - regions[y]);
  const index = [], groups = [];
  for (const i of order) {
    const r = regions[i];
    if (!groups.length || groups[groups.length - 1].region !== r) groups.push({ region: r, name: REGION_NAMES[r], start: index.length, count: 0 });
    index.push(...outTri[i]);
    groups[groups.length - 1].count += 3;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(outP, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(outN, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(outUV, 2));
  geo.setAttribute('ao', new THREE.Float32BufferAttribute(outA, 1));
  geo.setAttribute('layer', new THREE.Float32BufferAttribute(outL, 1));
  geo.setAttribute('aux', new THREE.Float32BufferAttribute(outX, 1));
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(outSI, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(outSW, 4));
  geo.setIndex(index);
  return { geo, groups, charts: list.length };
}

function concat(arrs, T) {
  const out = new T(arrs.reduce((s, x) => s + x.length, 0));
  let o = 0;
  for (const x of arrs) { out.set(x, o); o += x.length; }
  return out;
}

export class BodyBaker {
  // fragment/uniforms: optional custom painter (the head uses its own); default paints the body
  constructor(renderer, { fragment = BAKE_FRAG, uniforms = {} } = {}) {
    this.r = renderer;
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
    this.mat = new THREE.ShaderMaterial({
      side: THREE.DoubleSide, depthTest: false, transparent: false,
      uniforms: {
        tex0: { value: null }, tex1: { value: null }, tex2: { value: null }, tex3: { value: null },
        tint0: { value: new THREE.Vector3(0, 1, 1) }, tint1: { value: new THREE.Vector3(0, 1, 1) },
        tint2: { value: new THREE.Vector3(0, 1, 1) }, tint3: { value: new THREE.Vector3(0, 1, 1) },
        waistY: { value: 0 }, collarY: { value: 0 }, shoulderX: { value: 1 }, wristX: { value: 2 },
        ankleY: { value: 0 }, crotchY: { value: 0 }, sleeve: { value: 1 }, pants: { value: 1 },
        skirt: { value: 0 }, hemY: { value: 0 }, neckZ: { value: 0 }, neckHole: { value: 0.4 }, hemRound: { value: 0.1 }, shoulderY: { value: 0 }, armBand: { value: 1 }, toeZ: { value: 0 },
        belt: { value: 0 }, buttons: { value: 0 }, grime: { value: 0 }, tile: { value: 1 / 0.9 },
        bare: { value: new THREE.Vector4() }, // 1 where a region's fabric is just skin
        ...uniforms,
      },
      vertexShader: /* glsl */`
        attribute float ao; attribute float layer; attribute float aux;
        varying vec3 vPos; varying vec3 vNor; varying float vAo; varying float vLayer; varying float vAux;
        void main(){ vPos = position; vNor = normal; vAo = ao; vLayer = layer; vAux = aux; gl_Position = vec4(uv * 2. - 1., 0., 1.); }`,
      fragmentShader: fragment,
    });
    this.scene = new THREE.Scene();
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.mat);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
    this.dilate = new THREE.ShaderMaterial({
      uniforms: { src: { value: null }, texel: { value: new THREE.Vector2() } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }',
      fragmentShader: /* glsl */`
        uniform sampler2D src; uniform vec2 texel; varying vec2 vUv;
        void main(){
          vec4 c = texture2D(src, vUv);
          if (c.a > .5) { gl_FragColor = c; return; }
          vec4 s = vec4(0.);
          for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
            vec4 n = texture2D(src, vUv + vec2(x, y) * texel);
            if (n.a > .5) s += vec4(n.rgb, 1.);
          }
          gl_FragColor = s.a > 0. ? vec4(s.rgb / s.a, 1.) : c;
        }`,
      depthTest: false,
    });
    this.quad = new THREE.Scene();
    this.quad.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.dilate));
  }

  // inputs: per region { map, hue, sat, bright }
  bake(geo, R, inputs, res, grime) {
    if (!this.rt || this.rt.width !== res) {
      this.rt?.dispose(); this.rt2?.dispose();
      const o = { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter };
      this.rt = new THREE.WebGLRenderTarget(res, res, o);
      this.rt2 = new THREE.WebGLRenderTarget(res, res, o);
    }
    const u = this.mat.uniforms;
    inputs.forEach((inp, i) => { u['tex' + i].value = inp.map; u['tint' + i].value.set(inp.hue, inp.sat, inp.bright); });
    u.bare.value.set(...inputs.map((inp, i) => (i === 3 || inp.map === inputs[3].map ? 1 : 0)));
    for (const k of ['waistY', 'collarY', 'shoulderX', 'wristX', 'ankleY', 'crotchY', 'sleeve', 'pants', 'hemY', 'neckZ', 'neckHole', 'hemRound', 'shoulderY', 'armBand', 'toeZ']) u[k].value = R[k === 'hemRound' ? 'round' : k];
    u.skirt.value = R.skirt ? 1 : 0;
    u.belt.value = R.details.belt ? 1 : 0;
    u.buttons.value = R.details.buttons ? 1 : 0;
    u.grime.value = grime;
    return this.paint(geo, res);
  }

  // render the atlas with the current uniforms, then dilate so chart edges never sample black
  paint(geo, res) {
    if (!this.rt || this.rt.width !== res) {
      this.rt?.dispose(); this.rt2?.dispose();
      const o = { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter };
      this.rt = new THREE.WebGLRenderTarget(res, res, o);
      this.rt2 = new THREE.WebGLRenderTarget(res, res, o);
    }
    this.mesh.geometry = geo;
    const r = this.r, prev = r.getClearColor(new THREE.Color()), prevA = r.getClearAlpha();
    r.setClearColor(0x000000, 0);
    r.setRenderTarget(this.rt); r.clear(); r.render(this.scene, this.cam);
    this.dilate.uniforms.texel.value.set(1 / res, 1 / res);
    let src = this.rt, dst = this.rt2;
    for (let i = 0; i < 4; i++) {
      this.dilate.uniforms.src.value = src.texture;
      r.setRenderTarget(dst); r.clear(); r.render(this.quad, this.cam);
      [src, dst] = [dst, src];
    }
    r.setRenderTarget(null);
    r.setClearColor(prev, prevA);
    this.out = src;
    return src.texture;
  }

  toCanvas(canvas = document.createElement('canvas')) {
    const n = this.out.width, buf = new Uint8Array(n * n * 4);
    this.r.readRenderTargetPixels(this.out, 0, 0, n, n, buf);
    canvas.width = canvas.height = n;
    const g = canvas.getContext('2d'), img = g.createImageData(n, n);
    for (let y = 0; y < n; y++) img.data.set(buf.subarray((n - 1 - y) * n * 4, (n - y) * n * 4), y * n * 4);
    for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
    g.putImageData(img, 0, 0);
    return canvas;
  }
}

const BAKE_FRAG = /* glsl */`
uniform sampler2D tex0, tex1, tex2, tex3;
uniform vec3 tint0, tint1, tint2, tint3; // hue degrees, saturation, brightness
uniform float waistY, collarY, shoulderX, wristX, ankleY, crotchY, sleeve, pants, belt, buttons, grime, tile, skirt, hemY, neckZ, neckHole, hemRound, shoulderY, armBand, toeZ;
uniform vec4 bare;
varying vec3 vPos; varying vec3 vNor; varying float vAo; varying float vLayer;

float hash(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float vnoise(vec3 p){ vec3 i = floor(p), f = fract(p); f = f*f*(3.-2.*f);
  return mix(mix(mix(hash(i), hash(i+vec3(1,0,0)), f.x), mix(hash(i+vec3(0,1,0)), hash(i+vec3(1,1,0)), f.x), f.y),
             mix(mix(hash(i+vec3(0,0,1)), hash(i+vec3(1,0,1)), f.x), mix(hash(i+vec3(0,1,1)), hash(i+vec3(1,1,1)), f.x), f.y), f.z); }

vec3 tintc(vec3 c, vec3 t){
  float a = radians(t.x);
  vec3 y = mat3(.299, .596, .211, .587, -.274, -.523, .114, -.322, .312) * c;
  float h = atan(y.z, y.y) + a, ch = length(y.yz) * t.y;
  return mat3(1., 1., 1., .956, -.272, -1.106, .621, -.647, 1.703) * vec3(y.x, ch * cos(h), ch * sin(h)) * t.z;
}
vec3 tri(sampler2D t, vec3 p, vec3 n){
  vec3 w = pow(abs(n), vec3(4.)); w /= (w.x + w.y + w.z);
  return texture2D(t, p.zy * tile).rgb * w.x + texture2D(t, p.xz * tile).rgb * w.y + texture2D(t, p.xy * tile).rgb * w.z;
}

// garment masks (negative inside), must match masks in sculpt.js; -mask = distance to the hem
float smin_(float a, float b, float k){ float h = max(k - abs(a - b), 0.) / k; return min(a, b) - h * h * k * .25; }
float smax_(float a, float b, float k){ return -smin_(-a, -b, k); }
float maskTop(vec3 p){
  float ax = abs(p.x), len = wristX - shoulderX;
  if (ax > shoulderX * .95 && abs(p.y - shoulderY) < armBand) return ((ax - shoulderX) / len - min(sleeve, 1.)) * len;
  float hole = neckHole - length(vec2(p.x, p.z - neckZ));
  return smax_(waistY - .15 - p.y, smin_(hole, p.y - (collarY - .12), hemRound), hemRound);
}
float maskBottom(vec3 p){
  if (skirt > .5) return smax_(p.y - (waistY + .05), hemY - p.y, hemRound);
  float span = crotchY - ankleY;
  float m = smax_(p.y - waistY, (max(0., crotchY - p.y) / span - pants) * span, hemRound);
  return smax_(m, ankleY + .08 - p.y, hemRound);
}
float maskShoes(vec3 p){ return p.y - (ankleY + .1); }

void main(){
  vec3 p = vPos, n = normalize(vNor);
  int r = int(vLayer + .5);
  float edge = r == 0 ? -maskTop(p) : r == 1 ? -maskBottom(p) : r == 2 ? -maskShoes(p) : 9.;
  vec3 c;
  if (r == 0) c = tintc(tri(tex0, p, n), tint0);
  else if (r == 1) c = tintc(tri(tex1, p, n), tint1);
  else if (r == 2) c = tintc(tri(tex2, p, n), tint2);
  else c = tintc(tri(tex3, p, n), tint3);

  float isBare = r == 0 ? bare.x : r == 1 ? bare.y : r == 2 ? bare.z : 1.;
  // hems: darker fold right at a clothing boundary, and a dashed stitch just inside it
  if (isBare < .5) {
    c *= mix(.55, 1., smoothstep(0., .07, edge));
    float along = p.x * 7. + p.z * 7. + p.y * 3.;
    if (abs(edge - .1) < .012 && fract(along) < .5) c *= 1.25;
  }
  // belt with a buckle at the front
  if (belt > .5 && r == 1 && isBare < .5 && waistY - p.y < .17) {
    c = vec3(.2, .12, .07) * (.8 + .4 * vnoise(p * 30.));
    if (p.z > 0. && abs(p.x) < .1) c = vec3(.72, .64, .42);
  }
  // buttons down the front of the top
  if (buttons > .5 && r == 0 && isBare < .5 && p.z > 0. && abs(p.x) < .06) {
    vec2 q = vec2(p.x, mod(p.y - waistY, .45) - .225);
    if (length(q) < .04) c = vec3(.85, .8, .7) * .6;
  }
  // shoes: a rubber sole strip along the ground and a darker toe cap
  if (r == 2 && isBare < .5) {
    if (p.y < .07) c = vec3(.5, .45, .38) * (.8 + .3 * vnoise(p * 20.));
    else if (p.z > toeZ - .12) c *= .75;
  }
  // bare feet: toe creases on the front of the foot
  if ((r == 3 || isBare > .5) && p.y < ankleY - .05 && p.z > toeZ - .05) {
    float crease = abs(fract(abs(p.x) * 9.) - .5);
    c *= mix(.6, 1., smoothstep(.02, .09, crease));
  }
  // painted light like PS2 textures, baked AO, grime creeping up from the feet
  c *= .9 + .12 * n.y;
  c *= mix(.3, 1., vAo);
  c *= 1. - grime * .45 * smoothstep(3.5, 0., p.y) * (.5 + vnoise(p * 4.));
  gl_FragColor = vec4(clamp(c, 0., 1.), 1.);
}`;
