import * as THREE from 'three';
import { sculptHead } from './headsculpt.js';
import { perf } from './perf.js';
import { unwrap, BodyBaker } from './bodybake.js';

// ---------------- PS2-ish material: vertex snapping, gouraud, affine UVs, 15-bit dither, fog ----------------
export const PS2 = {
  snapRes: { value: new THREE.Vector2(160, 120) },
  affine: { value: 0.5 },
  fogColor: { value: new THREE.Color(0.35, 0.3, 0.45) },
  fogNear: { value: 4 }, fogFar: { value: 14 },
};

export function ps2Material({ map, color = [1, 1, 1], alphaTest = 0, side = THREE.FrontSide } = {}) {
  return new THREE.ShaderMaterial({
    side,
    uniforms: {
      ...PS2,
      map: { value: map || whiteTex() },
      color: { value: new THREE.Color(...color) },
      alphaTest: { value: alphaTest },
      hueShift: { value: 0 }, satMul: { value: 1 },
    },
    vertexShader: /* glsl */`
      #include <common>
      #include <skinning_pars_vertex>
      uniform vec2 snapRes; uniform float fogNear, fogFar;
      varying vec3 vUvw; varying vec2 vUvP; varying vec3 vLight; varying float vFog;
      void main(){
        #include <skinbase_vertex>
        #include <beginnormal_vertex>
        #include <skinnormal_vertex>
        #include <begin_vertex>
        #include <skinning_vertex>
        vec4 mv = modelViewMatrix * vec4(transformed, 1.);
        vec4 cp = projectionMatrix * mv;
        cp.xy = floor(cp.xy / cp.w * snapRes + .5) / snapRes * cp.w;
        gl_Position = cp;
        vec3 n = normalize(mat3(modelMatrix) * objectNormal);
        float key = max(dot(n, normalize(vec3(.6, .8, .7))), 0.);
        float rim = max(dot(n, normalize(vec3(-.8, .1, -.4))), 0.);
        vLight = vec3(.42, .38, .48) + vec3(1., .93, .8) * key * .85 + vec3(.3, .35, .6) * rim * .5;
        vUvw = vec3(uv * cp.w, cp.w); vUvP = uv;
        vFog = smoothstep(fogNear, fogFar, -mv.z);
      }`,
    fragmentShader: /* glsl */`
      uniform sampler2D map; uniform vec3 color, fogColor; uniform float affine, alphaTest, hueShift, satMul;
      varying vec3 vUvw; varying vec2 vUvP; varying vec3 vLight; varying float vFog;
      float bayer2(vec2 a){ a = floor(a); return fract(a.x / 2. + a.y * a.y * .75); }
      float bayer4(vec2 a){ return bayer2(.5 * a) * .25 + bayer2(a); }
      void main(){
        vec2 uv = mix(vUvP, vUvw.xy / vUvw.z, affine);
        vec4 t = texture2D(map, uv);
        if (t.a < alphaTest) discard;
        vec3 c = t.rgb;
        if (hueShift != 0. || satMul != 1.) {
          vec3 y = mat3(.299, .596, .211, .587, -.274, -.523, .114, -.322, .312) * c;
          float h = atan(y.z, y.y) + radians(hueShift), ch = length(y.yz) * satMul;
          c = mat3(1., 1., 1., .956, -.272, -1.106, .621, -.647, 1.703) * vec3(y.x, ch * cos(h), ch * sin(h));
        }
        c *= color * vLight;
        c = mix(c, fogColor, vFog);
        c = floor(clamp(c, 0., 1.) * 31. + bayer4(gl_FragCoord.xy)) / 31.;
        gl_FragColor = vec4(c, 1.);
      }`,
  });
}

let _white;
function whiteTex() {
  if (!_white) { _white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1); _white.needsUpdate = true; }
  return _white;
}

function canvasTex(w, h, draw, repeat) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.magFilter = t.minFilter = THREE.NearestFilter;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat, repeat); }
  return t;
}
const noiseFill = (base, spread) => (g, w, h) => {
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const n = (Math.random() - 0.5) * spread;
    g.fillStyle = `rgb(${base.map((b) => Math.max(0, Math.min(255, b + n * (0.6 + Math.random() * 0.8)))).join(',')})`;
    g.fillRect(x, y, 1, 1);
  }
};

