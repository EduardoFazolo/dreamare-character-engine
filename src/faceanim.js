// Face animation: the photo face mesh (MediaPipe's 468-point topology) gets a real mouth and real eyes.
// - The mouth and eyes are sealed in the canonical mesh by the triangles using only their rim vertices
//   (18 across the inner lips, 14 per eye): they're cut out.
// - Behind each eye, an eyeball whose front is textured with the face's own eye (planar-mapped into the
//   face texture), so at rest it looks exactly like the photo, and it can rotate to look around.
// - Behind the lips, a mouth interior (its own 'mouth' material): a dark cavity and teeth strips.
// - Morph targets (relative deltas) built from anatomy, since every vertex knows its facial role:
//   jaw opening (rotation about a jaw pivot, weighted below the lip line), smile, pucker, wide lips,
//   blinks (upper and lower lid rows to a closure line), and eyeball look directions.
// All in head-local units (face width = 1). Pure functions of the face's points.

// Face tracks for a clip: morph weight keyframes by name. Every clip carries every morph (clips animate
// the same track set); idle and walk blink and glance, talk cycles mouth shapes over the idle body.
export function faceKeys(name, duration) {
  const keys = Object.fromEntries(MORPHS.map((m) => [m, [[0, 0], [duration, 0]]]));
  const pulse = (m, t0, up, hold, down, v = 1) => keys[m].push([t0, 0], [t0 + up, v], [t0 + up + hold, v], [t0 + up + hold + down, 0]);
  const blink = (t) => { pulse('eyeBlinkLeft', t, 0.07, 0.05, 0.1); pulse('eyeBlinkRight', t, 0.07, 0.05, 0.1); };
  if (name === 'idle') { blink(1.1); blink(3.15); pulse('eyeLookLeft', 0.35, 0.12, 0.9, 0.15, 0.7); pulse('eyeLookRight', 2.0, 0.12, 0.6, 0.15, 0.6); }
  if (name === 'walk') blink(0.45);
  if (name === 'talk') {
    blink(1.6);
    // visemes, deterministic: [jaw, pucker, wide] every 0.14 s, closed at both ends so the loop is clean
    const V = [[0.55, 0, 0], [0.2, 0, 0.8], [0.3, 0.9, 0], [0.45, 0, 0.3], [0.15, 0.5, 0], [0.6, 0.1, 0], [0.25, 0, 0.6], [0.4, 0.6, 0]];
    const tr = { jawOpen: [[0, 0]], mouthPucker: [[0, 0]], mouthWide: [[0, 0]] };
    let k = 0;
    for (let t = 0.14; t < duration - 0.2; t += 0.14, k++) { const v = V[(k * 5 + (k >> 2)) % V.length]; tr.jawOpen.push([t, v[0]]); tr.mouthPucker.push([t, v[1]]); tr.mouthWide.push([t, v[2]]); }
    for (const m of Object.keys(tr)) { tr[m].push([duration, 0]); keys[m] = tr[m]; }
  }
  // sorted, deduplicated times
  for (const m of MORPHS) { keys[m].sort((a, b) => a[0] - b[0]); keys[m] = keys[m].filter((k, i, a) => i === 0 || k[0] > a[i - 1][0] + 1e-4); }
  return keys;
}

export const MORPHS = ['jawOpen', 'mouthSmile', 'mouthPucker', 'mouthWide', 'eyeBlinkLeft', 'eyeBlinkRight', 'eyeLookUp', 'eyeLookDown', 'eyeLookLeft', 'eyeLookRight'];

const LIP_UP = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308];
const LIP_LO = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308];
// subject's right eye (-x) and left eye (+x): upper lid, lower lid (corners shared)
const EYES = {
  Right: { up: [33, 246, 161, 160, 159, 158, 157, 173, 133], lo: [33, 7, 163, 144, 145, 153, 154, 155, 133] },
  Left: { up: [263, 466, 388, 387, 386, 385, 384, 398, 362], lo: [263, 249, 390, 373, 374, 380, 381, 382, 362] },
};

