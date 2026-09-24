import * as THREE from 'three';
import { LANDMARKS as L, centerOf } from './mutate.js';

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
    this.unwrapMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    this.unwrapScene = new THREE.Scene();
    // dilation: a slightly enlarged copy drawn underneath so edge texels never sample the clear color
    const cu = canon.uv.reduce((a, u) => [a[0] + u[0] / canon.uv.length, a[1] + u[1] / canon.uv.length], [0, 0]);
    for (const s of [1.06, 1.03, 1]) {
      const m = new THREE.Mesh(this.unwrapGeo, this.unwrapMat);
      m.scale.set(s, s, 1);
      m.position.set(cu[0] * (1 - s), cu[1] * (1 - s), (s - 1) * -5);
      this.unwrapScene.add(m);
    }

    this.gradeMat = new THREE.ShaderMaterial({
      uniforms: {
        src: { value: this.rtA.texture }, outRes: { value: 128 },
        hue: { value: 0 }, sat: { value: 1 }, contrast: { value: 1 }, bright: { value: 0 }, pale: { value: 0 },
        shadowTint: { value: new THREE.Vector3(1, 1, 1) }, highTint: { value: new THREE.Vector3(1, 1, 1) },
        sharpen: { value: 0 }, grime: { value: 0 }, levels: { value: 32 },
        eyeL: { value: new THREE.Vector2() }, eyeR: { value: new THREE.Vector2() }, mouthC: { value: new THREE.Vector2() },
        noseC: { value: new THREE.Vector2() }, cheekL: { value: new THREE.Vector2() }, cheekR: { value: new THREE.Vector2() },
        faceW: { value: 0.8 }, cornerL: { value: new THREE.Vector2() }, cornerR: { value: new THREE.Vector2() }, teeth: { value: 0 }, upLip: { value: new THREE.Vector2() }, loLip: { value: new THREE.Vector2() }, socket: { value: 0 }, eyeVoid: { value: 0 }, lips: { value: 0 }, noseRed: { value: 0 }, flush: { value: 0 },
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
    for (let i = 0; i < 468; i++) {
      pos[i * 3] = uvW[i][0]; pos[i * 3 + 1] = uvW[i][1]; pos[i * 3 + 2] = 0;
      const inset = this.boundary.has(i) ? 0.06 : 0;
      const sx = face.lm[i][0] + (fc[0] - face.lm[i][0]) * inset, sy = face.lm[i][1] + (fc[1] - face.lm[i][1]) * inset;
      uv[i * 2] = sx; uv[i * 2 + 1] = 1 - sy;
    }
    this.unwrapGeo.attributes.position.needsUpdate = true;
    this.unwrapGeo.attributes.uv.needsUpdate = true;
    this.unwrapMat.map = face.tex;
    this.unwrapMat.needsUpdate = true;

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
    r.setRenderTarget(this.rtB); r.clear(); r.render(this.quadScene, this.cam);
    r.setRenderTarget(null);
    r.setClearColor(prevClear, prevAlpha);
    return this.rtB.texture;
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

// Robust skin tone from the finished (graded) texture: median of several skin landmarks, so hair,
// brows or painted makeup at any single point can't turn the body's skin black.
export function skinColor(canvas, uvW) {
  const g = canvas.getContext('2d', { willReadFrequently: true }), n = canvas.width;
  const cl = (x) => Math.max(0, Math.min(n - 3, Math.floor(x) - 1));
  const px = [50, 280, 205, 425, 151, 9, 199, 36, 266].map((i) => {
    const d = g.getImageData(cl(uvW[i][0] * n), cl((1 - uvW[i][1]) * n), 3, 3).data;
    const c = [0, 0, 0];
    for (let k = 0; k < d.length; k += 4) { c[0] += d[k]; c[1] += d[k + 1]; c[2] += d[k + 2]; }
    return c.map((v) => v / 9 / 255);
  });
  const lum = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  const mid = px.sort((a, b) => lum(a) - lum(b)).slice(2, 7);
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
uniform float faceW, socket, eyeVoid, lips, noseRed, flush, teeth;
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

  c = floor(clamp(c, 0., 1.) * levels + bayer4(gl_FragCoord.xy)) / levels;
  gl_FragColor = vec4(c, 1.);
}`;