// ---------------- head rig: face mask + back-of-head hull grown from the mask's boundary ----------------
const pick = (p) => Object.fromEntries(['cranium', 'headDepth', 'earSize', 'hairVolume', 'girth', 'headScale', 'fat', 'clay'].map((k) => [k, p[k]]));

// ---------------- head: photo face mask + sculpted skull + hair shell (own baked atlas) ----------------
export class HeadRig {
  constructor(canon, renderer) {
    this.canon = canon;
    this.group = new THREE.Group();
    this.loop = boundaryLoop(canon.index);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(468 * 3), 3));
    this.geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(468 * 2), 2));
    this.geo.setIndex([...canon.index]);
    this.headMat = ps2Material();
    this.headMat.name = 'face';
    this.head = new THREE.Mesh(this.geo, this.headMat);
    this.group.add(this.head);

    // sculpted skull + hair shell share one small baked atlas
    this.skullMat = ps2Material(); this.skullMat.name = 'head';
    this.hairShellMat = ps2Material(); this.hairShellMat.name = 'hair';
    this.skull = new THREE.Mesh(new THREE.BufferGeometry(), this.skullMat);
    this.hairShell = new THREE.Mesh(new THREE.BufferGeometry(), this.hairShellMat);
    this.group.add(this.skull, this.hairShell);
    this.skinTex = canvasTex(16, 16, () => {}, 1);
    this.hairTex = new THREE.CanvasTexture(document.createElement('canvas'));
    this.hairTex.wrapS = this.hairTex.wrapT = THREE.MirroredRepeatWrapping; // hides the photo patch edges
    this.baker = new BodyBaker(renderer, {
      fragment: HEAD_FRAG,
      uniforms: {
        skinMap: { value: this.skinTex }, hairMap: { value: this.hairTex },
        hairTint: { value: new THREE.Vector3(0, 1, 1) }, hairColor: { value: new THREE.Vector3() }, slick: { value: 0 },
        rimPos: { value: Array.from({ length: 64 }, () => new THREE.Vector3(0, 0, 99)) },
        rimCol: { value: Array.from({ length: 64 }, () => new THREE.Vector3()) },
      },
    });
    // head sculpt runs in its own worker (alongside the body's); results cached by key
    this.worker = new Worker(new URL('./head.worker.js', import.meta.url), { type: 'module' });
    this.cache = new Map();
    this.worker.onmessage = (e) => {
      const job = this.running;
      this.running = null;
      if (job) {
        this.cache.set(job.key, e.data.r);
        while (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value);
        job.resolve();
      }
      this.pump();
    };

    // hat: crown sculpted to fit the head (from the head worker) + a brim or visor sized to it
    this.hatTex = {};
    this.hatMat = ps2Material();
    this.hatMat.name = 'hat';
    this.hatCrown = new THREE.Mesh(new THREE.BufferGeometry(), this.hatMat);
    this.hatBrim = new THREE.Mesh(new THREE.CylinderGeometry(1, 0.98, 0.06, 20), this.hatMat);
    // visor: the front half of a disc (theta measured from +z)
    this.hatVisor = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.05, 16, 1, false, -Math.PI / 2, Math.PI), this.hatMat);
    this.group.add(this.hatCrown, this.hatBrim, this.hatVisor);

    this.hairMat = ps2Material({ map: canvasTex(32, 64, drawHair), alphaTest: 0.5, side: THREE.DoubleSide });
    this.hairMat.name = 'hairStrands';
    this.hair = new THREE.Group();
    this.group.add(this.hair);
  }

  // extra: { hair: analyzeHair(face) result, skin: [r,g,b] face skin tone, atlas: face texture canvas }
  // Returns null when the head is ready, or a promise that resolves once its sculpt is applied
  // (the previous skull stays on screen meanwhile).
  update(P, tex, p, { hair = null, skin = [0.8, 0.6, 0.5], atlas = null } = {}) {
    const uv0 = this.canon.uv;
    const pos = this.geo.attributes.position.array, uv = this.geo.attributes.uv.array;
    for (let i = 0; i < 468; i++) { pos.set(P[i], i * 3); uv.set(uv0[i], i * 2); }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.uv.needsUpdate = true;
    this.geo.computeVertexNormals();
    this.geo.computeBoundingSphere();
    this.geo.computeBoundingBox();
    this.headMat.uniforms.map.value = tex;

    const style = p.hairStyle === 'auto' ? hair?.style || 'short' : p.hairStyle;
    // the skull depends on the face's outline (rim) and overall depth, not its interior: grin, eyes,
    // nose and brow sliders never re-sculpt it. It changes with face size/shape, skull and hair params.
    let front = -Infinity;
    for (const v of P) front = Math.max(front, v[2]);
    const rim = this.loop.map((i) => P[i].map((x) => Math.round(x * 200)));
    const key = JSON.stringify([rim, Math.round(front * 50), [10, 152, 234, 454, 33, 263, 9, 151].map((i) => P[i].map((x) => Math.round(x * 200))),
      p.cranium, p.headDepth, p.earSize, p.hairVolume, p.girth, p.headScale, Math.max(0, p.fat), p.clay, style, p.hat]);
    this.last = { P, p, hair, skin, atlas };
    let pending = null;
    if (key !== this.key) {
      if (this.cache.has(key)) this.apply(key, P);
      else pending = this.request(key, { P, loop: this.loop, index: this.canon.index, p: pick(p), style, hat: p.hat }).then(() => {
        if (this.wanted === key) { this.apply(key, this.last.P); this.finish(); }
      });
      this.wanted = key;
    } else this.wanted = key;
    if (this.key) this.finish();
    return pending;
  }

  // everything that depends on the applied skull: texture, hats, strands
  finish() {
    const { P, p, hair, skin, atlas } = this.last;
    const rim = this.rimColors(P, atlas);
    const hairId = hair ? (hair.canvas._id ||= ++HeadRig.ids) : 0;
    const texKey = JSON.stringify([skin.map((v) => v.toFixed(4)), hairId, p.hairHue, p.hairBright, this.key, rim.sig]);
    if (texKey !== this.texKey) {
      this.texKey = texKey;
      this.paint(hair, skin, p, rim);
    }

    this.buildHair(p.hair === 'stringy');
    if (p.hat !== 'none') {
      this.hatMat.uniforms.map.value = this.hatTexture(p.hat);
      this.hatMat.uniforms.hueShift.value = p.hatHue || 0;
    }
  }

  // one small texture per hat type: felt with a band, knit ribs, cotton, tweed, red fez, starry wizard
  hatTexture(type) {
    if (this.hatTex[type]) return this.hatTex[type];
    const base = { bowler: [30, 26, 24], cowboy: [96, 62, 38], fedora: [72, 68, 62], tophat: [22, 20, 22], beanie: [150, 44, 42],
      cap: [42, 72, 140], flatcap: [96, 86, 70], fez: [150, 26, 32], wizard: [70, 40, 112] }[type] || [30, 26, 24];
    const t = canvasTex(32, 32, (g, w, h) => {
      noiseFill(base, type === 'flatcap' ? 60 : 22)(g, w, h);
      const px = (x, y, c) => { g.fillStyle = `rgb(${c.join(',')})`; g.fillRect(x, y, 1, 1); };
      if (type === 'beanie') for (let y = 0; y < h; y++) for (let x = 0; x < w; x += 2) px(x, y, base.map((v) => v * (y > h - 8 ? 1.15 : 0.72)));
      if (['bowler', 'cowboy', 'fedora', 'tophat'].includes(type)) for (let y = h - 6; y < h - 1; y++) for (let x = 0; x < w; x++) px(x, y, base.map((v) => v * 0.35));
      if (type === 'wizard') for (let n = 0; n < 9; n++) px((n * 11) % w, (n * 7 + 3) % h, [230, 210, 90]);
    });
    t.wrapS = THREE.RepeatWrapping;
    return (this.hatTex[type] = t);
  }

  // only the newest request is kept while sliders move
  request(key, msg) {
    if (this.running?.key === key) return this.running.promise;
    if (this.queued?.key === key) return this.queued.promise;
    this.queued?.resolve();
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    this.queued = { key, msg, resolve, promise };
    this.pump();
    return promise;
  }

  pump() {
    if (this.running || !this.queued) return;
    this.running = this.queued;
    this.queued = null;
    this.worker.postMessage({ id: 0, ...this.running.msg });
  }

  // colors along the face mask's rim (slightly inset), so the skull blends into the photo's edge
  rimColors(P, atlas) {
    const pos = this.loop.map((i) => P[i]);
    if (!atlas) return { pos, col: pos.map(() => [0, 0, 0]), sig: 'none' };
    const g = atlas.getContext('2d', { willReadFrequently: true }), n = atlas.width, uv0 = this.canon.uv, c0 = uv0[1];
    const col = this.loop.map((i) => {
      const u = uv0[i][0] + (c0[0] - uv0[i][0]) * 0.12, v = uv0[i][1] + (c0[1] - uv0[i][1]) * 0.12;
      const d = g.getImageData(Math.min(n - 2, Math.max(0, Math.floor(u * n))), Math.min(n - 2, Math.max(0, Math.floor((1 - v) * n))), 2, 2).data;
      return [0, 1, 2].map((k) => (d[k] + d[4 + k] + d[8 + k] + d[12 + k]) / 1020);
    });
    return { pos, col, sig: col.map((c) => c.map((x) => Math.round(x * 64)).join('.')).join('|') };
  }

  apply(key, P) {
    const r = this.cache.get(key);
    this.key = key;
    this.texKey = null;
    this.dims = r.dims;
    this.slick = r.slick;
    const rigid = (m, layer) => {
      const n = m.positions.length / 3, sw = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) sw[i * 4] = 1;
      return { ...m, layer, skinIndex: new Uint16Array(n * 4), skinWeight: sw };
    };
    const parts = [rigid(r.skull, 3)];
    if (r.hair) parts.push(rigid(r.hair, 4));
    const D = r.dims;
    const axis = { 0: [new THREE.Vector3(0, D.chin - 0.6, D.sideZ - 0.1), new THREE.Vector3(0, D.top + 0.6, D.sideZ - 0.1)] };
    const { geo, groups } = perf.time('head.unwrap', () => unwrap(parts, axis, {}, 256));
    this.bakeGeo = geo;
    for (const m of [this.skull, this.hairShell]) { m.geometry.dispose(); m.geometry = new THREE.BufferGeometry(); }
    for (const gr of groups) (gr.name === 'hair' ? this.hairShell : this.skull).geometry = subset(geo, gr.start, gr.count);
    this.hairShell.visible = !!this.hairShell.geometry.attributes.position; // bald: no shell
    this.skullPts = { positions: r.skull.positions, normals: r.skull.normals };
    // fitted hat: the sculpted crown plus a brim sized to the head at the hat line
    this.hatCrown.geometry.dispose();
    this.hatCrown.geometry = new THREE.BufferGeometry();
    const on = !!r.hat;
    this.hatCrown.visible = on;
    this.hatBrim.visible = on && r.hatFit.brim?.kind === 'round';
    this.hatVisor.visible = on && r.hatFit.brim?.kind === 'visor';
    if (on) {
      const g = this.hatCrown.geometry;
      g.setAttribute('position', new THREE.BufferAttribute(r.hat.positions, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(r.hat.normals, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(r.hat.uv, 2));
      g.setIndex(new THREE.BufferAttribute(r.hat.indices, 1));
      g.computeBoundingBox(); g.computeBoundingSphere();
      const f = r.hatFit, k = f.brim?.scale || 1;
      this.hatBrim.scale.set(f.R * k, 1, f.R * k * 0.95);
      this.hatBrim.position.set(0, f.line0 - 0.005, f.z);
      this.hatBrim.rotation.set(f.tilt, 0, 0);
      // visor: straight edge exactly at the crown's front (measured), sticking forward from there
      this.hatVisor.scale.set(f.R * 0.95, 1, f.R * (0.45 + 0.3 * k));
      this.hatVisor.position.set(0, f.frontY, f.crownFront - 0.01);
      this.hatVisor.rotation.set(f.tilt + 0.18, 0, 0);
    }
  }

  paint(hair, skin, p, rim) {
    fillSkin(this.skinTex.image, skin);
    this.skinTex.needsUpdate = true;
    const u = this.baker.mat.uniforms;
    if (hair) { this.hairTex.image = hair.canvas; this.hairTex.needsUpdate = true; }
    u.hairTint.value.set(p.hairHue, 1, p.hairBright);
    u.hairColor.value.set(...(hair?.color || [0.16, 0.12, 0.09])).multiplyScalar(p.hairBright);
    u.slick.value = this.slick;
    rim.pos.forEach((v, i) => { u.rimPos.value[i].set(...v); u.rimCol.value[i].set(...rim.col[i]); });
    this.headTexture = perf.time('head.paint', () => this.baker.paint(this.bakeGeo, 256));
    this.headCanvas = perf.time('head.readback', () => this.baker.toCanvas(this.headCanvas));
    this.skullMat.uniforms.map.value = this.headTexture;
    this.hairShellMat.uniforms.map.value = this.headTexture;
  }

  // stringy strand cards hanging from the sides and back of the sculpted skull
  buildHair(on) {
    this.hair.clear();
    if (!on || !this.skullPts) return;
    const { positions: P, normals: N } = this.skullPts, D = this.dims;
    const picks = [];
    for (let i = 0; i < P.length / 3; i++) {
      if (P[i * 3 + 1] > D.earY + 0.05 && P[i * 3 + 2] < D.sideZ + 0.05 && N[i * 3 + 1] < 0.7) picks.push(i);
    }
    const step = Math.max(1, Math.floor(picks.length / 26));
    for (let n = 0; n < picks.length; n += step) {
      const i = picks[n];
      const len = 0.55 + (Math.sin(n * 3.7) * 0.5 + 0.5) * 0.45;
      const g = new THREE.PlaneGeometry(0.2, len, 1, 3);
      g.translate(0, -len / 2, 0);
      const m = new THREE.Mesh(g, this.hairMat);
      m.position.set(P[i * 3] + N[i * 3] * 0.03, P[i * 3 + 1] + 0.02, P[i * 3 + 2] + N[i * 3 + 2] * 0.03);
      m.lookAt(m.position.x + N[i * 3], m.position.y, m.position.z + N[i * 3 + 2]);
      m.rotateX(-0.15);
      this.hair.add(m);
    }
  }
}
HeadRig.ids = 0;