// 2D bucket grid over triangles (points given by get(i) -> [x, y]): candidates(x, y) are the triangles
// whose bounding box covers the cell of (x, y)
function triGrid(tris, get, N = 32) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const t of tris) for (const i of t) { const [x, y] = get(i); x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const cx = (x) => Math.min(N - 1, Math.max(0, Math.floor(((x - x0) / (x1 - x0 || 1)) * N))), cy = (y) => Math.min(N - 1, Math.max(0, Math.floor(((y - y0) / (y1 - y0 || 1)) * N)));
  const cells = Array.from({ length: N * N }, () => []);
  for (const t of tris) {
    const ps = t.map(get), xs = ps.map((p) => p[0]), ys = ps.map((p) => p[1]);
    for (let j = cy(Math.min(...ys)); j <= cy(Math.max(...ys)); j++) for (let i = cx(Math.min(...xs)); i <= cx(Math.max(...xs)); i++) cells[j * N + i].push(t);
  }
  return (x, y) => cells[cy(y) * N + cx(x)];
}

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// y along a lid/lip line at x (the line's points sorted by x, clamped at its ends)
// (sorted once per face: memoized on the points array and the id list)
const _lines = new WeakMap();
function lineAt(P, ids, x) {
  let m = _lines.get(P);
  if (!m) _lines.set(P, (m = new Map()));
  let pts = m.get(ids);
  if (!pts) m.set(ids, (pts = ids.map((i) => P[i]).sort((a, b) => a[0] - b[0])));
  if (x <= pts[0][0]) return pts[0][1];
  for (let k = 1; k < pts.length; k++) if (x <= pts[k][0]) {
    const a = pts[k - 1], b = pts[k], t = (x - a[0]) / (b[0] - a[0] || 1e-9);
    return a[1] + (b[1] - a[1]) * t;
  }
  return pts[pts.length - 1][1];
}

// the canonical triangles sealing the eyes (cut out) and the mouth (kept as a plate, see buildFaceRig)
export function interiorTriangles(index) {
  const inside = (ring) => { const S = new Set(ring), out = new Set(); for (let t = 0; t < index.length; t += 3) if (S.has(index[t]) && S.has(index[t + 1]) && S.has(index[t + 2])) out.add(t / 3); return out; };
  return { eyes: new Set(Object.values(EYES).flatMap((e) => [...inside([...e.up, ...e.lo])])), mouth: inside([...LIP_UP, ...LIP_LO]) };
}

// least squares affine map (x, y) -> (u, v) from matching point lists
function fitAffine(pts, uvs) {
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], bu = [0, 0, 0], bv = [0, 0, 0];
  pts.forEach(([x, y], i) => { const r = [x, y, 1]; for (let a = 0; a < 3; a++) { for (let b = 0; b < 3; b++) M[a][b] += r[a] * r[b]; bu[a] += r[a] * uvs[i][0]; bv[a] += r[a] * uvs[i][1]; } });
  const solve = (A, b) => {
    const m = A.map((row, i) => [...row, b[i]]);
    for (let c = 0; c < 3; c++) {
      let p = c; for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
      [m[c], m[p]] = [m[p], m[c]];
      for (let r = 0; r < 3; r++) if (r !== c) { const f = m[r][c] / m[c][c]; for (let k = c; k < 4; k++) m[r][k] -= f * m[c][k]; }
    }
    return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
  };
  const a = solve(M, bu), b = solve(M, bv);
  return (x, y) => [a[0] * x + a[1] * y + a[2], b[0] * x + b[1] * y + b[2]];
}

