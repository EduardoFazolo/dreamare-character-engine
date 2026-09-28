// Animal faces: real animal photos worn like the human ones. MediaPipe can't find an animal's face, so each
// photo carries a few hand-placed points (public/animals/index.json: canonical landmark index -> [x, y] in
// the photo, 0..1, y down): eye corners, nose tip, mouth corners and lips, chin, forehead top, head sides.
// A thin-plate spline from those points on the canonical face to the same points on the photo places all
// 468 landmarks, and from there it is an ordinary face: the atlas unwraps the photo, the head hull wears it,
// mutations apply. The face is a flatter plate than a human's, with the animal's muzzle pushed forward
// (animalShape) and its own ears cut from the photo (head.js buildEars); no hair (the hull wears a patch
// of the animal's brow fur).
import * as THREE from 'three';
import { normalizeFace } from './face.js';

// thin-plate spline R^2 -> R^2 through (src[i] -> dst[i])
function tps(src, dst) {
  const n = src.length, N = n + 3, U = (r2) => (r2 < 1e-12 ? 0 : r2 * Math.log(r2));
  const A = Array.from({ length: N }, () => new Float64Array(N));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) A[i][j] = U((src[i][0] - src[j][0]) ** 2 + (src[i][1] - src[j][1]) ** 2);
    A[i][n] = A[n][i] = 1; A[i][n + 1] = A[n + 1][i] = src[i][0]; A[i][n + 2] = A[n + 2][i] = src[i][1];
  }
  const solve = (b) => { // Gaussian elimination with partial pivoting
    const M = A.map((r, i) => [...r, b[i]]);
    for (let c = 0; c < N; c++) {
      let p = c; for (let r = c + 1; r < N; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      [M[c], M[p]] = [M[p], M[c]];
      for (let r = 0; r < N; r++) { if (r === c || !M[c][c]) continue; const f = M[r][c] / M[c][c]; for (let k = c; k <= N; k++) M[r][k] -= f * M[c][k]; }
    }
    return M.map((r, i) => r[N] / (r[i] || 1));
  };
  const wx = solve([...dst.map((d) => d[0]), 0, 0, 0]), wy = solve([...dst.map((d) => d[1]), 0, 0, 0]);
  return ([x, y]) => {
    let u = wx[n] + wx[n + 1] * x + wx[n + 2] * y, v = wy[n] + wy[n + 1] * x + wy[n + 2] * y;
    for (let i = 0; i < n; i++) { const k = U((x - src[i][0]) ** 2 + (y - src[i][1]) ** 2); u += wx[i] * k; v += wy[i] * k; }
    return [u, v];
  };
}

const FLAT = 0.45;

// def: { name, file, points: { idx: [x, y] }, muzzle, muzzleR, ears: [[inner base, outer base, tip] x2] }
export function makeAnimalFace(img, def, canon) {
  const keys = Object.keys(def.points).map(Number);
  // canonical face (y up) -> photo (y down)
  const f = tps(keys.map((i) => [canon.pos[i][0], canon.pos[i][1]]), keys.map((i) => def.points[i]));
  const lm = canon.pos.map((p) => [...f(p), 0]);
  const aspect = img.naturalHeight / img.naturalWidth;
  const flat = normalizeFace(lm.map(([x, y]) => [x, -y * aspect, 0]));
  // flatter than a human face: a front photo has nothing for the sides, so the face stays a front plate and
  // the hull's fur takes the sides (at human depth the face's edges turned sideways, showing its thin rim
  // stretched into streaks); the muzzle comes back in animalShape
  const zc = canon.pos[1][2];
  const geo = flat.map((g, i) => [g[0], g[1], zc + (canon.pos[i][2] - zc) * FLAT]);
  const tex = new THREE.Texture(img); tex.needsUpdate = true;
  // texture layout: the photo's own proportions (the human canonical layout stretched the narrow strip
  // between an animal's eye and the edge of its head across a human cheek), fitted into the square
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of lm) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y * aspect); y1 = Math.max(y1, y * aspect); }
  const sc = 0.92 / Math.max(x1 - x0, y1 - y0), ox = 0.5 - ((x0 + x1) / 2) * sc, oy = 0.5 - ((y0 + y1) / 2) * sc;
  const uv = lm.map(([x, y]) => [ox + x * sc, 1 - (oy + y * aspect * sc)]);
  const face = { name: def.name, img, lm, geo, tex, uv, skin: sampleSkin(img, lm), animal: def };
  // no hair: the segmenter is for people (and the hull's mirrored fur covers the head)
  face.hair = { style: 'bald', color: face.skin, canvas: Object.assign(document.createElement('canvas'), { width: 4, height: 4 }), cover: {}, mask: null };
  face.fitted = geo; // (the animal's own proportions on canonical depth already)
  // the ears, in the same normalized space as geo (normalizeFace's transform, applied to the ear points)
  const F = lm.map(([x, y]) => [x, -y * aspect]), W = Math.hypot(F[454][0] - F[234][0], F[454][1] - F[234][1]);
  const cx = (F[234][0] + F[454][0]) / 2, cy = (F[10][1] + F[152][1]) / 2, toGeo = ([x, y]) => [(x - cx) / W, (-y * aspect - cy) / W];
  face.ears = (def.ears || []).map((e) => ({ photo: e, geo: e.map(toGeo) }));
  return face;
}

function sampleSkin(img, lm) {
  const c = Object.assign(document.createElement('canvas'), { width: img.naturalWidth, height: img.naturalHeight }), g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  const px = [];
  for (const i of [151, 50, 280, 205, 425, 9, 108, 337]) {
    const d = g.getImageData(Math.round(lm[i][0] * c.width) - 3, Math.round(lm[i][1] * c.height) - 3, 7, 7).data;
    for (let k = 0; k < d.length; k += 4) px.push([d[k] / 255, d[k + 1] / 255, d[k + 2] / 255]);
  }
  px.sort((a, b) => a[0] + a[1] + a[2] - (b[0] + b[1] + b[2])); // median-ish: the middle half
  const mid = px.slice(px.length >> 2, (px.length * 3) >> 2);
  return [0, 1, 2].map((k) => mid.reduce((s, p) => s + p[k], 0) / mid.length);
}

// The muzzle: the nose / mouth region pushed forward and narrowed (a soft ellipse around the point between
// the nose tip and the mouth, a little taller than wide), by the animal's own amount, varied by the Snout
// mutation. P: the deformed head points (head units); returns new points.
export function animalShape(P, def, p) {
  const len = (def.muzzle || 0) * Math.max(0.2, 1 + 0.6 * (p.snout || 0)), r = def.muzzleR || 0.3;
  if (!len) return P;
  const c = [(P[1][0] + P[13][0]) / 2, (P[1][1] + P[13][1]) / 2];
  return P.map(([x, y, z]) => {
    const d2 = ((x - c[0]) / r) ** 2 + ((y - c[1]) / (r * 1.25)) ** 2, w = Math.exp(-d2 * 1.6);
    return [c[0] + (x - c[0]) * (1 - 0.22 * w), y, z + len * w];
  });
}

export async function loadAnimals(canon, loadImage) {
  const out = new Map();
  let defs = [];
  try { defs = await (await fetch('/animals/index.json')).json(); } catch { return out; }
  for (const def of defs) {
    if (!def.points || Object.keys(def.points).length < 6) continue;
    try { out.set(def.name, makeAnimalFace(await loadImage(`/animals/${def.file}`), def, canon)); } catch (e) { console.warn('animal', def.name, e); }
  }
  return out;
}
