import * as THREE from 'three';
import { sculptHead, BAND_RINGS } from './headsculpt.js';

import { perf } from './perf.js';
import { unwrap, BodyBaker } from './bodybake.js';
import { paintSkinTile } from './skintile.js';
import { boundaryLoop, stretchT, rayToPolygon } from './stretch.js';

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
    // the head: the face's 468 points plus the band grown from its outline over the whole head (one mesh)
    this.geo = new THREE.BufferGeometry();
    this.band = null;
    this.buildGeo();
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
    this.skinTex = canvasTex(64, 64, () => {}, 1);
    this.hairTex = new THREE.CanvasTexture(document.createElement('canvas'));
    this.hairTex.wrapS = this.hairTex.wrapT = THREE.MirroredRepeatWrapping; // hides the photo patch edges
    this.baker = new BodyBaker(renderer, {
      fragment: HEAD_FRAG,
      uniforms: {
        skinMap: { value: this.skinTex }, hairMap: { value: this.hairTex },
        hairTint: { value: new THREE.Vector3(0, 1, 1) }, hairColor: { value: new THREE.Vector3() }, slick: { value: 0 },
        // headPhoto: the (graded) photo projected onto the skull where it faces the camera and the photo
        // shows skin (segMap); photo uv = affine(ax, ay) of head-local xy + rim residuals (IDW)
        photoOn: { value: 0 }, photoRaw: { value: 0 }, relight: { value: 0 }, sh: { value: new Array(9).fill(0) }, photoMap: { value: null }, segMap: { value: null }, toneOn: { value: 0 }, skinTone: { value: new THREE.Vector3(1, 1, 1) },
        ax: { value: new THREE.Vector3() }, ay: { value: new THREE.Vector3() },
        rimXY: { value: Array.from({ length: 36 }, () => new THREE.Vector2()) }, rimRes: { value: Array.from({ length: 36 }, () => new THREE.Vector2()) },
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

  // extra: { hair: analyzeHair(face) result, skin: [r,g,b] face skin tone (the atlas feather's tone) }
  // Returns null when the head is ready, or a promise that resolves once its sculpt is applied
  // (the previous skull stays on screen meanwhile).
  update(P, tex, p, { hair = null, skin = [0.8, 0.6, 0.5], photo = null, uvW = null, atlas = null } = {}) {
    const uv0 = this.canon.uv;
    const uv = this.geo.attributes.uv.array;
    for (let i = 0; i < 468; i++) uv.set(uv0[i], i * 2);
    this.geo.attributes.uv.needsUpdate = true;
    this.setMask(P);
    this.headMat.uniforms.map.value = tex;
    this.last = { ...(this.last || {}), p, uvW };
    if ((p.headHull ?? 'classic') === 'classic') this.classicBand(P, p); else this.setBandUV(p, uvW, atlas, skin);

    const style = p.hairStyle === 'auto' ? hair?.style || 'short' : p.hairStyle;
    // The skull is sculpted around the mask and pushed behind its surface, so it depends on the whole
    // mask (quantized hash): any face change (grin, nose, eyes...) re-sculpts it (in the worker), or a
    // stale skull shows through the new face. Also skull and hair params.
    let hsh = 0;
    for (const v of P) for (const c of v) hsh = (Math.imul(hsh, 31) + Math.round(c * 400)) | 0;
    const key = JSON.stringify([hsh,
      p.cranium, p.headDepth, p.earSize, p.hairVolume, p.girth, p.headScale, Math.max(0, p.fat), p.clay, style, p.hat]);
    this.last = { P, p, hair, skin, photo, uvW, atlas };
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
    const texKey = JSON.stringify([skin.map((v) => v.toFixed(4)), hairId, p.hairHue, p.hairBright, this.key, p.headMap, !!p.headPhoto, p.headHarmonic !== false, !!p.headSkinPatch, !!p.headPhotoRaw, !!p.headRelight, !!p.headStretch]);
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

  // the face mask: the landmarks, with its outer ring laid onto the sculpted skull (the applied sculpt's
  // maskDz, see snapRim in headsculpt.js): it meets the skull in one smooth outline
  // Geometry of the unified head: face vertices first (landmark indices stay valid), then the band.
  // UVs all point into the face texture: the face its canonical layout, the band see setBandUV.
  buildGeo() {
    const b = this.band, nb = b ? b.positions.length / 3 : 0, n = 468 + nb, uv0 = this.canon.uv;
    const pos = new Float32Array(n * 3), uv = new Float32Array(n * 2), ring = new Float32Array(n);
    for (let i = 0; i < 468; i++) { uv[i * 2] = uv0[i][0]; uv[i * 2 + 1] = uv0[i][1]; }
    if (b) { pos.set(b.positions, 468 * 3); ring.set(b.ring, 468); }
    const g = this.geo;
    for (const k of Object.keys(g.attributes)) g.deleteAttribute(k);
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('ring', new THREE.BufferAttribute(ring, 1));
    g.setIndex(b ? [...this.canon.index, ...b.index] : [...this.canon.index]);
  }

  // The face's own photo texture carried over the whole head: each band ring's UV slides from its outline
  // point toward skin, further with every ring (backUV), jittered. The head wears the person's real skin,
  // stretched along paths through the face, not a flat tone. Each outline point aims at skin it reaches
  // without crossing a feature (forehead from the top, cheeks from the sides, the chin from below: toward
  // one forehead point, the paths from the jaw ran through the mouth, and the neck grew a second mouth or a
  // black hole). The anchors are read where the (warped) texture has them, blended smoothly by angle.
  // Each path also starts at the first real skin along it, not at the face's raw edge: along the jaw and
  // chin that edge is the photo's shadow under the jaw (or neck, background), and stretched over the
  // under-chin it read as a black band. Read from the face texture itself (atlas): the first point at
  // least SKIN_MIN as bright as the person's skin tone, and staying so for a few samples.
  setBandUV(p, uvW, atlas = this.last?.atlas, skin = this.last?.skin) {
    const b = this.band;
    if (!b) return;
    const uv = this.geo.attributes.uv.array, uv0 = this.canon.uv, back = p.backUV ?? 0.55, A = uvW || uv0;
    let lumAt = null;
    if (atlas && skin) {
      const n = atlas.width, d = atlas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, n, n).data;
      lumAt = (u, v) => {
        let s = 0, c = 0;
        for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
          const x = Math.min(n - 1, Math.max(0, Math.floor(u * n) + ox)), y = Math.min(n - 1, Math.max(0, Math.floor((1 - v) * n) + oy)), o = (y * n + x) * 4;
          s += 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2]; c++;
        }
        return s / c / 255;
      };
    }
    const skinLum = skin ? 0.299 * skin[0] + 0.587 * skin[1] + 0.114 * skin[2] : 0;
    const c = [0.5, 0.5], ang = (q) => Math.atan2(q[1] - c[1], q[0] - c[0]);
    const targets = this.loop.map((v) => {
      const th = ang(uv0[v]); let wx = 0, wy = 0, ws = 0;
      for (const a of SKIN_ANCHORS) { let d = Math.abs(ang(uv0[a]) - th); d = Math.min(d, 2 * Math.PI - d); const w = Math.exp(-(d * d) / 0.18); wx += A[a][0] * w; wy += A[a][1] * w; ws += w; }
      return [wx / ws, wy / ws];
    });
    const starts = this.loop.map((v, i) => {
      const r = uv0[v], t = targets[i];
      if (!lumAt) return r;
      const at = (s) => lumAt(r[0] + (t[0] - r[0]) * s, r[1] + (t[1] - r[1]) * s) >= SKIN_MIN * skinLum;
      for (let s = 0; s < 0.9; s += 0.02) if (at(s) && at(s + 0.04) && at(s + 0.08)) return [r[0] + (t[0] - r[0]) * s, r[1] + (t[1] - r[1]) * s];
      return t;
    });
    // Leave the rim fast (whatever sits on it, hairline, beard edge, goggle straps, would be dragged into
    // long streaks over the head) and settle into a small patch of plain skin around the anchor: the path
    // fans out around it by its own angle, so the head wears a smoothly spread copy of that skin.
    const ramp = 1 + 3 * (1 - back); // rings until fully on the skin patch (backUV 1 -> 1 ring, 0 -> 4)
    for (let j = 0; j < b.ring.length; j++) {
      const i = j % b.n, k = Math.round(b.ring[j] * BAND_RINGS), rim = starts[i], t = targets[i];
      const u = Math.min(1, k / ramp), m = u * u * (3 - 2 * u), th = (i / b.n) * Math.PI * 2, rr = PATCH_R * Math.min(1, k / BAND_RINGS + 0.3);
      const skin = [t[0] + Math.cos(th) * rr, t[1] + Math.sin(th) * rr];
      uv[(468 + j) * 2] = rim[0] * (1 - m) + skin[0] * m;
      uv[(468 + j) * 2 + 1] = rim[1] * (1 - m) + skin[1] * m;
    }
    this.geo.attributes.uv.needsUpdate = true;
  }

  // The original head (b18118e): a hull grown from the face's own outline, CLASSIC_K rings shrinking back
  // toward one pole behind the head (slight bulge, cranium lift, head depth), so the head continues the
  // face's contour and the face covers most of what's seen. UVs smear from the outline into skin (backUV),
  // toward the mouth-safe skin anchors instead of one forehead point. One mesh with the face.
  classicBand(P, p) {
    const L = this.loop.length, K = CLASSIC_K, n = 468 + L * (K - 1) + 1;
    const C = [0, (P[10][1] + P[152][1]) / 2 + 0.05, (P[234][2] + P[454][2]) / 2 - 0.08];
    const depth = 0.62 * (1 + p.headDepth * 0.6), cranium = 0.4 + p.cranium * 0.45;
    const pos = new Float32Array(n * 3), uv = new Float32Array(n * 2), uv0 = this.canon.uv, back = p.backUV ?? 0.55;
    for (let i = 0; i < 468; i++) { pos.set(P[i], i * 3); uv.set(uv0[i], i * 2); }
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
        const map = p.headMap ?? 'mirror';
        if (map === 'patch') {
          // projected skin: the head's surface (cylinder around the vertical axis, at face scale) mapped into
          // a mirror-tiled square of the person's own cheek skin; ring 1 blends in from the outline
          const q = [pos[o * 3], pos[o * 3 + 1], pos[o * 3 + 2]], ang2 = Math.atan2(q[0] - C[0], q[2] - C[2]);
          const cu = ang2 * 0.55 * uvPerUnit, cv = (q[1] - C[1]) * uvPerUnit, tri = (x) => { const f = ((x % 4) + 4) % 4; return f < 2 ? f - 1 : 3 - f; };
          const pc = A[50], half = 0.045, pu = pc[0] + half * tri(cu / half), pv = pc[1] + half * tri(cv / half);
          const bl = k === 1 ? 0.5 : 1;
          uv[o * 2] = r0[0] * (1 - bl) + pu * bl; uv[o * 2 + 1] = r0[1] * (1 - bl) + pv * bl;
        } else if (map === 'mirror' || map === 'mirror2') {
          // mirror padding: walk back INTO the face along the (feature-free) rim -> anchor line by the 3D arc
          // length travelled over the hull, 1:1 in texture scale, bouncing between rim and anchor
          const prev = k === 1 ? P[this.loop[i]] : [pos[(o - L) * 3], pos[(o - L) * 3 + 1], pos[(o - L) * 3 + 2]], q = [pos[o * 3], pos[o * 3 + 1], pos[o * 3 + 2]];
          arc[i] = (k === 1 ? 0 : arc[i]) + Math.hypot(q[0] - prev[0], q[1] - prev[1], q[2] - prev[2]);
          const span = Math.hypot(t[0] - r0[0], t[1] - r0[1]) || 1e-6, d = arc[i] * uvPerUnit * (map === 'mirror2' ? 2 : 1) / span;
          const f = d % 2, w = f < 1 ? f : 2 - f; // ping-pong 0..1..0
          uv[o * 2] = r0[0] + (t[0] - r0[0]) * w; uv[o * 2 + 1] = r0[1] + (t[1] - r0[1]) * w;
        } else {
          const m2 = Math.min(1, back * (0.4 + k / K));
          const j = ((Math.sin(i * 12.9898 + k * 78.233) * 43758.5453) % 1) * 0.015;
          uv[o * 2] = r0[0] * (1 - m2) + (t[0] + j) * m2; uv[o * 2 + 1] = r0[1] * (1 - m2) + (t[1] - Math.abs(j)) * m2;
        }
      }
    }
    const pole = n - 1;
    pos.set([C[0], C[1] + cranium * 0.2, C[2] - depth], pole * 3);
    const c = target(this.loop[0]); uv.set(A[151], pole * 2);
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
    const g = this.geo;
    for (const kk of Object.keys(g.attributes)) g.deleteAttribute(kk);
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals(); g.computeBoundingSphere(); g.computeBoundingBox();
  }

  setMask(P) {
    if ((this.last?.p?.headHull ?? 'classic') === 'classic') { if (this.last?.p) this.classicBand(P, this.last.p); return; } // (no params yet: update() builds it)
    const pos = this.geo.attributes.position.array;
    for (let i = 0; i < 468; i++) pos.set(P[i], i * 3);
    this.geo.attributes.position.needsUpdate = true;
    this.geo.computeVertexNormals();
    this.geo.computeBoundingSphere();
    this.geo.computeBoundingBox();
  }

  apply(key, P) {
    const r = this.cache.get(key);
    this.key = key;
    this.band = r.band;
    if ((this.last.p.headHull ?? 'classic') !== 'classic') { this.buildGeo(); this.setBandUV(this.last.p, this.last.uvW); }
    this.setMask(P);
    this.skull.visible = false; // the head is the face's own mesh now; the skull only shapes hair and hats
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
    if (p.headSkinPatch && hair?.skinPatch) skinGrain(this.skinTex.image, hair.skinPatch);
    this.skinTex.needsUpdate = true;
    const u = this.baker.mat.uniforms;
    const photo = this.last.photo;
    u.photoOn.value = p.headPhoto && photo?.tex && hair?.segTex && this.loop.length <= 36 ? 1 : 0;
    u.toneOn.value = 0;
    u.skinTone.value.set(...skin);
    if (p.headStretch && photo?.pixels && photo.center) {
      u.toneOn.value = 1;
      perf.time('head.stretch', () => this.bakeGeo.setAttribute('tone', new THREE.BufferAttribute(stretchTone(this.bakeGeo, this.last.P, this.loop, photo, skin, this.dims), 3)));
    }
    if (u.photoOn.value) {
      u.photoMap.value = photo.tex; u.segMap.value = hair.segTex;
      const P = this.last.P, pts = this.loop.map((i) => [P[i][0], P[i][1]]), uvs = this.loop.map((i) => [photo.lm[i][0], 1 - photo.lm[i][1]]);
      const [ax, ay] = fitAffine(pts, uvs);
      u.ax.value.set(...ax); u.ay.value.set(...ay);
      pts.forEach((q, i) => {
        u.rimXY.value[i].set(q[0], q[1]);
        u.rimRes.value[i].set(uvs[i][0] - (ax[0] * q[0] + ax[1] * q[1] + ax[2]), uvs[i][1] - (ay[0] * q[0] + ay[1] * q[1] + ay[2]));
      });
      u.skinTone.value.set(...skin);
      u.photoRaw.value = p.headPhotoRaw ? 1 : 0;
      u.relight.value = p.headRelight && photo.pixels ? 1 : 0;
      if (u.relight.value) u.sh.value = fitSH(this.geo, photo, this.loop);
      u.toneOn.value = p.headHarmonic !== false && photo.pixels ? 1 : 0;
      if (u.toneOn.value) perf.time('head.harmonic', () => this.bakeGeo.setAttribute('tone', new THREE.BufferAttribute(harmonicTone(this.bakeGeo, u, photo.pixels, hair.segTex, skin, this.dims), 3)));
    }
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

// Harmonic extension of the photo's skin colors over the skull (Laplace on the mesh, Gauss-Seidel): pinned
// where the projected photo shows reliable skin (its color there) and at the bottom of the neck stub (the
// body's tone); every other vertex is the mean of its neighbours. No boundary anywhere: the face's colors
// flow over the head and into the body. Returns per-vertex rgb for the bake geometry.
function harmonicTone(geo, u, pixels, segTex, skin, D) {
  const pos = geo.attributes.position, nrm = geo.attributes.normal, layer = geo.attributes.layer, idx = geo.index.array, n = pos.count;
  // weld by position (charts split vertices)
  const key = new Map(), node = new Int32Array(n);
  for (let i = 0; i < n; i++) { const k = `${Math.round(pos.getX(i) * 1e4)},${Math.round(pos.getY(i) * 1e4)},${Math.round(pos.getZ(i) * 1e4)}`; if (!key.has(k)) key.set(k, key.size); node[i] = key.get(k); }
  const N = key.size, adj = Array.from({ length: N }, () => new Set());
  for (let t = 0; t < idx.length; t += 3) for (let e = 0; e < 3; e++) { const a = node[idx[t + e]], b = node[idx[t + (e + 1) % 3]]; if (a !== b) { adj[a].add(b); adj[b].add(a); } }
  const ax = u.ax.value, ay = u.ay.value, rx = u.rimXY.value, rr = u.rimRes.value;
  const sd = segTex.image, sw = sd.width, sh = sd.height;
  const col = new Float32Array(N * 3), fixed = new Uint8Array(N), acc = new Float32Array(N * 4);
  for (let i = 0; i < n; i++) {
    if (layer.getX(i) > 3.5) continue;
    const m = node[i], x = pos.getX(i), y = pos.getY(i);
    if (y < D.chin - 0.35) { fixed[m] = 2; continue; } // neck stub bottom: the body's tone
    let U = ax.x * x + ax.y * y + ax.z, V = ay.x * x + ay.y * y + ay.z, wx = 0, wy = 0, ws = 0;
    for (let k = 0; k < rx.length; k++) { const dx = x - rx[k].x, dy = y - rx[k].y, q = dx * dx + dy * dy, w = 1 / (q * q + 1e-5); wx += rr[k].x * w; wy += rr[k].y * w; ws += w; }
    U += wx / ws; V += wy / ws;
    if (U < 0 || U > 1 || V < 0 || V > 1 || nrm.getZ(i) < 0.4) continue;
    const seg = sd.data[(Math.min(sh - 1, Math.floor(V * sh)) * sw + Math.min(sw - 1, Math.floor(U * sw))) * 4] / 255;
    if (seg < 0.8 && !u.photoRaw.value) continue;
    let r = 0, g = 0, b = 0; // 5x5 average of the graded photo (its low frequencies)
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const px = Math.min(511, Math.max(0, Math.floor(U * 512) + dx * 2)), py = Math.min(511, Math.max(0, Math.floor(V * 512) + dy * 2)), o = (py * 512 + px) * 4;
      r += pixels[o]; g += pixels[o + 1]; b += pixels[o + 2];
    }
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 6375, skinLum = 0.299 * skin[0] + 0.587 * skin[1] + 0.114 * skin[2];
    if (lum < 0.6 * skinLum && !u.photoRaw.value) continue; // stray hair, not skin
    acc[m * 4] += r / 6375; acc[m * 4 + 1] += g / 6375; acc[m * 4 + 2] += b / 6375; acc[m * 4 + 3]++;
  }
  for (let m = 0; m < N; m++) {
    if (fixed[m] === 2) { col.set(skin, m * 3); continue; }
    if (acc[m * 4 + 3]) { fixed[m] = 1; for (let c = 0; c < 3; c++) col[m * 3 + c] = acc[m * 4 + c] / acc[m * 4 + 3]; }
    else col.set(skin, m * 3);
  }
  const nb = adj.map((s) => [...s]);
  for (let it = 0; it < 400; it++) for (let m = 0; m < N; m++) {
    if (fixed[m] || !nb[m].length) continue;
    let r = 0, g = 0, b = 0;
    for (const k of nb[m]) { r += col[k * 3]; g += col[k * 3 + 1]; b += col[k * 3 + 2]; }
    const q = nb[m].length; col[m * 3] = r / q; col[m * 3 + 1] = g / q; col[m * 3 + 2] = b / q;
  }
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) out.set(col.subarray(node[i] * 3, node[i] * 3 + 3), i * 3);
  return out;
}