// The texture warps move where the mouth and eyes are drawn (uvW), but the mesh maps the canonical UVs:
// cut at the photo's own lip line, the jaw opened through the wrong part of the texture (a second mouth).
// So the lip and eye rims move, along the face's surface, to where the texture draws them: each rim vertex
// goes to the surface point whose canonical UV is its landmark's drawn position, neighbours follow with a
// smooth falloff, and every moved vertex takes the UV of where it now sits. At rest the face looks the same;
// the mouth and eyes now open exactly along the drawn lips and eyes. Returns new positions and UVs.
const RIMS = [...LIP_UP, ...LIP_LO, ...Object.values(EYES).flatMap((e) => [...e.up, ...e.lo])];
export function alignToTexture(P, uv0, uvW, index, outline) {
  const rim = [...new Set(RIMS)], fixed = new Set(outline);
  const D = rim.map((i) => [uvW[i][0] - uv0[i][0], uvW[i][1] - uv0[i][1]]);
  const R = 0.045; // falloff radius in texture units
  const tri = [];
  for (let t = 0; t < index.length; t += 3) tri.push([index[t], index[t + 1], index[t + 2]]);
  const grid = triGrid(tri, (i) => uv0[i]);
  const locate = (u) => { // surface point at canonical texture position u (grid first, all triangles if outside)
    let best = null, bd = Infinity;
    const scan = (list) => { for (const [a, b, c] of list) {
      const A = uv0[a], B = uv0[b], C = uv0[c], den = (B[1] - C[1]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[1] - C[1]);
      if (Math.abs(den) < 1e-12) continue;
      const l1 = ((B[1] - C[1]) * (u[0] - C[0]) + (C[0] - B[0]) * (u[1] - C[1])) / den, l2 = ((C[1] - A[1]) * (u[0] - C[0]) + (A[0] - C[0]) * (u[1] - C[1])) / den, l3 = 1 - l1 - l2;
      const out = Math.max(0, -l1) + Math.max(0, -l2) + Math.max(0, -l3);
      if (out < bd) { bd = out; best = [a, b, c, Math.max(0, l1), Math.max(0, l2), Math.max(0, l3)]; }
      if (out === 0) return;
    } };
    scan(grid(u[0], u[1]));
    if (bd > 0) scan(tri);
    const [a, b, c, w1, w2, w3] = best, s = w1 + w2 + w3;
    return [0, 1, 2].map((k) => (P[a][k] * w1 + P[b][k] * w2 + P[c][k] * w3) / s);
  };
  const Pn = P.map((v) => v.slice()), Un = uv0.map((v) => v.slice());
  for (let v = 0; v < P.length; v++) {
    if (fixed.has(v)) continue;
    let d;
    const k = rim.indexOf(v);
    if (k >= 0) d = D[k];
    else {
      let sx = 0, sy = 0, ws = 0, wmax = 0;
      rim.forEach((i, j) => { const r = Math.hypot(uv0[v][0] - uv0[i][0], uv0[v][1] - uv0[i][1]), w = Math.exp(-((r / R) ** 2)); sx += D[j][0] * w; sy += D[j][1] * w; ws += w; wmax = Math.max(wmax, w); });
      if (wmax < 1e-3) continue;
      d = [(sx / ws) * wmax, (sy / ws) * wmax];
    }
    if (Math.hypot(d[0], d[1]) < 1e-5) continue;
    const u = [uv0[v][0] + d[0], uv0[v][1] + d[1]];
    Pn[v] = locate(u); Un[v] = u;
  }
  return { P: Pn, uv: Un };
}

// Face measurements every morph uses
function frame(P) {
  const cx = (P[78][0] + P[308][0]) / 2, cornerX = Math.abs(P[308][0] - P[78][0]) / 2;
  const mid = (x) => { const xc = Math.min(P[308][0], Math.max(P[78][0], x)); return (lineAt(P, LIP_UP, xc) + lineAt(P, LIP_LO, xc)) / 2; };
  const eyeY = (P[33][1] + P[263][1]) / 2, sideZ = (P[234][2] + P[454][2]) / 2;
  const pivot = [0, eyeY - 0.18, sideZ - 0.3]; // jaw hinge: in front of the ear, below eye level
  return { cx, cornerX, mid, pivot, mouthZ: Math.min(P[13][2], P[14][2]) };
}

// How much a point follows the jaw: 1 below the lip line (hard split inside the mouth, where the mesh is
// cut; soft over the cheeks outside it), fading out sideways past the mouth, and only in front of the hinge
function jawWeight(F, x, y, z) {
  const ax = Math.abs(x - F.cx), m = F.mid(x);
  const below = ax < F.cornerX ? (y < m ? 1 : 0) : smooth(0, 0.06, m - y);
  const lat = 1 - smooth(F.cornerX * 1.3, F.cornerX * 2.8, ax);
  return below * lat * smooth(F.pivot[2], F.pivot[2] + 0.25, z);
}

