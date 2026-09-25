import * as THREE from 'three';
import { LANDMARKS as L, centerOf } from './mutate.js';
import { boundaryLoop, stretchT, rayToPolygon } from './stretch.js';

// Photo -> canonical-UV face texture, then grade + makeup + posterize at game resolution.
export class AtlasBaker {
  constructor(renderer, canon) {
    this.r = renderer;
    this.canon = canon;
    this.rtA = new THREE.WebGLRenderTarget(512, 512);
    this.rtB = null;
    this.cam = new THREE.OrthographicCamera(0, 1, 1, 0, -1, 1);

    this.unwrapGeo = new THREE.BufferGeometry();
    this.unwrapGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(468 * 3), 3));
    this.unwrapGeo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(468 * 2), 2));
    this.unwrapGeo.setIndex(canon.index);
    // edge: each vertex's distance to the face outline (canonical UV, in face widths), carried into the
    // alpha channel so the grade pass can feather the photo out toward the skin tone (see FEATHER)
    this.unwrapGeo.setAttribute('edge', new THREE.BufferAttribute(outlineDistance(canon), 1));
    this.unwrapMat = new THREE.ShaderMaterial({
      uniforms: { map: { value: null } }, side: THREE.DoubleSide,
      vertexShader: /* glsl */`attribute float edge; varying vec2 vUv; varying float vEdge;
        void main(){ vUv = uv; vEdge = edge; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
      fragmentShader: /* glsl */`uniform sampler2D map; varying vec2 vUv; varying float vEdge;
        void main(){ gl_FragColor = vec4(texture2D(map, vUv).rgb, vEdge); }`,
    });
    this.unwrapScene = new THREE.Scene();
    // edge padding: copies of the face 1-2% larger underneath, so the outline texels are face, not the
    // flat background (a dotted outline otherwise); small enough to never show ghost features
    const cu = canon.uv.reduce((a, u) => [a[0] + u[0] / canon.uv.length, a[1] + u[1] / canon.uv.length], [0, 0]);
    for (const sc of [1.02, 1.01, 1]) {
      const m = new THREE.Mesh(this.unwrapGeo, this.unwrapMat);
      m.scale.set(sc, sc, 1); m.position.set(cu[0] * (1 - sc), cu[1] * (1 - sc), (sc - 1) * -5);
      this.unwrapScene.add(m);
    }
    // Outside the drawn face: the flat skin tone (the clear color), like the original atlas. (Radially
    // stretched edge skin there read as glitchy streaks, enlarged face copies as ghost features.)
    this.loop = boundaryLoop(canon.index);

    this.gradeMat = new THREE.ShaderMaterial({
      uniforms: {
        src: { value: this.rtA.texture }, outRes: { value: 128 },
        hue: { value: 0 }, sat: { value: 1 }, contrast: { value: 1 }, bright: { value: 0 }, pale: { value: 0 },
        shadowTint: { value: new THREE.Vector3(1, 1, 1) }, highTint: { value: new THREE.Vector3(1, 1, 1) },
        sharpen: { value: 0 }, grime: { value: 0 }, levels: { value: 32 },
        eyeL: { value: new THREE.Vector2() }, eyeR: { value: new THREE.Vector2() }, mouthC: { value: new THREE.Vector2() },
        noseC: { value: new THREE.Vector2() }, cheekL: { value: new THREE.Vector2() }, cheekR: { value: new THREE.Vector2() },
        faceW: { value: 0.8 }, cornerL: { value: new THREE.Vector2() }, cornerR: { value: new THREE.Vector2() }, teeth: { value: 0 }, upLip: { value: new THREE.Vector2() }, loLip: { value: new THREE.Vector2() }, socket: { value: 0 }, eyeVoid: { value: 0 }, lips: { value: 0 }, noseRed: { value: 0 }, flush: { value: 0 },
        feather: { value: 0 }, featherTone: { value: new THREE.Vector3(0.8, 0.6, 0.5) },
      },
      vertexShader: /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }`,
      fragmentShader: GRADE_FRAG,
      depthTest: false,
    });
    this.quadScene = new THREE.Scene();
    this.quadScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.gradeMat));
  }

  bake(face, uvW, p, res) {
    this.boundary ??= new Set(boundaryVerts(this.canon.index));
    const fc = centerOf(face.lm, [1, 6, 9, 168]);
    const pos = this.unwrapGeo.attributes.position.array;
    const uv = this.unwrapGeo.attributes.uv.array;
    // headStretch: the photo's outer skin stretched outward (see stretch.js), measured in the photo
    const poly = p.headStretch ? this.loop.map((i) => [face.lm[i][0], face.lm[i][1]]) : null;
    for (let i = 0; i < 468; i++) {
      pos[i * 3] = uvW[i][0]; pos[i * 3 + 1] = uvW[i][1]; pos[i * 3 + 2] = 0;
      if (poly) {
        const dx = face.lm[i][0] - fc[0], dy = face.lm[i][1] - fc[1], r = Math.hypot(dx, dy), R = r > 1e-6 ? rayToPolygon(fc, [dx / r, dy / r], poly) : 1;
        const k = R > 0 && r > 1e-6 ? (stretchT(Math.min(1, r / R)) * R) / r : 1;
        uv[i * 2] = fc[0] + dx * k; uv[i * 2 + 1] = 1 - (fc[1] + dy * k);
        continue;
      }
      // the outline samples the photo inside its edge: the canonical outline runs along the hairline and
      // the jaw, where the photo has hair, background and the shadow under the jaw. It takes the first real
      // skin inward (see skinInset): a fixed nudge left the jaw's shadow as a black band under the chin.
      const inset = this.boundary.has(i) ? skinInset(face, i, fc) : 0;
      const sx = face.lm[i][0] + (fc[0] - face.lm[i][0]) * inset, sy = face.lm[i][1] + (fc[1] - face.lm[i][1]) * inset;
      uv[i * 2] = sx; uv[i * 2 + 1] = 1 - sy;
    }
    this.unwrapGeo.attributes.position.needsUpdate = true;
    this.unwrapGeo.attributes.uv.needsUpdate = true;

    this.unwrapMat.uniforms.map.value = face.tex;

    if (!this.rtB || this.rtB.width !== res) {
      this.rtB?.dispose();
      this.rtB = new THREE.WebGLRenderTarget(res, res, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    }
    const u = this.gradeMat.uniforms;
    u.outRes.value = res;
    for (const k of ['hue', 'sat', 'contrast', 'bright', 'pale', 'sharpen', 'grime', 'levels', 'socket', 'eyeVoid', 'lips', 'noseRed', 'flush', 'teeth']) u[k].value = p[k];
    u.shadowTint.value.copy(tint(p.shadowHue, p.shadowAmt));
    u.highTint.value.copy(tint(p.highHue, p.highAmt));
    const set = (name, idx) => u[name].value.fromArray(centerOf(uvW, idx));
    set('eyeL', L.eyeL); set('eyeR', L.eyeR); set('mouthC', L.mouth); set('noseC', L.nose);
    set('cheekL', L.cheekL); set('cheekR', L.cheekR);
    set('cornerL', L.mouthL); set('cornerR', L.mouthR); set('upLip', 0); set('loLip', 17);
    u.faceW.value = Math.hypot(uvW[L.sideR][0] - uvW[L.sideL][0], uvW[L.sideR][1] - uvW[L.sideL][1]);

    const r = this.r;
    const prevClear = r.getClearColor(new THREE.Color()), prevAlpha = r.getClearAlpha();
    r.setClearColor(new THREE.Color(...face.skin), 1);
    r.setRenderTarget(this.rtA); r.clear(); r.render(this.unwrapScene, this.cam);
    // skin tone first (makeup off, no feather), then the atlas feathered out toward it
    this.tone = this.readTone(uvW, res);
    u.feather.value = 0; u.featherTone.value.fromArray(this.tone); // (the face texture stays whole: the head carries it on)
    r.setRenderTarget(this.rtB); r.clear(); r.render(this.quadScene, this.cam);
    this.photoTex = this.gradePhoto(face); // (the head projects it onto its band)
    this.photoCenter = fc; // (photo space, for the head's stretch)
    r.setRenderTarget(null);
    r.setClearColor(prevClear, prevAlpha);
    return this.rtB.texture;
  }

  // The whole photo through the same grade (no makeup, no feather): the head projects it onto the skull.
  gradePhoto(face) {
    const u = this.gradeMat.uniforms, keep = {}, src = u.src.value;
    for (const k of MAKEUP) { keep[k] = u[k].value; u[k].value = 0; }
    u.feather.value = 0; u.src.value = face.tex;
    if (!this.rtP) this.rtP = new THREE.WebGLRenderTarget(512, 512, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.r.setRenderTarget(this.rtP); this.r.render(this.quadScene, this.cam); this.r.setRenderTarget(null);
    for (const k of MAKEUP) u[k].value = keep[k];
    u.src.value = src;
    this.photoPixels ??= new Uint8Array(512 * 512 * 4);
    this.r.readRenderTargetPixels(this.rtP, 0, 0, 512, 512, this.photoPixels); // (rows v-up, like the texture)
    return this.rtP.texture;
  }

  // The skin tone the body, skull and the face's feathered border wear (computed by bake()).
  skinTone() { return this.tone; }

  // The graded texture without makeup (cheek flush sits right on the cheeks, lips and nose red nearby:
  // sampled with them, the neck and hands came out pinker than the face) and without the feather.
  readTone(uvW, n) {
    const u = this.gradeMat.uniforms, keep = {};
    for (const k of MAKEUP) { keep[k] = u[k].value; u[k].value = 0; }
    u.feather.value = 0;
    if (!this.rtS || this.rtS.width !== n) {
      this.rtS?.dispose();
      this.rtS = new THREE.WebGLRenderTarget(n, n, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    }
    this.r.setRenderTarget(this.rtS); this.r.render(this.quadScene, this.cam); this.r.setRenderTarget(null);
    for (const k of MAKEUP) u[k].value = keep[k];
    const buf = new Uint8Array(36);
    const cl = (x) => Math.max(0, Math.min(n - 3, Math.floor(x) - 1));
    const px = SKIN_POINTS.map((i) => {
      this.r.readRenderTargetPixels(this.rtS, cl(uvW[i][0] * n), cl(uvW[i][1] * n), 3, 3, buf);
      const c = [0, 0, 0];
      for (let k = 0; k < 36; k += 4) { c[0] += buf[k]; c[1] += buf[k + 1]; c[2] += buf[k + 2]; }
      return c.map((v) => v / 9 / 255);
    });
    return medianSkin(px);
  }

  // Current atlas as a top-down canvas (for preview/export).
  toCanvas(canvas) {
    const n = this.rtB.width, buf = new Uint8Array(n * n * 4);
    this.r.readRenderTargetPixels(this.rtB, 0, 0, n, n, buf);
    canvas.width = canvas.height = n;
    const g = canvas.getContext('2d'), img = g.createImageData(n, n);
    for (let y = 0; y < n; y++) img.data.set(buf.subarray((n - 1 - y) * n * 4, (n - y) * n * 4), y * n * 4);
    g.putImageData(img, 0, 0);
    return canvas;
  }
}

// Robust skin tone (see AtlasBaker.skinTone): median of several skin landmarks, so hair or brows at
// any single point can't turn the body's skin black.
const MAKEUP = ['socket', 'eyeVoid', 'lips', 'noseRed', 'flush', 'teeth'];
const FEATHER = 0.16; // how far in from the outline the photo fades into the skin tone (face widths)

// each canonical vertex's distance to the face outline in canonical UV, in face widths (0 on the outline)
function outlineDistance(canon) {
  const count = new Map(), key = (a, b) => (a < b ? a * 1000 + b : b * 1000 + a), I = canon.index, U = canon.uv;
  for (let t = 0; t < I.length; t += 3) for (let e = 0; e < 3; e++) { const k = key(I[t + e], I[t + (e + 1) % 3]); count.set(k, (count.get(k) || 0) + 1); }
  const segs = [...count].filter(([, c]) => c === 1).map(([k]) => [U[Math.floor(k / 1000)], U[k % 1000]]);
  const width = Math.hypot(U[L.sideR][0] - U[L.sideL][0], U[L.sideR][1] - U[L.sideL][1]);
  return new Float32Array(U.map((p) => {
    let d = Infinity;
    for (const [a, b] of segs) {
      const ex = b[0] - a[0], ey = b[1] - a[1], t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / (ex * ex + ey * ey)));
      d = Math.min(d, Math.hypot(p[0] - a[0] - ex * t, p[1] - a[1] - ey * t));
    }
    return Math.min(1, d / width);
  }));
}
const SKIN_POINTS = [50, 280, 205, 425, 151, 9, 199, 36, 266];
// how far toward the face center (fraction of the way) outline vertex i must sample the photo to land on
// skin: from 0.06 in, the first step at least EDGE_SKIN as bright as the face's skin and staying so for
// two more steps (raw photo against the raw skin sample; cached per face and vertex)
const EDGE_SKIN = 0.6;
function skinInset(face, i, fc) {
  face.insets ??= new Map();
  if (face.insets.has(i)) return face.insets.get(i);
  if (!face.pix) {
    const w = 256, h = Math.max(1, Math.round((256 * face.img.naturalHeight) / face.img.naturalWidth));
    const c = Object.assign(document.createElement('canvas'), { width: w, height: h }), g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(face.img, 0, 0, w, h);
    face.pix = { w, h, d: g.getImageData(0, 0, w, h).data };
  }
  const { w, h, d } = face.pix, lm = face.lm[i], sk = face.skin, skinLum = 0.299 * sk[0] + 0.587 * sk[1] + 0.114 * sk[2];
  const lum = (t) => {
    const x = lm[0] + (fc[0] - lm[0]) * t, y = lm[1] + (fc[1] - lm[1]) * t;
    let s = 0, n = 0;
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const px = Math.min(w - 1, Math.max(0, Math.floor(x * w) + ox)), py = Math.min(h - 1, Math.max(0, Math.floor(y * h) + oy)), o = (py * w + px) * 4;
      s += 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2]; n++;
    }
    return s / n / 255;
  };
  let t = 0.06;
  for (; t < 0.35; t += 0.02) if ([t, t + 0.02, t + 0.04].every((q) => lum(q) >= EDGE_SKIN * skinLum)) break;
  t = Math.min(t, 0.35);
  face.insets.set(i, t);
  return t;
}