// headStretch on the skull: each vertex's radius as a fraction of the face outline (head space, pushed
// outward as the surface turns away from the camera: sides and back are "infinitely far"), eased by
// stretchT, then read from the graded photo at that fraction along the same direction. The face's own
// texture uses the same mapping (atlas), so the photo runs on into the skull, its edge skin stretched.
function stretchTone(geo, P, loop, photo, skin, D) {
  const pos = geo.attributes.position, nrm = geo.attributes.normal, layer = geo.attributes.layer, n = pos.count, out = new Float32Array(n * 3);
  const C = [1, 6, 9, 168], ch = [0, 1].map((k) => C.reduce((s, i) => s + P[i][k], 0) / C.length);
  const polyH = loop.map((i) => [P[i][0], P[i][1]]), polyP = loop.map((i) => [photo.lm[i][0], photo.lm[i][1]]), fc = photo.center, pix = photo.pixels;
  for (let i = 0; i < n; i++) {
    if (layer.getX(i) > 3.5) { out.set(skin, i * 3); continue; }
    const x = pos.getX(i), y = pos.getY(i), dx = x - ch[0], dy = y - ch[1], r = Math.hypot(dx, dy) || 1e-6, dir = [dx / r, dy / r];
    const Rh = rayToPolygon(ch, dir, polyH) || 1, nz = nrm.getZ(i);
    const u = Math.min(1, Math.max(0, (nz + 0.3) / 1.0)), facing = u * u * (3 - 2 * u);
    const t = stretchT(r / Rh / Math.max(0.02, facing));
    const dp = [dir[0], -dir[1]], Rp = rayToPolygon(fc, dp, polyP) || 0.1;
    const U = fc[0] + dp[0] * t * Rp, V = 1 - (fc[1] + dp[1] * t * Rp);
    let cr = 0, cg = 0, cb = 0;
    for (let oy = -2; oy <= 2; oy++) for (let ox = -2; ox <= 2; ox++) {
      const px = Math.min(511, Math.max(0, Math.floor(U * 512) + ox)), py = Math.min(511, Math.max(0, Math.floor(V * 512) + oy)), o = (py * 512 + px) * 4;
      cr += pix[o]; cg += pix[o + 1]; cb += pix[o + 2];
    }
    const col = [cr / 6375, cg / 6375, cb / 6375];
    const w = Math.min(1, Math.max(0, (D.chin - 0.1 - y) / 0.35)); // the neck eases into the body's tone
    for (let k = 0; k < 3; k++) out[i * 3 + k] = col[k] + (skin[k] - col[k]) * w;
  }
  return out;
}