const JAW_ANGLE = 0.3;
function jawDelta(F, p, w) {
  const dy = p[1] - F.pivot[1], dz = p[2] - F.pivot[2], a = JAW_ANGLE * w, c = Math.cos(a), s = Math.sin(a);
  return [0, F.pivot[1] + dy * c - dz * s - p[1], F.pivot[2] + dy * s + dz * c - p[2]];
}

// Eyeball: a low-poly sphere cap behind the eye opening, front textured with the face's eye
function eyeball(P, uv0, eye) {
  const ring = [...new Set([...eye.up, ...eye.lo])], n = ring.length;
  const c = [0, 1, 2].map((k) => ring.reduce((s, i) => s + P[i][k], 0) / n);
  const R = Math.max(...ring.map((i) => Math.hypot(P[i][0] - c[0], P[i][1] - c[1]))) * 1.2;
  const zFront = Math.max(...ring.map((i) => P[i][2])) - 0.012;
  const center = [c[0], c[1], zFront - R];
  const fit = fitAffine(ring.map((i) => [P[i][0], P[i][1]]), ring.map((i) => uv0[i]));
  // texture read inside the opening only (an ellipse at 80% of the eye's half width/height): rotating the
  // eyeball then slides eye white and corners into view, never the lashes or lid skin around the eye
  const ha = Math.max(...ring.map((i) => Math.abs(P[i][0] - c[0]))), hb = Math.max(...ring.map((i) => Math.abs(P[i][1] - c[1])));
  const toUV = (x, y) => { const dx = x - c[0], dy = y - c[1], e = Math.hypot(dx / ha, dy / hb), k = e > 0.8 ? 0.8 / e : 1; return fit(c[0] + dx * k, c[1] + dy * k); };
  const pos = [], uv = [], idx = [], RINGS = 6, SEG = 14, MAXT = (110 * Math.PI) / 180;
  pos.push(center[0], center[1], center[2] + R); uv.push(...toUV(center[0], center[1]));
  for (let r = 1; r <= RINGS; r++) {
    const th = (r / RINGS) * MAXT;
    for (let s = 0; s < SEG; s++) {
      const ph = (s / SEG) * Math.PI * 2, x = center[0] + R * Math.sin(th) * Math.cos(ph), y = center[1] + R * Math.sin(th) * Math.sin(ph);
      pos.push(x, y, center[2] + R * Math.cos(th));
      const q = toUV(x, y); uv.push(Math.min(1, Math.max(0, q[0])), Math.min(1, Math.max(0, q[1])));
    }
  }
  const at = (r, s) => (r === 0 ? 0 : 1 + (r - 1) * SEG + (s % SEG));
  for (let s = 0; s < SEG; s++) idx.push(0, at(1, s), at(1, s + 1));
  for (let r = 1; r < RINGS; r++) for (let s = 0; s < SEG; s++) idx.push(at(r, s), at(r + 1, s), at(r + 1, s + 1), at(r, s), at(r + 1, s + 1), at(r, s + 1));
  return { pos, uv, idx, center, R };
}