function medianSkin(px) {
  const lum = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  const mid = px.slice().sort((a, b) => lum(a) - lum(b)).slice(2, 7);
  return [0, 1, 2].map((k) => mid.reduce((s, c) => s + c[k], 0) / mid.length);
}

function boundaryVerts(index) {
  const count = new Map(), key = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);
  for (let t = 0; t < index.length; t += 3)
    for (const [a, b] of [[index[t], index[t + 1]], [index[t + 1], index[t + 2]], [index[t + 2], index[t]]])
      count.set(key(a, b), (count.get(key(a, b)) || 0) + 1);
  return [...count].filter(([, c]) => c === 1).flatMap(([k]) => k.split(',').map(Number));
}

function tint(hueDeg, amt) {
  const c = new THREE.Color().setHSL(((hueDeg % 360) + 360) % 360 / 360, 0.7, 0.5);
  const lum = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
  const v = new THREE.Vector3(c.r / lum, c.g / lum, c.b / lum);
  return new THREE.Vector3(1, 1, 1).lerp(v, amt);
}

const GRADE_FRAG = /* glsl */`
uniform sampler2D src; uniform float outRes;
uniform float hue, sat, contrast, bright, pale, sharpen, grime, levels;
uniform vec3 shadowTint, highTint;
uniform vec2 eyeL, eyeR, mouthC, noseC, cheekL, cheekR;
uniform float faceW, socket, eyeVoid, lips, noseRed, flush, teeth, feather;
uniform vec3 featherTone;
uniform vec2 cornerL, cornerR, upLip, loLip;
varying vec2 vUv;

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.-2.*f);
  return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y); }
float bayer2(vec2 a){ a = floor(a); return fract(a.x / 2. + a.y * a.y * .75); }
float bayer4(vec2 a){ return bayer2(.5 * a) * .25 + bayer2(a); }
float blob(vec2 c, float r){ vec2 d = (vUv - c) / (r * faceW); return exp(-dot(d, d)); }

vec3 hueRotate(vec3 c, float deg){
  float a = radians(deg);
  mat3 toYIQ = mat3(.299, .596, .211, .587, -.274, -.523, .114, -.322, .312);
  mat3 toRGB = mat3(1., 1., 1., .956, -.272, -1.106, .621, -.647, 1.703);
  vec3 y = toYIQ * c; float h = atan(y.z, y.y) + a, ch = length(y.yz);
  return toRGB * vec3(y.x, ch * cos(h), ch * sin(h));
}

void main(){
  float px = 1. / outRes;
  vec3 c = texture2D(src, vUv).rgb;
  vec3 blur = (texture2D(src, vUv + vec2(px, 0)).rgb + texture2D(src, vUv - vec2(px, 0)).rgb
             + texture2D(src, vUv + vec2(0, px)).rgb + texture2D(src, vUv - vec2(0, px)).rgb) * .25;
  c = c + sharpen * (c - blur);

  float l = dot(c, vec3(.299, .587, .114));
  c = mix(c, vec3(l * 1.15 + .12), pale);
  c = hueRotate(c, hue);
  l = dot(c, vec3(.299, .587, .114));
  c = mix(vec3(l), c, sat);
  c = (c - .5) * contrast + .5 + bright;
  l = clamp(dot(c, vec3(.299, .587, .114)), 0., 1.);
  c *= mix(shadowTint, vec3(1), l) * mix(vec3(1), highTint, l);

  // makeup, positioned on the (warped) canonical landmarks
  float eyes = blob(eyeL, .11) + blob(eyeR, .11);
  c = mix(c, c * vec3(.35, .25, .42), clamp(socket * eyes, 0., 1.));
  float voidM = blob(eyeL, .05) + blob(eyeR, .05);
  c = mix(c, vec3(.02, .01, .02), clamp(eyeVoid * voidM * 1.6, 0., 1.));
  c = mix(c, c * vec3(1.5, .55, .6), clamp(lips * blob(mouthC, .12), 0., 1.));
  c = mix(c, vec3(.6, .12, .22) * (.6 + l), clamp(noseRed * blob(noseC, .08), 0., 1.));
  c = mix(c, c * vec3(1.35, .75, .8), clamp(flush * (blob(cheekL, .12) + blob(cheekR, .12)), 0., 1.));

  // painted grin: a band of yellowed teeth between the (warped) mouth corners
  if (teeth > 0.) {
    vec2 ax = cornerR - cornerL; float w = length(ax); vec2 dir = ax / w; vec2 nrm = vec2(-dir.y, dir.x);
    vec2 mid = (cornerL + cornerR) * .5 + nrm * dot((upLip + loLip) * .5 - (cornerL + cornerR) * .5, nrm);
    vec2 d = vUv - mid; float s = dot(d, dir) / (w * .5); float t = dot(d, nrm);
    float h = teeth * .018 * faceW * (1. - s * s) + .002;
    float smile = .012 * faceW * s * s * teeth;   // corners curl up
    float tt = (t - smile) / h;
    if (abs(s) < 1. && abs(tt) < 1.) {
      float gap = smoothstep(.75, 1., abs(sin(s * 3.14159 * 5. * teeth + .5)));
      vec3 tooth = vec3(.86, .8, .56) * (1. - .35 * abs(tt)) * (1. - .55 * gap);
      tooth = mix(tooth, vec3(.25, .05, .07), smoothstep(.1, .0, abs(tt)) * .8);
      tooth = mix(tooth, vec3(.1, .03, .04), smoothstep(.75, 1., abs(s)));
      c = mix(c, tooth, smoothstep(1., .85, abs(tt)));
    }
  }

  float n = vnoise(vUv * 48.) * .6 + vnoise(vUv * 150.) * .4;
  c *= 1. - grime * (n * .6);

  // the photo fades out into the skin tone over its outer rim, so the face melts into the head
  // (the skull wears this same tone) instead of ending in a hard-edged photo on a head
  if (feather > 0.) c = mix(featherTone, c, smoothstep(0., feather, texture2D(src, vUv).a));

  c = floor(clamp(c, 0., 1.) * levels + bayer4(gl_FragCoord.xy)) / levels;
  gl_FragColor = vec4(c, 1.);
}`;