// The photo's lighting as 9 spherical-harmonic coefficients (order 2), fitted by least squares on the face
// mask: its normals against the graded photo's luminance at each landmark. Normalized to mean 1 over the
// face, so it carries light direction and falloff, not brightness (the skin tone already has that).
function fitSH(geo, photo, loop) {
  const nrm = geo.attributes.normal, pix = photo.pixels, M = Array.from({ length: 9 }, () => new Array(9).fill(0)), b = new Array(9).fill(0);
  const basis = (x, y, z) => [1, y, z, x, x * y, y * z, 3 * z * z - 1, x * z, x * x - y * y];
  let mean = 0, cnt = 0;
  const rows = [];
  for (let i = 0; i < 468; i++) {
    const [u, v] = [photo.lm[i][0], 1 - photo.lm[i][1]];
    if (u < 0 || u > 1 || v < 0 || v > 1) continue;
    const px = Math.min(511, Math.floor(u * 512)), py = Math.min(511, Math.floor(v * 512)), o = (py * 512 + px) * 4;
    const L = (0.299 * pix[o] + 0.587 * pix[o + 1] + 0.114 * pix[o + 2]) / 255;
    rows.push([basis(nrm.getX(i), nrm.getY(i), nrm.getZ(i)), L]); mean += L; cnt++;
  }
  mean /= cnt || 1;
  for (const [r, L] of rows) for (let a = 0; a < 9; a++) { b[a] += r[a] * L / mean; for (let c = 0; c < 9; c++) M[a][c] += r[a] * r[c]; }
  for (let a = 0; a < 9; a++) M[a][a] += 0.5; // ridge: the face only sees the front hemisphere
  // Gaussian elimination
  const m = M.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < 9; c++) { let p = c; for (let r = c + 1; r < 9; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r; [m[c], m[p]] = [m[p], m[c]];
    for (let r = 0; r < 9; r++) if (r !== c) { const f = m[r][c] / m[c][c]; for (let k = c; k < 10; k++) m[r][k] -= f * m[c][k]; } }
  return m.map((row, i) => row[9] / row[i]);
}