// Mouth interior in the 'mouth' material's texture: v 0..0.5 cavity, 0.5..0.75 lower teeth, 0.75..1 upper
function mouthInterior(P, F) {
  const pos = [], uv = [], idx = [], jaw = [];
  const quad = (x0, x1, y0, y1, z, back, v0, v1, jw, NX = 6, NY = 3) => {
    const base = pos.length / 3, half = (x1 - x0) / 2, xc = (x0 + x1) / 2;
    for (let j = 0; j <= NY; j++) for (let i = 0; i <= NX; i++) {
      const x = x0 + ((x1 - x0) * i) / NX, y = y0 + ((y1 - y0) * j) / NY, d = (x - xc) / half;
      pos.push(x, y, z - back * d * d);
      uv.push(i / NX, v0 + ((v1 - v0) * j) / NY);
      jaw.push(jw === null ? (y < F.mid(x) ? 1 : 0) : jw);
    }
    for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
      const a = base + j * (NX + 1) + i, b = a + 1, c = a + NX + 1, d2 = c + 1;
      idx.push(a, b, d2, a, d2, c);
    }
  };
  const m0 = F.mid(F.cx), w = F.cornerX;
  // The mouth bag: its rim IS the inner lip line (upper half fixed, lower half following the jaw, exactly
  // like the lips), and it narrows backward into the head in BAG_RINGS rings. Whatever the jaw opens is
  // sealed by construction: no gap at the corners to see through to the background.
  const lip = [...LIP_UP, ...LIP_LO.slice(1, -1).reverse()], L = lip.length, BAG_RINGS = 4, depth = 0.13;
  const bagBase = pos.length / 3, cz = F.mouthZ - depth, cyy = m0 - 0.02;
  for (let r = 0; r <= BAG_RINGS; r++) {
    const t = r / BAG_RINGS, shrink = 1 - 0.75 * t * t;
    lip.forEach((i, k) => {
      const p = P[i], lower = k > LIP_UP.length - 1; // (corners 78/308 belong to the upper half)
      pos.push(F.cx + (p[0] - F.cx) * shrink, cyy + (p[1] - cyy) * shrink, p[2] - 0.003 + (cz - p[2]) * t);
      uv.push(k / L, 0.45 * (1 - t));
      jaw.push(lower ? 1 - 0.5 * t : 0); // (the back of the bag follows the jaw halfway)
    });
  }
  for (let r = 0; r < BAG_RINGS; r++) for (let k = 0; k < L; k++) {
    const a = bagBase + r * L + k, b = bagBase + r * L + ((k + 1) % L), c = a + L, d = b + L;
    idx.push(a, c, d, a, d, b);
  }
  // closed at the back (a cap fanned from its center), or the neck shows through the open mouth
  const cap = pos.length / 3, last = bagBase + BAG_RINGS * L;
  pos.push(F.cx, cyy, cz - 0.01); uv.push(0.5, 0); jaw.push(0.5);
  for (let k = 0; k < L; k++) idx.push(last + k, cap, last + ((k + 1) % L));
  // teeth, just behind the lips
  quad(F.cx - w * 0.8, F.cx + w * 0.8, m0 + 0.004, m0 + 0.045, F.mouthZ - 0.022, 0.05, 0.75, 1, 0, 14, 3);
  quad(F.cx - w * 0.75, F.cx + w * 0.75, m0 - 0.045, m0 - 0.004, F.mouthZ - 0.026, 0.05, 0.5, 0.75, 1, 14, 3);
  return { pos, uv, idx, jaw };
}

// Keep the mouth interior behind the face: every vertex goes at least `gap` behind the face surface in
// front of it (the face as a height field seen from the front, lips and mouth plate included), so the
// teeth and cavity can never poke through the lips or cheeks whatever the face's shape.
// (a vertex outside the face's silhouette, with nothing in front to hide behind, first slides toward the
// mouth's center until the face covers it)
function behindFace(pts, P, faceTris, gap, center) {
  const grid = triGrid(faceTris, (i) => P[i]);
  const frontAt = (x, y) => {
    let front = -Infinity;
    for (const [a, b, c] of grid(x, y)) {
      const A = P[a], B = P[b], C = P[c], den = (B[1] - C[1]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[1] - C[1]);
      if (Math.abs(den) < 1e-12) continue;
      const l1 = ((B[1] - C[1]) * (x - C[0]) + (C[0] - B[0]) * (y - C[1])) / den, l2 = ((C[1] - A[1]) * (x - C[0]) + (A[0] - C[0]) * (y - C[1])) / den, l3 = 1 - l1 - l2;
      if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
      front = Math.max(front, l1 * A[2] + l2 * B[2] + l3 * C[2]);
    }
    return front;
  };
  for (let v = 0; v < pts.length; v += 3) {
    let x = pts[v], y = pts[v + 1], front = frontAt(x, y);
    for (let t = 0.1; front === -Infinity && t <= 1.001; t += 0.1) {
      x = pts[v] + (center[0] - pts[v]) * t; y = pts[v + 1] + (center[1] - pts[v + 1]) * t; front = frontAt(x, y);
    }
    if (front === -Infinity) continue;
    pts[v] = x; pts[v + 1] = y; pts[v + 2] = Math.min(pts[v + 2], front - gap);
  }
}

