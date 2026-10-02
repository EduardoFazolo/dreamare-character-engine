import * as THREE from 'three';
import { sculptHead } from './headsculpt.js';
import { photoHair } from './photohair.js';
import { buildGadget, buildMask, MASK_HIDES_HAIR } from './facewear.js';

import { perf } from './perf.js';
import { unwrap, BodyBaker } from './bodybake.js';
import { paintSkinTile } from './skintile.js';
import { boundaryLoop } from './outline.js';
import { scalpStrip } from './atlas.js';
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
    // the seamless scalp (scalp: 'seamless'): the skull as its own mesh with its own texture, painted from the
    // face's outline colours with the face's own skin detail and dither (paintScalp), so face and skull read as one skin
    this.scalpCanvas = document.createElement('canvas'); this.scalpCanvas.width = this.scalpCanvas.height = 4;
    this.scalpTex = new THREE.CanvasTexture(this.scalpCanvas); this.scalpTex.magFilter = this.scalpTex.minFilter = THREE.NearestFilter;
    this.scalpMat = ps2Material({ map: this.scalpTex }); this.scalpMat.name = 'scalp';
    this.scalp = new THREE.Mesh(new THREE.BufferGeometry(), this.scalpMat); this.scalp.visible = false;
    this.group.add(this.scalp);
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

    // an animal's ears, cut from its photo (buildEars)
    this.earMat = ps2Material({ side: THREE.DoubleSide }); this.earMat.name = 'animalEar';
    this.ears = new THREE.Mesh(new THREE.BufferGeometry(), this.earMat); this.ears.visible = false;
    this.group.add(this.ears);

    // face gadgets and masks (facewear.js)
    this.wear = new THREE.Group(); this.group.add(this.wear);

    this.hairMat = ps2Material({ map: canvasTex(32, 64, drawHair), alphaTest: 0.5, side: THREE.DoubleSide });
    this.hairMat.name = 'hairStrands';
    this.hair = new THREE.Group();
    this.group.add(this.hair);
  }

  // extra: { hair: analyzeHair(face) result, skin: [r,g,b] face skin tone, uvW: the warped face UVs }
  // Returns null when the head is ready, or a promise that resolves once its sculpt is applied.
  update(P, tex, p, { animal = null, uvBase = null, hair = null, hairUV = null, skin = [0.8, 0.6, 0.5], uvW = null, atlas = null } = {}) {
    this.headMat.uniforms.map.value = tex;
    this.last = { P, p, uvBase, hair, hairUV, skin, uvW, atlas };
    // the head mesh depends only on the face, its texture warp and the head shape: body, outfit, pose...
    // changes skip the rebuild (only the eye colors/traits are re-checked)
    let hk = 0;
    for (const v of P) for (const c of v) hk = (Math.imul(hk, 31) + Math.round(c * 1e4)) | 0;
    if (uvW) for (const v of uvW) for (const c of v) hk = (Math.imul(hk, 31) + Math.round(c * 1e4)) | 0;
    if (hairUV) for (let i = 0; i < hairUV.data.length; i += 7) hk = (Math.imul(hk, 31) + hairUV.data[i]) | 0;
    const headKey = `${hk}|${p.headDepth}|${p.cranium}|${p.scalp}|${p.sphere || 0}|${p.sphereTop || 0}|${p.faceShape}|${p.faceShapeAmt}|${p.rimInset || 0}`;
    if (headKey !== this.headKey) { this.headKey = headKey; this.buildHead(P, p); }
    if (this.scalpLayout && atlas) this.paintScalp(atlas, p);
    const earKey = `${headKey}|${animal?.name}|${p.earSize}`;
    if (earKey !== this.earKey) { this.earKey = earKey; this.buildEars(P, animal, p); }
    else if (this.eyeRegions) this.paintEyes(this.eyeRegions, p);

    // 'photo': the person's own hair cut from the photo (photohair.js) over a bald sculpted skull
    const style = p.hairStyle === 'auto' ? hair?.style || 'short' : p.hairStyle === 'photo' ? 'bald' : p.hairStyle;
    // the sculpted skull only shapes the hair shell and hats: it depends on the face's outline and overall
    // depth, not its interior (grin, eyes, nose sliders never re-sculpt), plus skull and hair params
    let front = -Infinity;
    for (const v of P) front = Math.max(front, v[2]);
    const rim = this.loop.map((i) => P[i].map((x) => Math.round(x * 200)));
    const key = JSON.stringify([rim, Math.round(front * 50), [10, 152, 234, 454, 33, 263, 9, 151].map((i) => P[i].map((x) => Math.round(x * 200))),
      p.cranium, p.headDepth, p.earSize, p.hairVolume, p.girth, p.headScale, Math.max(0, p.fat), p.clay, style, p.hat, p.hatSize ?? 1]);
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

  // An animal's ears: each a leaf from its base (two points on the head's outline side) to its tip, cut from
  // the photo (the UVs pulled 8% in, off the background), placed where the photo has it relative to the
  // nearest outline point and tilted back toward the tip; Ear size scales it from its base.
  buildEars(P, animal, p) {
    const g = new THREE.BufferGeometry();
    this.ears.geometry.dispose(); this.ears.geometry = g; this.ears.visible = false;
    if (!animal?.ears?.length) return;
    const pos = [], uv = [], idx = [], s = 0.7 + 0.3 * (p.earSize ?? 1), G = animal.geo;
    for (const ear of animal.ears) {
      const [a, b, t] = ear.geo, mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      let anchor = this.loop[0], best = Infinity;
      for (const v of this.loop) { const d = (G[v][0] - mid[0]) ** 2 + (G[v][1] - mid[1]) ** 2; if (d < best) { best = d; anchor = v; } }
      const A = P[anchor], base = G[anchor];
      const place = (q) => { const sq = [mid[0] + (q[0] - mid[0]) * s, mid[1] + (q[1] - mid[1]) * s], d = Math.hypot(sq[0] - mid[0], sq[1] - mid[1]); return [A[0] + sq[0] - base[0], A[1] + sq[1] - base[1], A[2] - 0.05 - 0.35 * d]; };
      // a leaf: base, a row at 45% (widest: 1.4x the base, at least 45% of the length), a row at 75%, tip
      const leaf = (A0, B0, T0) => {
        const m0 = [(A0[0] + B0[0]) / 2, (A0[1] + B0[1]) / 2], ax = [T0[0] - m0[0], T0[1] - m0[1]], L0 = Math.hypot(...ax) || 1e-6;
        let pp = [-ax[1] / L0, ax[0] / L0]; if ((A0[0] - m0[0]) * pp[0] + (A0[1] - m0[1]) * pp[1] < 0) pp = [-pp[0], -pp[1]]; // (toward the inner base)
        const W = Math.max(Math.hypot(A0[0] - B0[0], A0[1] - B0[1]) * 1.4, L0 * 0.45), row = (k, wk) => { const c = [m0[0] + ax[0] * k, m0[1] + ax[1] * k]; return [[c[0] + pp[0] * W * wk / 2, c[1] + pp[1] * W * wk / 2], [c[0] - pp[0] * W * wk / 2, c[1] - pp[1] * W * wk / 2]]; };
        return [A0, B0, ...row(0.45, 1), ...row(0.75, 0.7), T0];
      };
      const asp = animal.img.naturalHeight / animal.img.naturalWidth, ph = ear.photo.map(([x, y]) => [x, y * asp]); // (square units for the leaf)
      const shape = leaf(a, b, t), pshape = leaf(ph[0], ph[1], ph[2]).map(([x, y]) => [x, y / asp]);
      const pc = pshape.reduce((q, r) => [q[0] + r[0] / pshape.length, q[1] + r[1] / pshape.length], [0, 0]);
      const puv = pshape.map((q) => [pc[0] + (q[0] - pc[0]) * 0.92, 1 - (pc[1] + (q[1] - pc[1]) * 0.92)]); // (pulled in, off the background)
      const o = pos.length / 3;
      for (const q of shape) pos.push(...place(q));
      for (const q of puv) uv.push(...q);
      // rows: 0,1 base / 2,3 at 45% / 4,5 at 75% / 6 tip
      idx.push(o, o + 1, o + 3, o, o + 3, o + 2, o + 2, o + 3, o + 5, o + 2, o + 5, o + 4, o + 4, o + 5, o + 6);
    }
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx); g.computeVertexNormals(); g.computeBoundingSphere();
    this.earMat.uniforms.map.value = animal.tex;
    this.ears.visible = true;
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
    this.photo = p.hairStyle === 'photo';
    if (this.photo) this.buildPhotoHair(hair, p, hairId);

    // masks (people only) and gadgets, rebuilt when the head or the choice changes; a sack or bandages hide the hair
    const mask = p.faceKind === 'mask' ? p.mask || 'doll' : null;
    this.wearArgs = { mask, p };
    this.buildWear();
    const hideHair = mask && MASK_HIDES_HAIR.has(mask);
    if (hideHair) this.hairShell.visible = false;
    this.buildHair(p.hair === 'stringy' && !hideHair);
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
    const patch = !!this.last?.uvBase || p.scalp === 'skin' || p.scalp === 'forehead' || p.scalp === 'seamless'; // (animals, or scalp: 'skin': the skull wears a tiled patch of the forehead, not the mirror)
    const dupN = patch ? L : 0; // (the hull's own copy of the outline, see the fur patch)
    const pos = new Float32Array((n + dupN) * 3), uv = new Float32Array((n + dupN) * 2), uv0 = this.last?.uvBase || this.canon.uv; // (animals: their own layout)
    // mouth and eye rims moved to where the texture draws them (faceanim.js alignToTexture)
    const al = perf.time('head.align', () => alignToTexture(P, uv0, this.last?.uvW || uv0, this.canon.index, this.loop));
    for (let i = 0; i < 468; i++) { pos.set(al.P[i], i * 3); uv.set(al.uv[i], i * 2); }
    if (p.rimInset > 0) { // the outline's texture pulled in toward the face's middle: a photo's outline often runs over sideburns, ears or the jaw's shadow, which drew a dark line round the face against the skull's skin
      const cu = [0, 0]; for (const i of this.loop) { cu[0] += uv[i * 2] / L; cu[1] += uv[i * 2 + 1] / L; }
      const rimSet = new Set(this.loop);
      for (let i = 0; i < 468; i++) {
        const k = rimSet.has(i) ? p.rimInset : 0; if (!k) continue;
        uv[i * 2] += (cu[0] - uv[i * 2]) * k; uv[i * 2 + 1] += (cu[1] - uv[i * 2 + 1]) * k;
      }
    }
    const A = this.last?.uvW || uv0, c0 = [0.5, 0.5], ang = (q) => Math.atan2(q[1] - c0[1], q[0] - c0[0]);
    const target = (v) => { const th = ang(uv0[v]); let wx = 0, wy = 0, ws = 0;
      for (const a of SKIN_ANCHORS) { let d = Math.abs(ang(uv0[a]) - th); d = Math.min(d, 2 * Math.PI - d); const w = Math.exp(-(d * d) / 0.18); wx += A[a][0] * w; wy += A[a][1] * w; ws += w; }
      return [wx / ws, wy / ws]; };
    // texture units per head unit on the face (face width in UV / in 3D), for the 1:1 mirror
    const uvPerUnit = Math.hypot(uv0[454][0] - uv0[234][0], uv0[454][1] - uv0[234][1]) / (Math.hypot(P[454][0] - P[234][0], P[454][1] - P[234][1]) || 1);
    // Hair lying over the face (a lock across the cheek, bangs) is in the face texture too, and a mirror line
    // crossing it copied it onto the side of the head (dark commas). Each outline point mirrors only within
    // the stretch from the rim inward up to the first hair texel: the photo's hair mask (unwrapped like the
    // texture: atlas.js hairMask) or anything far darker than the skin (under half: strands the mask misses). Measured:
    // skipping past the hair still spanned it in the rim -> first ring strip, and switching to another
    // anchor made neighbouring points' lines diverge (a triangle between them spans the whole face). So each
    // line is only shortened along its own direction, and neighbours agree (the shortest of 5).
    const HM = this.last?.hairUV, AT = HM ? this.last?.atlas : null; // (no hair mask, e.g. an animal: dark fur is not hair)
    const atlasPx = AT ? AT.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, AT.width, AT.height).data : null;
    const sk = this.last?.skin || [0.8, 0.6, 0.5], darkLum = 0.5 * (0.299 * sk[0] + 0.587 * sk[1] + 0.114 * sk[2]) * 255;
    const hairAt = (u, v) => {
      if (atlasPx) { const n = AT.width, x = Math.min(n - 1, Math.max(0, Math.floor(u * n))), y = Math.min(n - 1, Math.max(0, Math.floor((1 - v) * n))), o = (y * n + x) * 4; if (0.299 * atlasPx[o] + 0.587 * atlasPx[o + 1] + 0.114 * atlasPx[o + 2] < darkLum) return true; }
      if (!HM) return false; const n = HM.n;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const x = Math.floor(u * n) + dx, y = Math.floor(v * n) + dy; if (x >= 0 && y >= 0 && x < n && y < n && HM.data[y * n + x]) return true; }
      return false;
    };
    // animals (their own texture layout): eyes sit near the head's sides, where human-placed lines run; they
    // block the lines too (an ellipse around each eye's contour, 1.6x its size)
    const eyesUV = this.last?.uvBase ? [[33, 133, 159, 145, 160, 144, 158, 153], [263, 362, 386, 374, 387, 373, 385, 380]].map((ids) => {
      const xs = ids.map((i) => A[i][0]), ys = ids.map((i) => A[i][1]), cx = xs.reduce((a, b) => a + b) / xs.length, cy = ys.reduce((a, b) => a + b) / ys.length;
      return [cx, cy, Math.max(0.02, (Math.max(...xs) - Math.min(...xs)) * 0.8), Math.max(0.02, (Math.max(...ys) - Math.min(...ys)) * 0.8 + 0.02)];
    }) : [];
    const blocked = (u, v) => hairAt(u, v) || eyesUV.some(([cx, cy, rx, ry]) => ((u - cx) / rx) ** 2 + ((v - cy) / ry) ** 2 < 1);
    const firstHair = (r0, t) => { // fraction along r0 -> t of the first hair texel (1: none), past the rim's own texels
      const S = 48;
      for (let j = 2; j <= S; j++) if (blocked(r0[0] + (t[0] - r0[0]) * (j / S), r0[1] + (t[1] - r0[1]) * (j / S))) return (j - 1) / S;
      return 1;
    };
    const base = this.loop.map((v) => ({ r0: uv0[v], t: target(v) }));
    const fr = base.map(({ r0, t }) => firstHair(r0, t));
    const lines = base.map(({ r0, t }, i) => {
      let f = 1; for (let d = -2; d <= 2; d++) f = Math.min(f, fr[(i + d + L) % L]);
      const len = Math.hypot(t[0] - r0[0], t[1] - r0[1]) || 1e-6;
      f = Math.max(f, Math.min(1, 0.04 / len)); // never shorter than 0.04 (shorter mirrors into stripes)
      return { r0, t: [r0[0] + (t[0] - r0[0]) * f, r0[1] + (t[1] - r0[1]) * f] };
    });
    // Animals: their face's rim -> anchor lines are short against the big sides of the head (the mirror bounced
    // many times: bands), and pass near eyes set far apart. From the second ring back, the head wears a
    // patch of the animal's own forehead fur instead (between the brows and the top, inside the outline's
    // upper corners), mirror-tiled 1:1; the tiling's seam around the ring starts under the chin.
    const pingpong = (x, span) => { const f = (x / span) % 2; return (f < 1 ? f : 2 - f) * span; };
    let fur = null, ringArc = null;
    if (patch) {
      const x0 = Math.min(A[109][0], A[338][0]), x1 = Math.max(A[109][0], A[338][0]), yTop = Math.max(A[10][1], A[109][1], A[338][1]), yLow = Math.max(A[9][1], A[168][1]) + 0.02;
      const pad = (x1 - x0) * 0.12, top = yTop - 0.03;
      const mid = (x0 + x1) / 2 - 0.015; // one side of the brow only (a blaze or stripe down the middle would tile everywhere)
      if (top - yLow > 0.03 && mid - x0 > 0.04) fur = { x0: x0 + pad, w: mid - x0 - pad, y1: top, h: top - yLow };
      if (!this.last?.uvBase && p.scalp !== 'forehead') { // (a human scalp: clean cheek skin instead, a bigger patch with no hair or brow in it: the forehead
        // patch was small and often under a fringe, and its mirror bounces showed as bands on a tall dome)
        const c = [(A[50][0] + A[117][0] + A[187][0]) / 3, (A[50][1] + A[117][1] + A[187][1]) / 3], s2 = Math.min(0.09, Math.hypot(A[50][0] - A[187][0], A[50][1] - A[187][1]) * 0.9);
        fur = { x0: c[0] - s2 / 2, w: s2, y1: c[1] + s2 / 2, h: s2 };
      }
      const start = Math.max(0, this.loop.indexOf(152)), per = [];
      ringArc = (k, i) => {
        if (!per[k]) { // cumulative distance around ring k from under the chin (positions of rings < k are set)
          const d = new Float32Array(L), at = (j) => (k === 0 ? P[this.loop[j]] : [pos[(468 + (k - 1) * L + j) * 3], pos[(468 + (k - 1) * L + j) * 3 + 1], pos[(468 + (k - 1) * L + j) * 3 + 2]]);
          for (let q = 1; q < L; q++) { const a = at((start + q - 1) % L), b = at((start + q) % L); d[(start + q) % L] = d[(start + q - 1) % L] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]); }
          per[k] = d;
        }
        return per[k][i];
      };
    }
    const arc = new Float32Array(L), colArc = new Float32Array(n);
    for (let k = 1; k < K; k++) {
      const th = (k / K) * Math.PI / 2;
      for (let i = 0; i < L; i++) {
        const b = P[this.loop[i]], rx = b[0] - C[0], ry = b[1] - C[1], rz = b[2] - C[2];
        const m = Math.hypot(rx, ry) || 1e-6, dx = rx / m, dy = ry / m;
        const radial = m * Math.pow(Math.cos(th), 0.6) * (1 + 0.28 * Math.sin(2 * th));
        const lift = cranium * Math.sin(th) * Math.pow(Math.max(0, dy), 2) * m;
        const o = 468 + (k - 1) * L + i;
        pos.set([C[0] + dx * radial, C[1] + dy * radial + lift, C[2] + rz * Math.cos(th) - depth * Math.sin(th)], o * 3);
        const { t, r0 } = lines[i];
        // mirror padding (see above): ping-pong along the rim -> anchor line
        const prev = k === 1 ? P[this.loop[i]] : [pos[(o - L) * 3], pos[(o - L) * 3 + 1], pos[(o - L) * 3 + 2]], q = [pos[o * 3], pos[o * 3 + 1], pos[o * 3 + 2]];
        arc[i] = (k === 1 ? 0 : arc[i]) + Math.hypot(q[0] - prev[0], q[1] - prev[1], q[2] - prev[2]);
        const span = Math.hypot(t[0] - r0[0], t[1] - r0[1]) || 1e-6, d = (arc[i] * uvPerUnit) / span;
        const f = d % 2, w = f < 1 ? f : 2 - f; // ping-pong 0..1..0
        uv[o * 2] = r0[0] + (t[0] - r0[0]) * w; uv[o * 2 + 1] = r0[1] + (t[1] - r0[1]) * w;
        colArc[o] = arc[i];
      }
    }
    // (animals, and a human's skin-patch scalp) the patch, mirror-tiled around the ring x down the column (after all rings are placed)
    // (from the outline itself: the hull gets its own copy of the outline's vertices, so no hull triangle's
    // texture spans from the face's rim across the face to the patch)
    if (fur) for (let k = 0; k < K; k++) for (let i = 0; i < L; i++) {
      const o = k === 0 ? n + i : 468 + (k - 1) * L + i;
      if (k === 0) pos.set(pos.subarray(this.loop[i] * 3, this.loop[i] * 3 + 3), o * 3);
      uv[o * 2] = fur.x0 + pingpong(ringArc(k, i) * uvPerUnit, fur.w);
      uv[o * 2 + 1] = fur.y1 - pingpong((k === 0 ? 0 : colArc[o]) * uvPerUnit, fur.h);
    }
    if (fur && p.scalp === 'seamless' && !this.last?.uvBase) { // the skull's UVs into the face texture's scalp strip (atlas.js): ring k, outline point i (counted from under the chin, as the strip is painted)
      const sr = scalpStrip(A), st = Math.max(0, this.loop.indexOf(152));
      for (let k = 0; k < K; k++) for (let i = 0; i < L; i++) {
        const o = k === 0 ? n + i : 468 + (k - 1) * L + i, c = (i - st + L) % L;
        uv[o * 2] = sr.x0 + sr.w * (c + 0.5) / L; uv[o * 2 + 1] = sr.y0 + sr.h * (k === 0 ? 0.1 : 0.2 + 0.75 * (k / (K - 1)));
      }
      fur.seamless = sr;
    }
    const pole = n - 1;
    pos.set([C[0], C[1] + cranium * 0.2, C[2] - depth], pole * 3);
    this.hull = { pos: pos.slice(), L, K, C, loop: this.loop }; // photo hair grows on it
    uv.set(fur?.seamless ? [fur.seamless.x0 + fur.seamless.w / 2, fur.seamless.y0 + fur.seamless.h * 0.95] : fur ? [fur.x0 + fur.w / 2, fur.y1 - fur.h / 2] : A[[151, 108, 337, 50, 280, 187, 411, 199].find((a) => !hairAt(A[a][0], A[a][1])) ?? 151], pole * 2);
    const ring = (k, i) => (k === 0 ? (fur ? n + (i % L) : this.loop[i % L]) : 468 + (k - 1) * L + (i % L));
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
    // sphere (0..1): the whole head, face and all, pulled out onto a lumpy ball (a sun, a moon, a planet with a
    // face). Each point moves along its ray from a centre behind the nose to the ball's surface, which wobbles a
    // little (low bumps, seeded by direction), keeping a trace of its own relief (the nose, brow and lips still
    // stand out a touch). The face rig is built on the moved points, so the texture, eyes and mouth follow
    // faceShape: the face's outline drawn to a shape, like a liquify filter. Seen from the front, each point
    // moves along its ray from the face's middle: the outline goes all the way to the target shape (a circle,
    // a square, a heart...), the head behind it follows whole, and the pull fades toward the middle, so the
    // eyes, nose and mouth keep their proportions. The texture rides on the points and the face rig is built
    // after, so the photo stretches with it and the expressions obey the new shape
    if (p.faceShape && p.faceShape !== 'natural' && p.faceShapeAmt > 0) {
      const cx = this.loop.reduce((a, i) => a + al.P[i][0], 0) / L, cy = this.loop.reduce((a, i) => a + al.P[i][1], 0) / L;
      const rim = this.loop.map((i) => [Math.atan2(al.P[i][1] - cy, al.P[i][0] - cx), Math.hypot(al.P[i][0] - cx, al.P[i][1] - cy)]).sort((a, b) => a[0] - b[0]);
      const rimAt = (th) => { // the outline's own distance at an angle (between its two nearest points)
        let k = rim.findIndex((e) => e[0] > th); if (k < 0) k = 0;
        const a = rim[(k - 1 + rim.length) % rim.length], b = rim[k], span = ((b[0] - a[0]) + Math.PI * 4) % (Math.PI * 2) || 1e-6, u = (((th - a[0]) + Math.PI * 4) % (Math.PI * 2)) / span;
        return a[1] + (b[1] - a[1]) * Math.min(1, Math.max(0, u));
      };
      const poly = (n, phi) => (th) => { const seg = (Math.PI * 2) / n, t = ((((th - phi) % seg) + seg) % seg) - seg / 2; return Math.cos(Math.PI / n) / Math.cos(t); };
      const SHAPES = {
        circle: () => 1,
        square: (th) => Math.pow(Math.abs(Math.cos(th)) ** 4 + Math.abs(Math.sin(th)) ** 4, -0.25),
        diamond: poly(4, Math.PI / 2),
        triangle: poly(3, -Math.PI / 2), // (point at the chin)
        pyramid: poly(3, Math.PI / 2), // (point at the crown, wide jaw)
        heart: (th) => 0.86 + 0.16 * Math.max(0, Math.sin(th)) ** 0.5 * Math.abs(Math.cos(th)) ** 0.3 + 0.2 * Math.max(0, -Math.sin(th)) ** 6,
        pear: (th) => 1 - 0.22 * Math.sin(th),
        egg: (th) => 1 + 0.18 * Math.sin(th),
      };
      const shape = SHAPES[p.faceShape] || SHAPES.circle;
      let mean = 0, ms = 0; for (let i = 0; i < 72; i++) { const th = (i / 72) * Math.PI * 2 - Math.PI; mean += rimAt(th) / 72; ms += shape(th) / 72; }
      const amt = p.faceShapeAmt;
      const warp = (q, face) => {
        const dx = q[0] - cx, dy = q[1] - cy, r = Math.hypot(dx, dy); if (r < 1e-6) return q;
        const th = Math.atan2(dy, dx), ro = rimAt(th), sc = (shape(th) * mean / ms) / ro;
        const f = face ? Math.min(1, Math.pow(r / ro, 1.6)) : 1, k = 1 + (sc - 1) * f * amt;
        return [cx + dx * k, cy + dy * k, q[2]];
      };
      for (let i = 0; i < 468; i++) { al.P[i] = warp(al.P[i], true); pos.set(al.P[i], i * 3); }
      for (let i = 468; i < pos.length / 3; i++) pos.set(warp([pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]], false), i * 3);
      if (fur) for (let i = 0; i < L; i++) pos.set(pos.subarray(this.loop[i] * 3, this.loop[i] * 3 + 3), (n + i) * 3);
    }
    if (p.sphere > 0) {
      const R = Math.hypot(P[454][0] - P[234][0], P[454][1] - P[234][1]) * 0.62, Cs = [0, (P[10][1] + P[152][1]) / 2 + R * (p.sphereTop || 0), P[4][2] - R * 1.08]; // (sphereTop: the ball's centre raised over the face, so the face sits low on it under a big bald dome)
      const ref = (q) => Math.hypot(q[0] - Cs[0], q[1] - Cs[1], q[2] - Cs[2]);
      const rimR = this.loop.reduce((a, i) => a + ref(al.P[i]), 0) / L; // (the face's own mean distance, for its relief)
      const bump = (dx, dy, dz) => 1 + 0.014 * Math.sin(dx * 3.1 + dy * 1.7 + 0.6) * Math.cos(dy * 2.3 - dz * 1.9) + 0.01 * Math.sin(dz * 4.3 + dx * 2.9 + 1.3); // (a slight wobble: more and the ball reads as an oval)
      const ball = (q, keep) => {
        const d = ref(q) || 1e-6, dx = (q[0] - Cs[0]) / d, dy = (q[1] - Cs[1]) / d, dz = (q[2] - Cs[2]) / d;
        const r = R * bump(dx, dy, dz) + (keep ? (d - rimR) * 0.25 : 0);
        return [0, 1, 2].map((k) => q[k] + (Cs[k] + [dx, dy, dz][k] * r - q[k]) * p.sphere);
      };
      for (let i = 0; i < 468; i++) { al.P[i] = ball(al.P[i], true); pos.set(al.P[i], i * 3); }
      for (let i = 468; i < pos.length / 3; i++) pos.set(ball([pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]], false), i * 3);

      { // evened out: the chin's relief left the ball a few percent taller than wide; squash it back to round
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (let i = 0; i < pos.length / 3; i++) { x0 = Math.min(x0, pos[i * 3]); x1 = Math.max(x1, pos[i * 3]); y0 = Math.min(y0, pos[i * 3 + 1]); y1 = Math.max(y1, pos[i * 3 + 1]); }
        const k = 1 + ((x1 - x0) / (y1 - y0) - 1) * p.sphere, my = (y0 + y1) / 2;
        for (let i = 0; i < pos.length / 3; i++) pos[i * 3 + 1] = my + (pos[i * 3 + 1] - my) * k;
        for (let i = 0; i < 468; i++) al.P[i] = [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
      }
      if (fur) for (let i = 0; i < L; i++) pos.set(pos.subarray(this.loop[i] * 3, this.loop[i] * 3 + 3), (n + i) * 3); // (the hull's own copy of the outline must stay on the face's edge, or the seam opens)
    }
    // face rig: mouth and eyes cut open, eyeballs appended, mouth interior, morph targets (faceanim.js)
    const rig = perf.time('head.faceRig', () => buildFaceRig(al.P, al.uv, this.canon.index, pos));
    // what masks are built on: the head's surface (uncut), and its morphs for those vertices
    const nv = pos.length / 3;
    this.shell = { pos: pos.slice(), idx: idx.slice(), faceTris: this.canon.index.length / 3, canonUV: this.canon.uv, morphs: Object.fromEntries(MORPHS.map((m) => [m, rig.headMorphs[m].slice(0, nv * 3)])) };
    this.faceP = al.P.map((q) => [...q]);
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
      // eyeballs move back whole (squashing each vertex in separately bent the iris off the ball's centre:
      // big or warped eyes ended up wall-eyed, looking past you whatever the head did)
      for (const [a, b] of [[0, em], [em, em * 2]]) {
        const before = eyePos.slice(a * 3, b * 3); keepInside(eyePos, a, b, pos, surf, C);
        let best = 0, bi = -1; for (let v = a; v < b; v++) { const d = Math.hypot(eyePos[v * 3] - before[(v - a) * 3], eyePos[v * 3 + 1] - before[(v - a) * 3 + 1], eyePos[v * 3 + 2] - before[(v - a) * 3 + 2]); if (d > best) { best = d; bi = v; } }
        if (bi < 0) continue;
        const pull = [0, 1, 2].map((k) => eyePos[bi * 3 + k] - before[(bi - a) * 3 + k]); // the largest pull, applied to the whole ball
        const sh = [0, 0, -Math.hypot(...pull)]; // (straight back: along the ray from the head's centre it also slid the ball sideways and down in its opening, so the pupils looked past you)
        for (let v = a; v < b; v++) for (let k = 0; k < 3; k++) eyePos[v * 3 + k] = before[(v - a) * 3 + k] + sh[k];
      }
      // eyePop: the balls pushed forward out of the sockets (a fraction of their radius), so they bulge and catch the light
      if (p.eyePop) for (const [a, b] of [[0, em], [em, em * 2]]) {
        const c = [0, 0, 0]; for (let v = a; v < b; v++) for (let k = 0; k < 3; k++) c[k] += eyePos[v * 3 + k] / (b - a);
        let r = 0; for (let v = a; v < b; v++) r = Math.max(r, Math.hypot(eyePos[v * 3] - c[0], eyePos[v * 3 + 1] - c[1], eyePos[v * 3 + 2] - c[2]));
        for (let v = a; v < b; v++) eyePos[v * 3 + 2] += r * 0.55 * p.eyePop;
      }
      rig.eyes.pos = eyePos;
    });
    setMesh(this.geo, allPos, allUV, keep, rig.headMorphs);
    if (fur) { // the skull's own copy of the outline and the face's outline are one edge: one normal each pair, or the light breaks along it (a hard line round the face, like a suit's hood)
      const nr = this.geo.attributes.normal;
      for (let i = 0; i < L; i++) {
        const a = this.loop[i], b = n + i, x = nr.getX(a) + nr.getX(b), y = nr.getY(a) + nr.getY(b), z = nr.getZ(a) + nr.getZ(b), l = Math.hypot(x, y, z) || 1;
        nr.setXYZ(a, x / l, y / l, z / l); nr.setXYZ(b, x / l, y / l, z / l);
      }
      nr.needsUpdate = true;
    }
    this.scalp.visible = false; this.scalpLayout = null;
    if (fur && p.scalp === 'seamless' && !this.last?.uvBase) { // the skull moves to its own mesh (see paintScalp)
      const hv = (v) => v >= 468 && v < n + dupN, start = Math.max(0, this.loop.indexOf(152));
      const faceIdx = [], hullTris = [];
      for (let t = 0; t < keep.length; t += 3) (hv(keep[t]) && hv(keep[t + 1]) && hv(keep[t + 2]) ? hullTris : faceIdx).push(keep[t], keep[t + 1], keep[t + 2]);
      this.geo.setIndex(faceIdx);
      // each skull vertex: its ring k and outline column c (from under the chin); the pole is its own
      const ringCol = (v) => { if (v === n - 1) return null; if (v >= n) return [0, v - n]; const q = v - 468; return [Math.floor(q / L) + 1, q % L]; };
      const map = new Map(), P2 = [], U2 = [], src = [];
      const vert = (v, wrap) => {
        const key = v * 2 + (wrap ? 1 : 0); if (map.has(key)) return map.get(key);
        const rc = ringCol(v), id = src.length; src.push(v);
        P2.push(allPos[v * 3], allPos[v * 3 + 1], allPos[v * 3 + 2]);
        if (!rc) U2.push(0.5, 0); else { const c = (rc[1] - start + L) % L + (wrap ? L : 0); U2.push((c + 0.5) / (L + 1), 1 - rc[0] / (K - 1)); }
        map.set(key, id); return id;
      };
      const sIdx = [];
      for (let t = 0; t < hullTris.length; t += 3) {
        const tri = [hullTris[t], hullTris[t + 1], hullTris[t + 2]], cols = tri.map((v) => { const rc = ringCol(v); return rc ? (rc[1] - start + L) % L : null; });
        const wrap = cols.some((c) => c === L - 1) && cols.some((c) => c === 0); // (the column under the chin closes the loop: its far side reads one column past the end)
        for (const [j, v] of tri.entries()) sIdx.push(vert(v, wrap && cols[j] === 0));
      }
      const morphs = Object.fromEntries(MORPHS.map((m) => { const a = new Float32Array(src.length * 3), h = rig.headMorphs[m]; src.forEach((v, j) => { a[j * 3] = h[v * 3]; a[j * 3 + 1] = h[v * 3 + 1]; a[j * 3 + 2] = h[v * 3 + 2]; }); return [m, a]; }));
      setMesh(this.scalp.geometry, new Float32Array(P2), new Float32Array(U2), sIdx, morphs);
      { // one normal across the seam: the face's outline and the skull's first ring
        this.geo.computeVertexNormals();
        const fn = this.geo.attributes.normal, sn = this.scalp.geometry.attributes.normal;
        for (let i = 0; i < L; i++) for (const w of [false, true]) {
          const id = map.get((n + i) * 2 + (w ? 1 : 0)); if (id == null) continue;
          const a = this.loop[i], x = fn.getX(a) + sn.getX(id), y = fn.getY(a) + sn.getY(id), z = fn.getZ(a) + sn.getZ(id), l = Math.hypot(x, y, z) || 1;
          fn.setXYZ(a, x / l, y / l, z / l); sn.setXYZ(id, x / l, y / l, z / l);
        }
        fn.needsUpdate = sn.needsUpdate = true;
      }
      // the paint's layout: how long the skull runs round and back (in head units), the outline's texture
      // points in column order, and a clean patch of cheek for the skin's grain
      let around = 0; for (let i = 0; i < L; i++) { const a = this.loop[i], b = this.loop[(i + 1) % L]; around += Math.hypot(P[a][0] - P[b][0], P[a][1] - P[b][1], P[a][2] - P[b][2]); }
      let back = 0; for (let i = 0; i < L; i++) back = Math.max(back, colArc[468 + (K - 2) * L + i] || 0);
      const cc = [(A[50][0] + A[117][0] + A[187][0]) / 3, (A[50][1] + A[117][1] + A[187][1]) / 3], s2 = Math.min(0.09, Math.hypot(A[50][0] - A[187][0], A[50][1] - A[187][1]) * 0.9);
      this.scalpLayout = { L, around: around * 1.4, back: Math.max(back, around * 0.3), uvPerUnit, rim: Array.from({ length: L }, (_, c) => uv0[this.loop[(start + c) % L]]), patch: { x0: cc[0] - s2 / 2, y1: cc[1] + s2 / 2, w: s2, h: s2 } };
      this.scalp.visible = true; this.scalpPainted = null;
    }
    setMesh(this.mouth.geometry, new Float32Array(rig.mouth.pos), new Float32Array(rig.mouth.uv), rig.mouth.idx, rig.mouthMorphs);
    setMesh(this.eyes.geometry, new Float32Array(rig.eyes.pos), new Float32Array(rig.eyes.uv), rig.eyes.idx, rig.eyeMorphs);
    // the eyeballs take the face's normal at each eye (lit like the skin around them, sunk in the socket),
    // not their own sphere normals (which lit each one as a glossy ball popping out of the face)
    if (!p.eyePop) { // (popped eyes keep their own sphere normals: lit as balls bulging out of the face)
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
    const base = { sclera, iris: hueShift(iris, p.eyeHue || 0), pupil: p.eyePupil ?? 0.42, voidEye: p.eyeVoid, stare: p.eyeStare || 0, red: p.eyeRed || 0, veins: p.eyeVeins || 0, yellow: p.eyeYellow || 0, seed: (p.seed | 0) + 11 };
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
    this.hatFitLine = on ? r.hatFit.line0 : null;
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
      // hatSize (< 1): a hat too small for the head, perched on top: the crown, brim and visor scaled about a
      // point on the top of the skull, then sunk onto the dome by part of the height it lost
      const hs = this.last?.p?.hatSize ?? 1;
      this.hatCrown.scale.setScalar(1); this.hatCrown.position.set(0, 0, 0);
      if (hs !== 1) {
        const bb = g.boundingBox, pv = new THREE.Vector3(0, bb.max.y, (bb.min.z + bb.max.z) / 2), sink = (1 - hs) * (bb.max.y - f.line0) * 0.55;
        for (const m of [this.hatCrown, this.hatBrim, this.hatVisor]) {
          m.position.sub(pv).multiplyScalar(hs).add(pv); m.position.y -= sink;
          m.scale.multiplyScalar(hs);
        }
      }
    }
    this.buildWear(); // (the hat line is known now: a mask under it is trimmed to the brim)
  }

  // masks and gadgets, rebuilt when the head, the choice or the hat line changes (a mask stops under a hat's brim)
  buildWear() {
    const { mask, p } = this.wearArgs || {}; if (!p || !this.shell) return;
    const hatY = p.hat && p.hat !== 'none' && this.hatFitLine != null ? this.hatFitLine : null;
    const wearKey = `${this.headKey}|${mask}|${p.gadget}|${p.maskSize ?? 1}|${hatY?.toFixed(3)}|${p.hatSize ?? 1}`;
    if (wearKey === this.wearKey) return;
    this.wearKey = wearKey;
    this.wear.traverse((o) => { o.geometry?.dispose(); o.material?.map?.dispose?.(); });
    this.wear.clear();
    if (mask) this.wear.add(buildMask(mask, this.shell, this.faceP, p.maskSize ?? 1, { hatY }));
    if (p.gadget && p.gadget !== 'none') this.wear.add(buildGadget(p.gadget, this.faceP));
  }

  // the seamless scalp's texture, at the face texture's own density: each column is an outline point (from under
  // the chin), the top row its exact colour in the face texture (so the skull meets the face with no step),
  // softened across columns and settling to the outline's average further back; times the brightness of a
  // clean cheek patch tiled over it at 1:1 (the face's own pores and grain), then the face's 5-bit dither
  paintScalp(atlas, p) {
    const S = this.scalpLayout, key = `${atlas.width}|${p.levels}|${this.headKey}|${atlas._v || 0}`;
    const g0 = atlas.getContext('2d', { willReadFrequently: true }), N = atlas.width, px = g0.getImageData(0, 0, N, N).data;
    let sig = 0; for (let i = 0; i < px.length; i += 4097) sig = (sig * 31 + px[i]) | 0; // (repaint only when the face texture changed)
    if (this.scalpPainted === key + sig) return; this.scalpPainted = key + sig;
    const at = (u, v) => { const x = Math.min(N - 1, Math.max(0, Math.floor(u * N))), y = Math.min(N - 1, Math.max(0, Math.floor((1 - v) * N))), o = (y * N + x) * 4; return [px[o], px[o + 1], px[o + 2]]; };
    const rim = S.rim.map(([u, v]) => { const c = [0, 0, 0]; for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) { const q = at(u + dx / N, v + dy / N); for (let k = 0; k < 3; k++) c[k] += q[k] / 5; } return c; });
    const L = S.L, mean = [0, 1, 2].map((k) => rim.reduce((a, c) => a + c[k], 0) / L);
    const soft = rim.map((_, c) => { const o = [0, 0, 0]; let ws = 0; for (let j = 0; j < L; j++) { let d = Math.abs(j - c); d = Math.min(d, L - d); const w = Math.exp(-(d * d) / 6); ws += w; for (let k = 0; k < 3; k++) o[k] += rim[j][k] * w; } return o.map((x) => x / ws); });
    const lum = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
    const P = S.patch; let pm = 0; for (let i = 0; i < 64; i++) pm += lum(at(P.x0 + ((i % 8) + 0.5) / 8 * P.w, P.y1 - (Math.floor(i / 8) + 0.5) / 8 * P.h)) / 64;
    const W = Math.min(1024, Math.max(64, Math.round(S.around * S.uvPerUnit * N))), H = Math.min(512, Math.max(32, Math.round(S.back * S.uvPerUnit * N)));
    const cv = this.scalpCanvas; if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const g = cv.getContext('2d'), img = g.createImageData(W, H), d = img.data, lv = p.levels || 32;
    const pp = (x, span) => { const f = ((x / span) % 2 + 2) % 2; return (f < 1 ? f : 2 - f) * span; };
    const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
    const bayer = (x, y) => { const b2 = (a, c) => ((a / 2) % 1 + (c * c * 0.75) % 1) % 1; return b2(Math.floor(x / 2), Math.floor(y / 2)) * 0.25 + b2(Math.floor(x), Math.floor(y)); };
    for (let y = 0; y < H; y++) {
      const row = y / (H - 1); // (0 at the seam: the texture's top row, where v = 1)
      for (let x = 0; x < W; x++) {
        const col = (x + 0.5) / W * (L + 1) - 0.5, ci = ((Math.floor(col) % L) + L) % L, cj = (ci + 1) % L, fr = col - Math.floor(col);
        const exact = [0, 1, 2].map((k) => rim[ci][k] + (rim[cj][k] - rim[ci][k]) * fr), sf = [0, 1, 2].map((k) => soft[ci][k] + (soft[cj][k] - soft[ci][k]) * fr);
        const a = sm(0.15, 0.45, row), b = sm(0.25, 0.7, row);
        const base = [0, 1, 2].map((k) => (exact[k] + (sf[k] - exact[k]) * a) * (1 - b) + mean[k] * b);
        const pu = P.x0 + pp(x / N, P.w), pv = P.y1 - pp(y / N, P.h); let loc = 0;
        for (const [dx, dy] of [[-2, 0], [2, 0], [0, -2], [0, 2], [-2, -2], [2, 2], [-2, 2], [2, -2]]) loc += lum(at(pu + dx / N, pv + dy / N)) / 8;
        const det = Math.min(1.25, Math.max(0.75, lum(at(pu, pv)) / (loc || pm || 1))); // (only the fine grain, against its own neighbourhood: the patch's broad shading repeated as rings)
        const o = (y * W + x) * 4, dz = bayer(x, y);
        for (let k = 0; k < 3; k++) d[o + k] = Math.min(255, Math.floor(Math.min(1, (base[k] * det) / 255) * lv + dz) / lv * 255);
        d[o + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0); this.scalpTex.needsUpdate = true;
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

  // The person's own hair from the photo (photohair.js), on the hull buildHead made; under a hat only
  // below its line. Rebuilt when the head, the face, the hat or a hair / grade slider changes.
  buildPhotoHair(hair, p, hairId) {
    const hatY = p.hat !== 'none' && this.hatCrown.visible && this.hatFitLine != null ? this.hatFitLine + 0.04 : Infinity; // (a little way up inside the hat, tucked flat)
    const key = JSON.stringify([this.headKey, this.key, hairId, hatY, ...['hairVolume', 'hairRecede', 'hairHue', 'hairBright', 'pale', 'hue', 'sat', 'contrast', 'bright', 'levels'].map((k) => p[k])]);
    if (key === this.photoKey) { this.hairShellMat.uniforms.map.value = this.photoTex || this.hairShellMat.uniforms.map.value; return; }
    this.photoKey = key;
    const r = this.hull && perf.time('head.photoHair', () => photoHair(this.hull, hair, p, { hatY }));
    this.hairShell.geometry.dispose();
    this.hairShell.geometry = new THREE.BufferGeometry();
    this.photoTex?.dispose(); this.photoTex = null; this.photoCanvas = null;
    this.hairShell.visible = !!r;
    if (!r) return;
    const g = this.hairShell.geometry;
    g.setAttribute('position', new THREE.BufferAttribute(r.positions, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(r.uv, 2));
    g.setIndex(r.index);
    g.computeVertexNormals(); g.computeBoundingBox(); g.computeBoundingSphere();
    this.photoCanvas = r.canvas;
    this.photoTex = new THREE.CanvasTexture(r.canvas);
    this.photoTex.magFilter = this.photoTex.minFilter = THREE.NearestFilter;
    this.photoTex.name = 'hair';
    this.hairShellMat.uniforms.map.value = this.photoTex;
    this.hairShellMat.side = THREE.DoubleSide; // (the long-hair curtain is seen from inside, behind the neck)
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
      if (Math.abs(a) > 1.4 || nrm.getY(i) > 0.5 || nx * x + nz * z <= 0) continue; // (behind the ear line: from further forward they hung in front of a short neck)
      const b = Math.min(BINS - 1, Math.floor(((a + 1.4) / 2.8) * BINS));
      if (root[b] < 0 || y < pos.getY(root[b])) root[b] = i;
    }
    // the shell's painted color
    const src = this.photo && this.photoCanvas ? this.photoCanvas : this.headCanvas; // (photo hair: its own texture)
    const g = src.getContext('2d', { willReadFrequently: true }), n = src.width, nh = src.height, px = g.getImageData(0, 0, n, nh).data;
    const col = [0, 0, 0];
    let cnt = 0;
    for (let i = 0; i < uv.count; i += 3) {
      const o = (Math.min(nh - 1, Math.max(0, Math.floor((1 - uv.getY(i)) * nh))) * n + Math.min(n - 1, Math.max(0, Math.floor(uv.getX(i) * n)))) * 4;
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