function fillSkin(c, [r, g, b]) {
  c.width = c.height = 16;
  const ctx = c.getContext('2d');
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const n = 0.9 + ((Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1 + 1) % 1 * 0.2;
    ctx.fillStyle = `rgb(${[r, g, b].map((v) => Math.min(255, v * n * 255) | 0).join(',')})`;
    ctx.fillRect(x, y, 1, 1);
  }
}

// compact copy of an index range with only the vertices it uses (display attributes only)
function subset(geo, start, count) {
  const idx = geo.index.array.subarray(start, start + count), map = new Map(), out = new THREE.BufferGeometry();
  const keep = ['position', 'normal', 'uv'].map((k) => [k, geo.attributes[k]]), dst = Object.fromEntries(keep.map(([k]) => [k, []]));
  const newIdx = [];
  for (const v of idx) {
    if (!map.has(v)) {
      map.set(v, map.size);
      for (const [k, a] of keep) for (let c = 0; c < a.itemSize; c++) dst[k].push(a.array[v * a.itemSize + c]);
    }
    newIdx.push(map.get(v));
  }
  for (const [k, a] of keep) out.setAttribute(k, new THREE.Float32BufferAttribute(dst[k], a.itemSize));
  out.setIndex(newIdx);
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

const HEAD_FRAG = /* glsl */`
uniform sampler2D skinMap, hairMap;
uniform vec3 hairTint, hairColor; uniform float slick;
uniform vec3 rimPos[64], rimCol[64];
varying vec3 vPos; varying vec3 vNor; varying float vAo; varying float vLayer; varying float vAux;
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
vec3 tri(sampler2D t, vec3 p, vec3 n, float s){
  vec3 w = pow(abs(n), vec3(4.)); w /= (w.x + w.y + w.z);
  return texture2D(t, p.zy * s).rgb * w.x + texture2D(t, p.xz * s).rgb * w.y + texture2D(t, p.xy * s).rgb * w.z;
}
void main(){
  vec3 p = vPos, n = normalize(vNor), c;
  if (vLayer > 3.5) {
    // the person's own hair texture, strands running down from the crown
    c = tri(hairMap, p, n, 2.8);
    if (hairTint.x != 0.) {
      // dye: keep the hair's light/dark pattern but give it the hue (works on black hair too)
      float l = dot(c, vec3(.299, .587, .114));
      vec3 hue = clamp(abs(fract(hairTint.x / 360. + vec3(0., 2. / 3., 1. / 3.)) * 6. - 3.) - 1., 0., 1.);
      c = hue * (.18 + l * 1.4) * hairTint.z;
    } else c *= hairTint.z;
    c *= .72 + .45 * vnoise(vec3(atan(p.z + .1, p.x) * 16., p.y * 2.5, 0.));
    if (slick > .5) c = c * .75 + .35 * pow(max(n.y, 0.), 5.);
    c *= mix(.35, 1., vAo);
  } else {
    // scalp/skull in the face's skin tone, stubble where a buzz cut sits, AO behind the ears
    c = tri(skinMap, p, n, 2.2);
    // near the face, take on the photo's own edge colors so the mask has no pale frame
    float best = 99.; vec3 edge = c;
    for (int i = 0; i < 64; i++) { float d = distance(p, rimPos[i]); if (d < best) { best = d; edge = rimCol[i]; } }
    c = mix(c, edge * (.9 + .2 * hash(floor(p * 40.))), smoothstep(.3, .04, best));
    c = mix(c, hairColor * .7, vAux * (.55 + .45 * hash(floor(p * 70.))) * .75);
    c *= mix(.3, 1., vAo);
  }
  gl_FragColor = vec4(clamp(c, 0., 1.), 1.);
}`;


function drawHair(g, w, h) {
  g.clearRect(0, 0, w, h);
  for (let x = 0; x < w; x++) {
    if (Math.random() < 0.45) continue;
    const end = h * (0.6 + Math.random() * 0.4);
    const v = 25 + Math.random() * 45;
    g.fillStyle = `rgb(${v + 20},${v + 8},${v})`;
    g.fillRect(x, 0, 1, end);
  }
}

function boundaryLoop(index) {
  const count = new Map();
  const key = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);
  for (let t = 0; t < index.length; t += 3)
    for (const [a, b] of [[index[t], index[t + 1]], [index[t + 1], index[t + 2]], [index[t + 2], index[t]]])
      count.set(key(a, b), (count.get(key(a, b)) || 0) + 1);
  const adj = new Map();
  for (const [k, c] of count) {
    if (c !== 1) continue;
    const [a, b] = k.split(',').map(Number);
    (adj.get(a) || adj.set(a, []).get(a)).push(b);
    (adj.get(b) || adj.set(b, []).get(b)).push(a);
  }
  const start = adj.keys().next().value;
  const loop = [start];
  let prev = -1, cur = start;
  for (;;) {
    const nx = adj.get(cur).find((n) => n !== prev && !loop.includes(n));
    if (nx === undefined) break;
    prev = cur; cur = nx; loop.push(cur);
  }
  return loop;
}

// ---------------- environment ----------------
export function buildEnvironment(scene) {
  scene.background = canvasTex(4, 64, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0, '#2f9aa0'); gr.addColorStop(0.55, '#8a7fb0'); gr.addColorStop(1, '#c98a6a');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
  });
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(240, 240, 24, 24),
    ps2Material({ map: canvasTex(32, 32, noiseFill([200, 120, 80], 40), 200) }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = 0;
  scene.add(ground);
  const duneMat = ps2Material({ map: canvasTex(32, 32, noiseFill([190, 110, 90], 60), 6) });
  for (const [x, z, s] of [[-30, -70, 22], [35, -90, 30], [-80, -40, 18]]) {
    const dune = new THREE.Mesh(new THREE.SphereGeometry(s, 10, 6), duneMat);
    dune.scale.set(2, 0.45, 1); dune.position.set(x, -s * 0.12, z);
    scene.add(dune);
  }
}