// Deltas for every morph over a vertex set. kind: per-vertex tag ('face', 'eyeR', 'eyeL', 'mouth')
function deltas(P, F, pts, kinds, jawW, eyes) {
  const n = pts.length / 3, out = Object.fromEntries(MORPHS.map((m) => [m, new Float32Array(n * 3)]));
  const corners = [P[61], P[291]], cy = F.mid(F.cx);
  for (let v = 0; v < n; v++) {
    const p = [pts[v * 3], pts[v * 3 + 1], pts[v * 3 + 2]], kind = kinds[v];
    const set = (m, d, k = 1) => { out[m][v * 3] += d[0] * k; out[m][v * 3 + 1] += d[1] * k; out[m][v * 3 + 2] += d[2] * k; };
    // jaw
    const jw = jawW ? jawW[v] : jawWeight(F, ...p);
    if (jw > 0) set('jawOpen', jawDelta(F, p, jw));
    if (kind === 'face' || kind === 'plate') {
      // smile / wide: the mouth corners pulled up and out (smile) or straight out (wide), with falloff
      corners.forEach((c, i) => {
        const sx = i === 0 ? -1 : 1, d2 = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2, f = Math.exp(-d2 / (0.075 * 0.075));
        set('mouthSmile', [0.03 * sx, 0.035, -0.012], f);
        set('mouthWide', [0.035 * sx, 0.004, -0.006], f);
      });
      // pucker: lips gathered toward the middle and pushed forward
      const dx = p[0] - F.cx, dy = p[1] - cy, f = Math.exp(-((dx / (F.cornerX * 1.25)) ** 2 + (dy / 0.075) ** 2));
      set('mouthPucker', [-dx * 0.4, -dy * 0.15, 0.035], f);
      // blinks: the lid rows move to a closure line, the upper lid carrying the skin above it along
      for (const [side, e] of Object.entries(eyes)) {
        const xs = [...e.up, ...e.lo].map((i) => P[i][0]), x0 = Math.min(...xs), x1 = Math.max(...xs);
        if (p[0] < x0 - 0.02 || p[0] > x1 + 0.02) continue;
        const up = lineAt(P, e.up, p[0]), lo = lineAt(P, e.lo, p[0]), close = lo + 0.3 * (up - lo);
        const along = Math.sin(Math.PI * Math.min(1, Math.max(0, (p[0] - x0) / (x1 - x0)))); // corners stay put
        const H = (up - lo) * 1.1 + 0.03;
        let dy2 = 0;
        if (p[1] >= up - 1e-4 && p[1] <= up + H) dy2 = (close - up) * (1 - smooth(0, H, p[1] - up));
        else if (p[1] <= lo + 1e-4 && p[1] >= lo - 0.035) dy2 = (close - lo) * (1 - smooth(0, 0.035, lo - p[1]));
        if (dy2) set('eyeBlink' + side, [0, dy2 * along, 0.004 * along]);
      }
    } else if (kind === 'eyeR' || kind === 'eyeL') {
      // eyeball look directions: rotation about its center (up/down about x, left/right about y)
      const e = kind === 'eyeR' ? eyes.Right.ball : eyes.Left.ball, q = [p[0] - e.center[0], p[1] - e.center[1], p[2] - e.center[2]];
      const rotX = (a) => [0, q[1] * Math.cos(a) - q[2] * Math.sin(a) - q[1], q[1] * Math.sin(a) + q[2] * Math.cos(a) - q[2]];
      const rotY = (a) => [q[0] * Math.cos(a) + q[2] * Math.sin(a) - q[0], 0, -q[0] * Math.sin(a) + q[2] * Math.cos(a) - q[2]];
      set('eyeLookUp', rotX(-0.32)); set('eyeLookDown', rotX(0.32));
      set('eyeLookLeft', rotY(0.4)); set('eyeLookRight', rotY(-0.4));
    }
  }
  return out;
}