// skin the band's texture paths aim at: forehead, its sides, cheeks, lower cheeks, chin (below the lip)
const SKIN_ANCHORS = [151, 108, 337, 50, 280, 187, 411, 199];
const CLASSIC_K = 7; // rings of the original hull
const PATCH_R = 0.035; // radius of the skin patch the band settles into (face texture units)
const SKIN_MIN = 0.6; // a band path starts where the face texture is at least this bright relative to the skin tone

// least squares affine map from 2D points to 2D targets: returns rows [a, b, c] for u and v
function fitAffine(pts, uvs) {
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], bu = [0, 0, 0], bv = [0, 0, 0];
  pts.forEach(([x, y], i) => { const r = [x, y, 1]; for (let a = 0; a < 3; a++) { for (let b = 0; b < 3; b++) M[a][b] += r[a] * r[b]; bu[a] += r[a] * uvs[i][0]; bv[a] += r[a] * uvs[i][1]; } });
  const solve = (A, b) => { // 3x3 Gaussian elimination
    const m = A.map((row, i) => [...row, b[i]]);
    for (let c = 0; c < 3; c++) { let p = c; for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r; [m[c], m[p]] = [m[p], m[c]];
      for (let r = 0; r < 3; r++) if (r !== c) { const f = m[r][c] / m[c][c]; for (let k = c; k < 4; k++) m[r][k] -= f * m[c][k]; } }
    return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
  };
  return [solve(M, bu), solve(M, bv)];
}

