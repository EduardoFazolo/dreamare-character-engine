import * as THREE from 'three';
import { sculptHead } from './headsculpt.js';

import { perf } from './perf.js';
import { unwrap, BodyBaker } from './bodybake.js';
import { paintSkinTile } from './skintile.js';
import { boundaryLoop } from './outline.js';
import { buildFaceRig, drawMouth, drawEye, hueShift, MORPHS, alignToTexture } from './faceanim.js';

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
      #include <morphtarget_pars_vertex>
      #include <skinning_pars_vertex>
      uniform vec2 snapRes; uniform float fogNear, fogFar;
      varying vec3 vUvw; varying vec2 vUvP; varying vec3 vLight; varying float vFog;
      void main(){
        #include <morphinstance_vertex>
        #include <skinbase_vertex>
        #include <beginnormal_vertex>
        #include <morphnormal_vertex>
        #include <skinnormal_vertex>
        #include <begin_vertex>
        #include <morphtarget_vertex>
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

// ---------------- head: photo face + hull grown from its outline (one mesh) + hair shell and hats ----------------
export class HeadRig {
  constructor(canon, renderer) {
    this.canon = canon;
    this.group = new THREE.Group();
    this.loop = boundaryLoop(canon.index);
    // the head: the face's 468 points plus the hull grown from its outline (one mesh, see buildHead)
    this.geo = new THREE.BufferGeometry();
    this.headMat = ps2Material();
    this.headMat.name = 'face';
    this.head = new THREE.Mesh(this.geo, this.headMat);
    this.group.add(this.head);
    // mouth interior (cavity + teeth) behind the cut lips, see faceanim.js
    this.mouthMat = ps2Material({ map: canvasTex(64, 64, drawMouth), side: THREE.DoubleSide }); // (seen from inside)
    this.mouthMat.name = 'mouth';
    this.mouth = new THREE.Mesh(new THREE.BufferGeometry(), this.mouthMat);
    this.group.add(this.mouth);
    // generated eyeballs (faceanim.js drawEye), colored after the photo's eyes
    this.eyeTex = canvasTex(256, 128, (g, w, h) => { drawEye(g, 0, h); drawEye(g, h, h); }); // right eye | left eye
    this.eyeMat = ps2Material({ map: this.eyeTex });
    this.eyeMat.name = 'eye';
    this.eyes = new THREE.Mesh(new THREE.BufferGeometry(), this.eyeMat);
    this.group.add(this.eyes);

    // hair shell (and the hidden sculpted skull, which only shapes hair and hats) share one small baked atlas
    this.skullMat = ps2Material(); this.skullMat.name = 'head';
    this.hairShellMat = ps2Material(); this.hairShellMat.name = 'hair';
    this.skull = new THREE.Mesh(new THREE.BufferGeometry(), this.skullMat);
    this.hairShell = new THREE.Mesh(new THREE.BufferGeometry(), this.hairShellMat);
    this.group.add(this.skull, this.hairShell);
    this.skinTex = canvasTex(64, 64, () => {}, 1);
    this.hairTex = new THREE.CanvasTexture(document.createElement('canvas'));
    this.hairTex.wrapS = this.hairTex.wrapT = THREE.MirroredRepeatWrapping; // hides the photo patch edges
    this.baker = new BodyBaker(renderer, {
      fragment: HEAD_FRAG,
      uniforms: {
        skinMap: { value: this.skinTex }, hairMap: { value: this.hairTex },
        hairTint: { value: new THREE.Vector3(0, 1, 1) }, hairColor: { value: new THREE.Vector3() }, slick: { value: 0 },
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

  // extra: { hair: analyzeHair(face) result, skin: [r,g,b] face skin tone, uvW: the warped face UVs }
  // Returns null when the head is ready, or a promise that resolves once its sculpt is applied.
  update(P, tex, p, { hair = null, skin = [0.8, 0.6, 0.5], uvW = null, atlas = null } = {}) {
    this.headMat.uniforms.map.value = tex;
    this.last = { P, p, hair, skin, uvW, atlas };
    // the head mesh depends only on the face, its texture warp and the head shape: body, outfit, pose...
    // changes skip the rebuild (only the eye colors/traits are re-checked)
    let hk = 0;
    for (const v of P) for (const c of v) hk = (Math.imul(hk, 31) + Math.round(c * 1e4)) | 0;
    if (uvW) for (const v of uvW) for (const c of v) hk = (Math.imul(hk, 31) + Math.round(c * 1e4)) | 0;
    const headKey = `${hk}|${p.headDepth}|${p.cranium}`;
    if (headKey !== this.headKey) { this.headKey = headKey; this.buildHead(P, p); }
    else if (this.eyeRegions) this.paintEyes(this.eyeRegions, p);

    const style = p.hairStyle === 'auto' ? hair?.style || 'short' : p.hairStyle;
    // the sculpted skull only shapes the hair shell and hats: it depends on the face's outline and overall
    // depth, not its interior (grin, eyes, nose sliders never re-sculpt), plus skull and hair params
    let front = -Infinity;
    for (const v of P) front = Math.max(front, v[2]);
    const rim = this.loop.map((i) => P[i].map((x) => Math.round(x * 200)));
    const key = JSON.stringify([rim, Math.round(front * 50), [10, 152, 234, 454, 33, 263, 9, 151].map((i) => P[i].map((x) => Math.round(x * 200))),
      p.cranium, p.headDepth, p.earSize, p.hairVolume, p.girth, p.headScale, Math.max(0, p.fat), p.clay, style, p.hat]);
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
    const { p, hair, skin } = this.last;
    const hairId = hair ? (hair.canvas._id ||= ++HeadRig.ids) : 0;
    const texKey = JSON.stringify([skin.map((v) => v.toFixed(4)), hairId, p.hairHue, p.hairBright, this.key]);
    if (texKey !== this.texKey) {
      this.texKey = texKey;
      this.paint(hair, skin, p);
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

  // The head: a hull grown from the face's own outline (as in the original b18118e), CLASSIC_K rings
  // shrinking back toward one pole behind the head (slight bulge, cranium lift, head depth), so the head
  // continues the face's contour and the face covers most of what's seen. One mesh with the face.
  // Texture: only the face's own photo texture. Past the outline the UVs mirror back INTO the face at 1:1
  // scale (by the 3D arc length travelled over the hull), bouncing between the outline point and a
  // feature-free skin anchor, so the whole head wears the person's real skin with no stretch streaks
  // (smearing texture outward always streaked on the sides), and never a mirrored eye or mouth.
  buildHead(P, p) {
    const L = this.loop.length, K = CLASSIC_K, n = 468 + L * (K - 1) + 1;
    const C = [0, (P[10][1] + P[152][1]) / 2 + 0.05, (P[234][2] + P[454][2]) / 2 - 0.08];
    const depth = 0.62 * (1 + p.headDepth * 0.6), cranium = 0.4 + p.cranium * 0.45;
    const pos = new Float32Array(n * 3), uv = new Float32Array(n * 2), uv0 = this.canon.uv;
    // mouth and eye rims moved to where the texture draws them (faceanim.js alignToTexture)
    const al = perf.time('head.align', () => alignToTexture(P, uv0, this.last?.uvW || uv0, this.canon.index, this.loop));
    for (let i = 0; i < 468; i++) { pos.set(al.P[i], i * 3); uv.set(al.uv[i], i * 2); }
    const A = this.last?.uvW || uv0, c0 = [0.5, 0.5], ang = (q) => Math.atan2(q[1] - c0[1], q[0] - c0[0]);
    const target = (v) => { const th = ang(uv0[v]); let wx = 0, wy = 0, ws = 0;
      for (const a of SKIN_ANCHORS) { let d = Math.abs(ang(uv0[a]) - th); d = Math.min(d, 2 * Math.PI - d); const w = Math.exp(-(d * d) / 0.18); wx += A[a][0] * w; wy += A[a][1] * w; ws += w; }
      return [wx / ws, wy / ws]; };
    // texture units per head unit on the face (face width in UV / in 3D), for the 1:1 mirror
    const uvPerUnit = Math.hypot(uv0[454][0] - uv0[234][0], uv0[454][1] - uv0[234][1]) / (Math.hypot(P[454][0] - P[234][0], P[454][1] - P[234][1]) || 1);
    const arc = new Float32Array(L);
    for (let k = 1; k < K; k++) {
      const th = (k / K) * Math.PI / 2;
      for (let i = 0; i < L; i++) {
        const b = P[this.loop[i]], rx = b[0] - C[0], ry = b[1] - C[1], rz = b[2] - C[2];
        const m = Math.hypot(rx, ry) || 1e-6, dx = rx / m, dy = ry / m;
        const radial = m * Math.pow(Math.cos(th), 0.6) * (1 + 0.28 * Math.sin(2 * th));
        const lift = cranium * Math.sin(th) * Math.pow(Math.max(0, dy), 2) * m;
        const o = 468 + (k - 1) * L + i;
        pos.set([C[0] + dx * radial, C[1] + dy * radial + lift, C[2] + rz * Math.cos(th) - depth * Math.sin(th)], o * 3);
        const t = target(this.loop[i]), r0 = uv0[this.loop[i]];
        // mirror padding (see above): ping-pong along the rim -> anchor line
        const prev = k === 1 ? P[this.loop[i]] : [pos[(o - L) * 3], pos[(o - L) * 3 + 1], pos[(o - L) * 3 + 2]], q = [pos[o * 3], pos[o * 3 + 1], pos[o * 3 + 2]];
        arc[i] = (k === 1 ? 0 : arc[i]) + Math.hypot(q[0] - prev[0], q[1] - prev[1], q[2] - prev[2]);
        const span = Math.hypot(t[0] - r0[0], t[1] - r0[1]) || 1e-6, d = (arc[i] * uvPerUnit) / span;
        const f = d % 2, w = f < 1 ? f : 2 - f; // ping-pong 0..1..0
        uv[o * 2] = r0[0] + (t[0] - r0[0]) * w; uv[o * 2 + 1] = r0[1] + (t[1] - r0[1]) * w;
      }
    }
    const pole = n - 1;
    pos.set([C[0], C[1] + cranium * 0.2, C[2] - depth], pole * 3);
    uv.set(A[151], pole * 2);
    const ring = (k, i) => (k === 0 ? this.loop[i % L] : 468 + (k - 1) * L + (i % L));
    const idx = [...this.canon.index], hullStart = idx.length;
    for (let k = 0; k < K; k++) for (let i = 0; i < L; i++) {
      const a = ring(k, i), b = ring(k, i + 1), cc = ring(k + 1, i), d = ring(k + 1, i + 1);
      if (k === K - 1) idx.push(a, b, pole); else idx.push(a, b, d, a, d, cc);
    }
    // hull faces away from the head center
    const v = (q) => [pos[q * 3], pos[q * 3 + 1], pos[q * 3 + 2]], t0 = hullStart + L * 6;
    const [a0, b0, c1] = [v(idx[t0]), v(idx[t0 + 1]), v(idx[t0 + 2])];
    const u = b0.map((x, q) => x - a0[q]), w = c1.map((x, q) => x - a0[q]);
    const nn = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    if (nn[0] * (a0[0] - C[0]) + nn[1] * (a0[1] - C[1]) + nn[2] * (a0[2] - C[2]) < 0) for (let q = hullStart; q < idx.length; q += 3) { const x = idx[q + 1]; idx[q + 1] = idx[q + 2]; idx[q + 2] = x; }
    // face rig: mouth and eyes cut open, eyeballs appended, mouth interior, morph targets (faceanim.js)
    const rig = perf.time('head.faceRig', () => buildFaceRig(al.P, al.uv, this.canon.index, pos));
    const faceTris = this.canon.index.length / 3, keep = [];
    for (let t = 0; t < idx.length / 3; t++) if (t >= faceTris || !rig.cut.has(t)) keep.push(idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]);
    keep.push(...rig.extra.idx);
    const allPos = new Float32Array(pos.length + rig.extra.pos.length), allUV = new Float32Array(uv.length + rig.extra.uv.length);
    allPos.set(pos); allPos.set(rig.extra.pos, pos.length); allUV.set(uv); allUV.set(rig.extra.uv, uv.length);
    // the eyes stay inside the head: eyeball and socket vertices outside the face + hull surface (a warp
    // pushing an eye to the face's edge made them poke out past the head's silhouette) are pulled back in
    perf.time('head.inside', () => {
      const surf = keep.slice(0, keep.length - rig.extra.idx.length), eyePos = new Float32Array(rig.eyes.pos);
      const s0 = pos.length / 3 + rig.socketRange[0], s1 = pos.length / 3 + rig.socketRange[1], sm = (s0 + s1) >> 1, em = eyePos.length / 6;
      keepInside(allPos, s0, sm, pos, surf, C); keepInside(allPos, sm, s1, pos, surf, C); // (one eye at a time)
      keepInside(eyePos, 0, em, pos, surf, C); keepInside(eyePos, em, em * 2, pos, surf, C);
      rig.eyes.pos = eyePos;
    });
    setMesh(this.geo, allPos, allUV, keep, rig.headMorphs);
    setMesh(this.mouth.geometry, new Float32Array(rig.mouth.pos), new Float32Array(rig.mouth.uv), rig.mouth.idx, rig.mouthMorphs);
    setMesh(this.eyes.geometry, new Float32Array(rig.eyes.pos), new Float32Array(rig.eyes.uv), rig.eyes.idx, rig.eyeMorphs);
    // the eyeballs take the face's normal at each eye (lit like the skin around them, sunk in the socket),
    // not their own sphere normals (which lit each one as a glossy ball popping out of the face)
    {
      const fn = this.geo.attributes.normal, en = this.eyes.geometry.attributes.normal, half = en.count / 2;
      rig.eyeRegions.forEach((reg, e) => {
        const n = [0, 0, 0];
        for (const i of reg) { n[0] += fn.getX(i); n[1] += fn.getY(i); n[2] += fn.getZ(i); }
        const l = Math.hypot(...n) || 1;
        for (let v = e * half; v < (e + 1) * half; v++) en.setXYZ(v, n[0] / l, n[1] / l, n[2] / l);
      });
      en.needsUpdate = true;
    }
    this.eyeRegions = rig.eyeRegions;
    perf.time('head.paintEyes', () => this.paintEyes(rig.eyeRegions, p));
  }

  // Eye colors from the photo's own eye area (in the face texture, where the warped face draws it): the
  // iris from its darkest pixels, the sclera from its brightest, pulled toward white; so the generated eye
  // sits in the face without looking pasted on. Repainted only when the colors change.
  paintEyes(regions, p) {
    const atlas = this.last?.atlas, uvW = this.last?.uvW;
    let iris = [0.32, 0.22, 0.16], sclera = [0.9, 0.86, 0.82];
    if (atlas && uvW) {
      const n = atlas.width, d = atlas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, n, n).data, px = [];
      for (const reg of regions) {
        const xs = reg.map((i) => uvW[i][0]), ys = reg.map((i) => uvW[i][1]);
        const cx = xs.reduce((a, b) => a + b) / xs.length, cy = ys.reduce((a, b) => a + b) / ys.length;
        const rx = (Math.max(...xs) - Math.min(...xs)) * 0.35, ry = (Math.max(...ys) - Math.min(...ys)) * 0.35;
        for (let k = 0; k < 60; k++) {
          const a = k * 2.399, r = Math.sqrt((k + 0.5) / 60), u = cx + Math.cos(a) * r * rx, v = cy + Math.sin(a) * r * ry;
          const o = (Math.min(n - 1, Math.max(0, Math.floor((1 - v) * n))) * n + Math.min(n - 1, Math.max(0, Math.floor(u * n)))) * 4;
          px.push([d[o] / 255, d[o + 1] / 255, d[o + 2] / 255]);
        }
      }
      const lum = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
      px.sort((a, b) => lum(a) - lum(b));
      const avg = (arr) => [0, 1, 2].map((k) => arr.reduce((s2, c) => s2 + c[k], 0) / arr.length);
      iris = avg(px.slice(Math.floor(px.length * 0.1), Math.floor(px.length * 0.35)));
      const li = lum(iris), sat = 1.4; // a touch more colorful and never pitch black, so it reads as an iris
      iris = iris.map((c) => Math.min(1, Math.max(0.05, li + (c - li) * sat + 0.06)));
      // eye whites are never paper white in a photo: about 1.15x the skin's luminance (capped), slightly
      // toward the photo's own brightest eye pixels, mostly neutral with a trace of the skin's warmth
      const hi = avg(px.slice(Math.floor(px.length * 0.8))), sk = this.last.skin, sl = lum(sk);
      const target = Math.min(0.82, Math.max(0.4, sl * 1.25));
      sclera = [0, 1, 2].map((k) => target * (0.85 + 0.15 * sk[k] / Math.max(sl, 0.02)) * 0.8 + hi[k] * 0.2);
    }
    // the character's eye traits (Eyes sliders); Odd eye gives one eye (deterministically chosen) a
    // different iris, redness or pupil, the rest of the time both eyes are identical
    const base = { sclera, iris: hueShift(iris, p.eyeHue || 0), pupil: p.eyePupil ?? 0.42, voidEye: p.eyeVoid, red: p.eyeRed || 0, veins: p.eyeVeins || 0, yellow: p.eyeYellow || 0, seed: (p.seed | 0) + 11 };
    const odd = p.eyeOdd || 0, pickOdd = ((p.seed | 0) >>> 3) % 3, other = { ...base, seed: base.seed + 7 };
    if (odd > 0) {
      if (pickOdd === 0) other.iris = hueShift(base.iris, 60 + 120 * odd);
      else if (pickOdd === 1) other.red = Math.min(1, base.red + odd), other.veins = Math.min(1, base.veins + odd * 0.8);
      else other.pupil = base.pupil > 0.5 ? 0.22 : 0.75;
    }
    const side = ((p.seed | 0) >>> 5) % 2, eyeR = side ? other : base, eyeL = side ? base : other;
    const key = JSON.stringify([eyeR, eyeL]);
    if (key === this.eyeKey) return;
    this.eyeKey = key;
    const c = this.eyeTex.image, g = c.getContext('2d');
    drawEye(g, 0, c.height, eyeR); drawEye(g, c.height, c.height, eyeL);
    this.eyeTex.needsUpdate = true;
  }

  apply(key, P) {
    const r = this.cache.get(key);
    this.key = key;
    this.skull.visible = false; // the head is the face's own mesh; the skull only shapes hair and hats
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

  paint(hair, skin, p) {
    paintSkinTile(this.skinTex.image, skin);
    this.skinTex.needsUpdate = true;
    const u = this.baker.mat.uniforms;
    if (hair) { this.hairTex.image = hair.canvas; this.hairTex.needsUpdate = true; }
    u.hairTint.value.set(p.hairHue, 1, p.hairBright);
    u.hairColor.value.set(...(hair?.color || [0.16, 0.12, 0.09])).multiplyScalar(p.hairBright);
    u.slick.value = this.slick;
    this.headTexture = perf.time('head.paint', () => this.baker.paint(this.bakeGeo, 256));
    this.headCanvas = perf.time('head.readback', () => this.baker.toCanvas(this.headCanvas));
    this.skullMat.uniforms.map.value = this.headTexture;
    this.hairShellMat.uniforms.map.value = this.headTexture;
  }

  // Stringy wisps hanging from the hair shell's lower edge (sides and back): rooted on the shell itself
  // (never on bald skull or poking through it), hanging straight down, tinted with the shell's own
  // painted color (the mean of the head texture over the shell), so dye and photo hair carry over.
  buildHair(on) {
    this.hair.clear();
    const geo = this.hairShell.geometry, pos = geo.attributes.position;
    if (!on || !this.hairShell.visible || !pos || !this.headCanvas) return;
    const nrm = geo.attributes.normal, uv = geo.attributes.uv, D = this.dims;
    // root per angle bin: the lowest outward-facing shell vertex (sides and back only)
    const BINS = 20, root = new Array(BINS).fill(-1);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i) - D.sideZ, nx = nrm.getX(i), nz = nrm.getZ(i);
      const a = Math.atan2(x, -z); // 0 at the back, +-pi/2 at the sides
      if (Math.abs(a) > 1.75 || nrm.getY(i) > 0.5 || nx * x + nz * z <= 0) continue;
      const b = Math.min(BINS - 1, Math.floor(((a + 1.75) / 3.5) * BINS));
      if (root[b] < 0 || y < pos.getY(root[b])) root[b] = i;
    }
    // the shell's painted color
    const g = this.headCanvas.getContext('2d', { willReadFrequently: true }), n = this.headCanvas.width, px = g.getImageData(0, 0, n, n).data;
    const col = [0, 0, 0];
    let cnt = 0;
    for (let i = 0; i < uv.count; i += 3) {
      const o = (Math.min(n - 1, Math.floor((1 - uv.getY(i)) * n)) * n + Math.min(n - 1, Math.floor(uv.getX(i) * n))) * 4;
      col[0] += px[o]; col[1] += px[o + 1]; col[2] += px[o + 2]; cnt++;
    }
    this.hairMat.uniforms.color.value.setRGB(...col.map((v) => v / cnt / 255 / 0.85)); // strands average 0.85
    root.forEach((i, b) => {
      if (i < 0) return;
      const len = 0.28 + 0.22 * (0.5 + 0.5 * Math.sin(b * 2.3));
      const cg = new THREE.PlaneGeometry(0.14, len, 1, 2).translate(0, -len / 2, 0);
      const m = new THREE.Mesh(cg, this.hairMat);
      const ox = nrm.getX(i), oz = nrm.getZ(i), l = Math.hypot(ox, oz) || 1;
      m.position.set(pos.getX(i) - (ox / l) * 0.015, pos.getY(i) + 0.05, pos.getZ(i) - (oz / l) * 0.015); // root tucked in
      m.lookAt(m.position.x + ox, m.position.y, m.position.z + oz); // vertical card facing out
      this.hair.add(m);
    });
  }
}
HeadRig.ids = 0;

// Pull points [from, to) of `pts` that lie outside a closed-ish surface (triangles `tris` over `surf`) back
// just inside it, along the ray from the center C (Moller-Trumbore, the first surface crossing along it)
function keepInside(pts, from, to, surf, tris, C, margin = 0.012) {
  // only the triangles facing the points' general direction from C can be hit (flat arrays, no allocation)
  let gx = 0, gy = 0, gz = 0;
  for (let v = from; v < to; v++) { gx += pts[v * 3] - C[0]; gy += pts[v * 3 + 1] - C[1]; gz += pts[v * 3 + 2] - C[2]; }
  const gl = Math.hypot(gx, gy, gz) || 1;
  const T = [];
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t] * 3, b = tris[t + 1] * 3, c = tris[t + 2] * 3;
    const mx = (surf[a] + surf[b] + surf[c]) / 3 - C[0], my = (surf[a + 1] + surf[b + 1] + surf[c + 1]) / 3 - C[1], mz = (surf[a + 2] + surf[b + 2] + surf[c + 2]) / 3 - C[2];
    if ((mx * gx + my * gy + mz * gz) / (gl * (Math.hypot(mx, my, mz) || 1)) <= 0.35) continue;
    T.push(surf[a], surf[a + 1], surf[a + 2], surf[b] - surf[a], surf[b + 1] - surf[a + 1], surf[b + 2] - surf[a + 2], surf[c] - surf[a], surf[c + 1] - surf[a + 1], surf[c + 2] - surf[a + 2]);
  }
  for (let v = from; v < to; v++) {
    const dx0 = pts[v * 3] - C[0], dy0 = pts[v * 3 + 1] - C[1], dz0 = pts[v * 3 + 2] - C[2], len = Math.hypot(dx0, dy0, dz0);
    if (len < 1e-6) continue;
    const dx = dx0 / len, dy = dy0 / len, dz = dz0 / len;
    let hit = Infinity;
    for (let q = 0; q < T.length; q += 9) {
      const e1x = T[q + 3], e1y = T[q + 4], e1z = T[q + 5], e2x = T[q + 6], e2y = T[q + 7], e2z = T[q + 8];
      const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x, det = e1x * px + e1y * py + e1z * pz;
      if (det > -1e-12 && det < 1e-12) continue;
      const tx = C[0] - T[q], ty = C[1] - T[q + 1], tz = C[2] - T[q + 2], u = (tx * px + ty * py + tz * pz) / det;
      if (u < 0 || u > 1) continue;
      const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x, w = (dx * qx + dy * qy + dz * qz) / det;
      if (w < 0 || u + w > 1) continue;
      const t = (e2x * qx + e2y * qy + e2z * qz) / det;
      if (t > 1e-4 && t < hit) hit = t;
    }
    if (hit === Infinity || len <= hit + 1e-4) continue; // inside or on the surface (the socket's rim is the lids)
    const k = (hit - margin) / len;
    pts[v * 3] = C[0] + dx0 * k; pts[v * 3 + 1] = C[1] + dy0 * k; pts[v * 3 + 2] = C[2] + dz0 * k;
  }
}

// (re)fill a geometry: positions, uvs, index, normals, and relative morph targets named after MORPHS
function setMesh(g, pos, uv, idx, morphs) {
  for (const k of Object.keys(g.attributes)) g.deleteAttribute(k);
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.morphTargetsRelative = true;
  g.morphAttributes.position = MORPHS.map((m) => Object.assign(new THREE.BufferAttribute(morphs[m], 3), { name: m }));
  g.computeVertexNormals(); g.computeBoundingSphere(); g.computeBoundingBox();
}

// skin the head's mirrored texture paths bounce toward: forehead, its sides, cheeks, lower cheeks, chin
// (below the lip): reached from the outline without crossing an eye or the mouth
const SKIN_ANCHORS = [151, 108, 337, 50, 280, 187, 411, 199];
const CLASSIC_K = 7; // rings of the original hull

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
    // (hidden) skull in the face's skin tone, stubble where a buzz cut sits, AO behind the ears
    c = tri(skinMap, p, n, 2.2);
    c = mix(c, hairColor * .7, vAux * (.55 + .45 * hash(floor(p * 70.))) * .75);
    c *= mix(.3, 1., vAo);
  }
  gl_FragColor = vec4(clamp(c, 0., 1.), 1.);
}`;


// grey strands (tinted per character by the material color), deterministic
function drawHair(g, w, h) {
  g.clearRect(0, 0, w, h);
  const r = (k) => ((Math.sin(k * 12.9898) * 43758.5453) % 1 + 1) % 1;
  for (let x = 0; x < w; x++) {
    if (r(x) < 0.35) continue;
    const end = h * (0.55 + r(x + 101) * 0.45), v = 180 + r(x + 57) * 75;
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.fillRect(x, 0, 1, end);
  }
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