// The whole face rig for one face. faceCount: vertices of the head mesh already present (face + hull,
// positions `headPos`); returns what to append to the head mesh (eyeballs), the mouth mesh, the cut and
// morph deltas for both meshes.
export function buildFaceRig(P, uv0, index, headPos) {
  const F = frame(P);
  const eyes = { Right: { ...EYES.Right, ball: eyeball(P, uv0, EYES.Right) }, Left: { ...EYES.Left, ball: eyeball(P, uv0, EYES.Left) } };
  const nHead = headPos.length / 3, inner = interiorTriangles(index);
  const extraPos = [], extraUV = [], extraIdx = [], kinds = new Array(nHead).fill('face');
  // The mouth plate: the triangles between the lips stay, carrying the photo's own mouth (its teeth, painted
  // teeth...), attached to the upper lip: their lower-lip vertices are duplicated and never follow the jaw.
  // At rest the face is exactly the texture (one mouth); the jaw opens a gap below the plate onto the
  // cavity and lower teeth. (Deleting them left a second, synthetic mouth wherever the photo's lips part.)
  const dup = new Map();
  for (const i of LIP_LO.filter((i) => i !== 78 && i !== 308)) {
    dup.set(i, nHead + extraPos.length / 3);
    extraPos.push(P[i][0], P[i][1], P[i][2]); extraUV.push(...uv0[i]); kinds.push('plate');
  }
  for (const t of inner.mouth) extraIdx.push(...[index[t * 3], index[t * 3 + 1], index[t * 3 + 2]].map((v) => dup.get(v) ?? v));
  // eyeballs appended to the head mesh (same 'face' material and texture)
  for (const [side, tag] of [['Right', 'eyeR'], ['Left', 'eyeL']]) {
    const b = eyes[side].ball, base = nHead + extraPos.length / 3;
    extraPos.push(...b.pos); extraUV.push(...b.uv); extraIdx.push(...b.idx.map((i) => i + base));
    for (let i = 0; i < b.pos.length / 3; i++) kinds.push(tag);
  }
  const allHead = new Float32Array(headPos.length + extraPos.length);
  allHead.set(headPos); allHead.set(extraPos, headPos.length);
  const headMorphs = deltas(P, F, allHead, kinds, null, eyes);
  // eyeballs and the mouth plate never follow the jaw
  for (let v = nHead; v < kinds.length; v++) headMorphs.jawOpen.fill(0, v * 3, v * 3 + 3);
  const mouth = mouthInterior(P, F);
  const faceTris = [];
  for (let t = 0; t < index.length; t += 3) faceTris.push([index[t], index[t + 1], index[t + 2]]);
  behindFace(mouth.pos, P, faceTris, 0.018, [F.cx, F.mid(F.cx)]);
  const mouthMorphs = deltas(P, F, mouth.pos, new Array(mouth.pos.length / 3).fill('mouth'), mouth.jaw, eyes);
  return { cut: new Set([...inner.eyes, ...inner.mouth]), extra: { pos: extraPos, uv: extraUV, idx: extraIdx }, headMorphs, mouth, mouthMorphs };
}

// the mouth material's texture: dark cavity (bottom half), lower and upper teeth strips (PS2-ish, yellowed)
export function drawMouth(g, w, h) {
  const cav = g.createLinearGradient(0, h / 2, 0, h);
  cav.addColorStop(0, '#2a0c0e'); cav.addColorStop(1, '#070203');
  g.fillStyle = cav; g.fillRect(0, h / 2, w, h / 2);
  const teeth = (y0, y1, gumTop) => {
    g.fillStyle = '#5a1c1e'; g.fillRect(0, y0, w, y1 - y0);
    const n = 8, tw = w / n;
    for (let i = 0; i < n; i++) {
      const edge = Math.abs(i - (n - 1) / 2) / ((n - 1) / 2), shade = 200 - edge * 70;
      g.fillStyle = `rgb(${shade},${shade * 0.93},${shade * 0.68})`;
      const gum = (y1 - y0) * 0.22;
      g.fillRect(i * tw + 1, gumTop ? y0 + gum : y0, tw - 2, y1 - y0 - gum);
    }
  };
  teeth(0, h / 4, true);        // upper teeth (v 0.75..1 is the top of the canvas)
  teeth(h / 4, h / 2, false);   // lower teeth
}