// the person's real skin grain on the skin tile: the tile's tone times the patch's relative luminance
function skinGrain(tile, patch) {
  const g = tile.getContext('2d'), n = tile.width, t = g.getImageData(0, 0, n, n);
  const pc = document.createElement('canvas'); pc.width = pc.height = n;
  const pg = pc.getContext('2d'); pg.drawImage(patch, 0, 0, n, n);
  const d = pg.getImageData(0, 0, n, n).data;
  let mean = 0; for (let i = 0; i < d.length; i += 4) mean += d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
  mean /= n * n;
  for (let i = 0; i < d.length; i += 4) { const k = Math.min(1.4, Math.max(0.6, (d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11) / (mean || 1))); for (let c = 0; c < 3; c++) t.data[i + c] = Math.min(255, t.data[i + c] * k); }
  g.putImageData(t, 0, 0);
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
uniform float photoOn, toneOn, photoRaw, relight; uniform float sh[9]; uniform vec3 skinTone; uniform sampler2D photoMap, segMap; uniform vec3 ax, ay; uniform vec2 rimXY[36], rimRes[36];
varying vec3 vPos; varying vec3 vNor; varying float vAo; varying float vLayer; varying float vAux; varying vec3 vTone;
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
    // scalp/skull in the face's skin tone (the face's rim fades into this same tone, see atlas FEATHER),
    // stubble where a buzz cut sits, AO behind the ears
    c = tri(skinMap, p, n, 2.2);
    // harmonic base: the photo's colors continued over the whole head (smoothest possible), with the tile's grain
    if (toneOn > .5) c = vTone * c / max(skinTone, vec3(.02));
    // relight: the photo's own lighting (spherical harmonics fitted on the face) on the synthetic skin
    if (relight > .5) {
      float s = sh[0] + sh[1] * n.y + sh[2] * n.z + sh[3] * n.x + sh[4] * n.x * n.y + sh[5] * n.y * n.z + sh[6] * (3. * n.z * n.z - 1.) + sh[7] * n.x * n.z + sh[8] * (n.x * n.x - n.y * n.y);
      c *= clamp(s, .35, 1.6);
    }
    if (photoOn > .5) {
      vec2 uv = vec2(dot(ax, vec3(p.xy, 1.)), dot(ay, vec3(p.xy, 1.)));
      vec2 acc = vec2(0.); float ws = 0.;
      for (int i = 0; i < 36; i++) { vec2 d = p.xy - rimXY[i]; float q = dot(d, d); float w = 1. / (q * q + 1e-5); acc += rimRes[i] * w; ws += w; }
      uv += acc / ws;
      float inImg = step(0., uv.x) * step(uv.x, 1.) * step(0., uv.y) * step(uv.y, 1.);
      vec3 pc = texture2D(photoMap, uv).rgb;
      // skin only: firm segmentation, and nothing much darker than the person's own skin (stray hair)
      float rel = dot(pc, vec3(.299, .587, .114)) / max(dot(skinTone, vec3(.299, .587, .114)), .02);
      float wgt = photoRaw > .5 ? smoothstep(.15, .5, n.z) * inImg // the photo IS the head (Digimask/Cameo style)
        : smoothstep(.2, .55, n.z) * inImg * smoothstep(.55, .9, texture2D(segMap, uv).r) * smoothstep(.45, .7, rel);
      c = mix(c, pc, wgt);
    }
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
