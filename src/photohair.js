// Photo hair: the person's own hair, cut out of their photo and worn as a shell over the head hull
// (head.js buildHead), the way the face wears its photo. No invented hairstyles: where the photo has hair
// around the face, the shell has hair, as thick as the photo shows it; where it doesn't (a bald crown,
// a receding hairline), the hull's own mirrored skin shows through. The back of the head, which no photo
// shows, continues the hair of the same direction (the crown from the top, the nape from the sides).
//
// Measuring: for each point of the face's outline, a ray from the head's centre out through it in the
// photo. Along it, the hair segmenter's mask gives where hair starts (a: skin of a high forehead before it)
// and where it ends (b: the hair's silhouette), in head units (face width = 1).
// Texture: a crop of the photo around the head, non-hair pixels filled from the nearest hair (so nothing
// of the background bleeds in). Each shell vertex samples the photo along its outline point's ray,
// travelling 1:1 with the distance walked over the head and bouncing inside the hair band, so strands run
// away from the face as they would.
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const pingpong = (x, span) => { const f = (x / span) % 2; return (f < 1 ? f : 2 - f) * span; };

// hull: { pos (face 468 + rings + pole, head units), L, K, C, loop }; hair: analyzeHair() (mask, w, h, px, lm)
// Returns { positions, normals, uv, index, canvas } or null (no hair in the photo: bald).
export function photoHair(hull, hair, p, { hatY = Infinity } = {}) {
  if (!hair?.mask) return null;
  const { pos, L, K, C, loop } = hull, { mask, w, h, px, lm } = hair;
  const X = (j) => lm[j][0] * w, Y = (j) => lm[j][1] * h;
  const fw = Math.hypot(X(454) - X(234), Y(454) - Y(234)); // photo pixels per head unit
  const cx = (X(234) + X(454)) / 2, cy = (Y(10) + Y(152)) / 2 - 0.05 * fw; // the hull's centre C, in the photo
  const V = (k, i) => (k === 0 ? loop[((i % L) + L) % L] : 468 + (k - 1) * L + (((i % L) + L) % L));
  const pole = 468 + (K - 1) * L;
  const at = (v) => [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]];

  // ---- the hair band along each outline point's ray ----
  let band = loop.map((j) => {
    const ox = X(j), oy = Y(j), l = Math.hypot(ox - cx, oy - cy) || 1, dx = (ox - cx) / l, dy = (oy - cy) / l;
    const gapMax = Math.max(2, 0.03 * fw);
    let a = -1, b = -1, gap = 0, clipped = false;
    for (let t = 0; t < fw; t++) {
      const x = ox + dx * t, y = oy + dy * t;
      if (x < 0 || y < 0 || x >= w || y >= h) { clipped = a >= 0 && gap === 0; break; }
      const hh = mask[(y | 0) * w + (x | 0)] === 1;
      if (a < 0) { if (hh) a = b = t; else if (t > 0.35 * fw) break; } else if (hh) { b = t; gap = 0; } else if (++gap > gapMax) break;
    }
    // hair running out of the frame keeps going: at least a fifth of a face past where it starts
    const A = a < 0 ? 0 : a / fw, B = a < 0 ? 0 : clipped ? Math.max(b / fw, A + 0.2) : b / fw;
    return { ox, oy, dx, dy, a: A, b: B };
  });
  // photo noise (a stray lock, a gap in the mask): circular median of 5
  const med = (arr, f) => arr.map((_, i) => { const s = [-2, -1, 0, 1, 2].map((d) => f(arr[(i + d + L) % L])).sort((x, y) => x - y); return s[2]; });
  const A5 = med(band, (q) => q.a), B5 = med(band, (q) => q.b);
  band = band.map((q, i) => ({ ...q, a: A5[i], b: B5[i], has: B5[i] - A5[i] > 0.035 }));
  if (!band.some((q) => q.has)) return null;

  // ---- the hull as columns: each outline point's path back over the head (rings 0..K-1, then the pole) ----
  const Cx = C[0], Cy = C[1];
  const earY = at(234)[1];
  let iL = 0, iR = 0; // the outline's extremes: the sides of the head, at ear height
  for (let i = 0; i < L; i++) { const x = at(loop[i])[0]; if (x < at(loop[iL])[0]) iL = i; if (x > at(loop[iR])[0]) iR = i; }
  const lower = loop.map((j) => at(j)[1] < earY);
  const side = (i) => (at(loop[i])[0] < 0 ? iL : iR);
  const vid = (k, i) => (k >= K ? pole : V(k, i));
  // the hull's outward normal at a vertex; near the face never forward (hair can't creep over it)
  const hullNormal = (k, i) => {
    const q = at(vid(k, i));
    if (k >= K) { const d = [q[0] - C[0], q[1] - C[1], q[2] - C[2]], l = Math.hypot(...d) || 1; return d.map((x) => x / l); }
    if (k === 0) { const dx = q[0] - Cx, dy = q[1] - Cy, r = Math.hypot(dx, dy), l = Math.hypot(r, 0.4 * r) || 1; return [dx / l, dy / l, (-0.4 * r) / l]; }
    const a = at(vid(k, i + 1)), b = at(vid(k, i - 1)), c = at(vid(k + 1, i)), d = at(vid(k - 1, i));
    const u = [a[0] - b[0], a[1] - b[1], a[2] - b[2]], t = [c[0] - d[0], c[1] - d[1], c[2] - d[2]];
    let n = [u[1] * t[2] - u[2] * t[1], u[2] * t[0] - u[0] * t[2], u[0] * t[1] - u[1] * t[0]];
    if (n[0] * (q[0] - C[0]) + n[1] * (q[1] - C[1]) + n[2] * (q[2] - C[2]) < 0) n = n.map((x) => -x);
    if (k <= 2) n[2] = Math.min(n[2], 0);
    const l = Math.hypot(...n) || 1; return n.map((x) => x / l);
  };
  const nearestHas = (i) => { for (let d = 0; d < L; d++) { if (band[(i + d) % L].has) return (i + d) % L; if (band[(i - d + L) % L].has) return (i - d + L) % L; } return i; };
  const cols = [];
  for (let i = 0; i < L; i++) {
    const pts = [], nrm = [], cum = [0];
    for (let k = 0; k <= K; k++) { pts.push(at(vid(k, i))); nrm.push(hullNormal(k, i)); if (k) { const p0 = pts[k - 1], p1 = pts[k]; cum.push(cum[k - 1] + Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2])); } }
    const m0 = Math.hypot(pts[0][0] - Cx, pts[0][1] - Cy);
    let ext = 0; for (let k = 1; k < K; k++) ext = Math.max(ext, Math.hypot(pts[k][0] - Cx, pts[k][1] - Cy) - m0);
    const up = (pts[0][1] - Cy) / (m0 || 1);
    cols.push({ pts, nrm, cum, S: cum[K], ext, up });
  }
  // where along its path each column's hair starts (as a fraction; 1 = no hair) and whose band it wears
  const rec = p.hairRecede || 0, vol = p.hairVolume ?? 1;
  let f0 = [], bandOf = [], thick = [];
  for (let i = 0; i < L; i++) {
    const c = cols[i], q = band[i];
    let s0 = c.S, bi = i, nape = false;
    if (!lower[i]) {
      if (q.has) s0 = q.a + rec * (0.5 + Math.max(0, c.up) * c.S); // receding: the front and crown first
      else if (c.up < 0.6) { s0 = c.cum[3]; bi = nearestHas(i); } // a bare temple: hair still behind the ear (a bare crown stays bare)
    }
    else if (q.has) s0 = c.cum[2]; // long hair, hanging behind the jaw
    else { // the nape continues the sides (this side's, else the other's, else the nearest hair)
      const o = side(i) === iL ? iR : iL, src = band[side(i)].has ? side(i) : band[o].has ? o : nearestHas(side(i));
      if (band[src].has) { s0 = c.cum[3]; bi = src; nape = true; }
    }
    f0.push(Math.min(1, s0 / c.S)); bandOf.push(bi);
    const b = band[bi];
    thick.push(b.has ? clamp(b.b - cols[bi].ext, 0.015, 0.5) * vol * (nape ? 0.5 : 1) : 0);
  }
  // smooth across columns: the hair's edge runs as a curve, not a staircase
  const smooth = (arr, r) => arr.map((_, i) => { let s = 0; for (let d = -r; d <= r; d++) s += arr[(i + d + L) % L]; return s / (2 * r + 1); });
  f0 = smooth(smooth(f0, 2), 1);
  const has = f0.map((f) => f < 0.97);
  thick = smooth(thick.map((t, i) => (t || thick[bandOf[i]] || 0)), 1);
  if (!has.some(Boolean)) return null;

  // ---- the hair grid: M rows per column from where its hair starts to the pole ----
  const M = 10, P = [], ph = [], id = [];
  const sample = (c, s) => { // position + normal along a column's path at arc s
    let k = 0; while (k < K - 1 && c.cum[k + 1] < s) k++;
    const t = clamp((s - c.cum[k]) / ((c.cum[k + 1] - c.cum[k]) || 1), 0, 1), A = c.pts[k], B = c.pts[k + 1], nA = c.nrm[k], nB = c.nrm[k + 1];
    const n = [0, 1, 2].map((d) => nA[d] + (nB[d] - nA[d]) * t), l = Math.hypot(...n) || 1;
    return [[0, 1, 2].map((d) => A[d] + (B[d] - A[d]) * t), n.map((x) => x / l)];
  };
  const photo = (bi, s) => { const q = band[bi], span = Math.max(q.b - q.a, 0.05), d = q.a + pingpong(Math.max(0, s - q.a), span); return [q.ox + q.dx * d * fw, q.oy + q.dy * d * fw]; };
  let iTop = 0; for (let i = 0; i < L; i++) if (at(loop[i])[1] > at(loop[iTop])[1]) iTop = i;
  const tPole = thick.reduce((s, t, i) => s + (has[i] ? t : 0), 0) / Math.max(1, has.filter(Boolean).length);
  const pv = at(pole), pn = hullNormal(K, 0);
  const poleId = 0; P.push(...pv.map((x, d) => x + pn[d] * tPole)); ph.push(photo(bandOf[iTop], band[bandOf[iTop]].a + Math.max(band[bandOf[iTop]].b - band[bandOf[iTop]].a, 0.05) * 0.5));
  for (let i = 0; i < L; i++) {
    const c = cols[i], s0 = f0[i] * c.S, row = [];
    for (let j = 0; j < M; j++) {
      const s = s0 + ((c.S - s0) * j) / M, [q, n] = sample(c, s);
      const hat = clamp((hatY - 0.06 - q[1]) / 0.12, 0, 1); // tucked flat by the time it reaches the hat's edge
      const T = Math.max(0.004, thick[i] * clamp((s - s0) / 0.15, 0, 1) * hat); // thin at the hairline, full within 0.15
      row.push(P.length / 3); P.push(q[0] + n[0] * T, q[1] + n[1] * T, q[2] + n[2] * T); ph.push(photo(bandOf[i], s));
    }
    row.push(poleId); id.push(row);
  }
  const index = [];
  const area2 = (a, b, c) => { const g = (x) => [P[x * 3], P[x * 3 + 1], P[x * 3 + 2]], A = g(a), B = g(b), Cc = g(c); const u = B.map((x, d) => x - A[d]), t = Cc.map((x, d) => x - A[d]); return Math.hypot(u[1] * t[2] - u[2] * t[1], u[2] * t[0] - u[0] * t[2], u[0] * t[1] - u[1] * t[0]); };
  const tri = (a, b, c) => { if (a === b || b === c || a === c || area2(a, b, c) < 1e-7) return; if ([a, b, c].some((v) => P[v * 3 + 1] > hatY)) return; index.push(a, b, c); };
  for (let i = 0; i < L; i++) {
    const i2 = (i + 1) % L; if (!has[i] && !has[i2]) continue;
    for (let j = 0; j < M; j++) { const a = id[i][j], b = id[i2][j], c = id[i][j + 1], d = id[i2][j + 1]; tri(a, b, d); tri(a, d, c); }
  }
  if (!index.length) return null;
  // outward winding (same test as the hull's)
  {
    const g = (x) => [P[x * 3], P[x * 3 + 1], P[x * 3 + 2]], [a, b, c] = [g(index[0]), g(index[1]), g(index[2])];
    const u = b.map((x, q) => x - a[q]), t = c.map((x, q) => x - a[q]);
    const n = [u[1] * t[2] - u[2] * t[1], u[2] * t[0] - u[0] * t[2], u[0] * t[1] - u[1] * t[0]];
    if (n[0] * (a[0] - C[0]) + n[1] * (a[1] - C[1]) + n[2] * (a[2] - C[2]) < 0) for (let q = 0; q < index.length; q += 3) [index[q + 1], index[q + 2]] = [index[q + 2], index[q + 1]];
  }

  // only the vertices the triangles use
  {
    const remap = new Map(), P2 = [], ph2 = [];
    for (let q = 0; q < index.length; q++) {
      const v = index[q];
      if (!remap.has(v)) { remap.set(v, ph2.length); P2.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]); ph2.push(ph[v]); }
      index[q] = remap.get(v);
    }
    P.length = 0; P.push(...P2); ph.length = 0; ph.push(...ph2);
  }

  // ---- the texture: the photo around the head, hair only (the rest filled from the nearest hair) ----
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of ph) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  x0 = clamp(Math.floor(x0) - 4, 0, w - 1); y0 = clamp(Math.floor(y0) - 4, 0, h - 1); x1 = clamp(Math.ceil(x1) + 4, x0 + 1, w); y1 = clamp(Math.ceil(y1) + 4, y0 + 1, h);
  const sc = Math.min(1, 256 / Math.max(x1 - x0, y1 - y0)), cw = Math.max(2, Math.round((x1 - x0) * sc)), ch = Math.max(2, Math.round((y1 - y0) * sc));
  const rgb = new Float32Array(cw * ch * 3), known = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const sx = Math.min(w - 1, (x0 + x / sc) | 0), sy = Math.min(h - 1, (y0 + y / sc) | 0), s = sy * w + sx;
    if (mask[s] !== 1) continue;
    const o = y * cw + x; known[o] = 1; rgb[o * 3] = px[s * 4]; rgb[o * 3 + 1] = px[s * 4 + 1]; rgb[o * 3 + 2] = px[s * 4 + 2];
  }
  // hair pixels right at the mask's edge carry background: one step in
  const edge = [];
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) { const o = y * cw + x; if (known[o] && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => { const X2 = x + a, Y2 = y + b; return X2 >= 0 && Y2 >= 0 && X2 < cw && Y2 < ch && !known[Y2 * cw + X2]; })) edge.push(o); }
  if (edge.length < known.reduce((s, k) => s + k, 0) * 0.5) for (const o of edge) known[o] = 0;
  fill(rgb, known, cw, ch);
  const canvas = document.createElement('canvas'); canvas.width = cw; canvas.height = ch;
  const g = canvas.getContext('2d'), img = g.createImageData(cw, ch);
  for (let o = 0; o < cw * ch; o++) { const c = grade(rgb[o * 3] / 255, rgb[o * 3 + 1] / 255, rgb[o * 3 + 2] / 255, p, o % cw, (o / cw) | 0); img.data.set([c[0], c[1], c[2], 255], o * 4); }
  g.putImageData(img, 0, 0);

  const uv = new Float32Array(ph.length * 2);
  ph.forEach(([x, y], k) => { uv[k * 2] = ((x - x0) * sc) / cw; uv[k * 2 + 1] = 1 - ((y - y0) * sc) / ch; });
  return { positions: new Float32Array(P), uv, index, canvas };
}

// unknown pixels take the mean of their known neighbours, ring by ring outward (all of them, eventually)
function fill(rgb, known, w, h) {
  let todo = known.length - known.reduce((s, k) => s + k, 0);
  if (todo === known.length) return;
  while (todo > 0) {
    const add = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const o = y * w + x; if (known[o]) continue;
      let r = 0, g = 0, b = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X2 = x + dx, Y2 = y + dy; if (X2 < 0 || Y2 < 0 || X2 >= w || Y2 >= h) continue;
        const q = Y2 * w + X2; if (!known[q]) continue; r += rgb[q * 3]; g += rgb[q * 3 + 1]; b += rgb[q * 3 + 2]; n++;
      }
      if (n) add.push([o, r / n, g / n, b / n]);
    }
    if (!add.length) break;
    for (const [o, r, g, b] of add) { rgb[o * 3] = r; rgb[o * 3 + 1] = g; rgb[o * 3 + 2] = b; known[o] = 1; }
    todo -= add.length;
  }
}

// the face atlas's grade (atlas.js GRADE_FRAG: pale, hue, saturation, contrast, brightness, posterize), so
// the hair matches the face it grew with, then the hair's own dye and brightness
const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => v / 16);
function grade(r, g, b, p, x, y) {
  let c = [r, g, b];
  let l = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  c = c.map((v) => v + ((l * 1.15 + 0.12) - v) * (p.pale || 0));
  c = hueRotate(c, p.hue || 0);
  l = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  c = c.map((v) => l + (v - l) * (p.sat ?? 1));
  c = c.map((v) => (v - 0.5) * (p.contrast ?? 1) + 0.5 + (p.bright || 0));
  if (p.hairHue) { // dye: the hair's light/dark pattern in the new hue (works on black hair too)
    l = clamp(0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2], 0, 1);
    const hh = ((p.hairHue / 360) % 1 + 1) % 1;
    c = [0, 2 / 3, 1 / 3].map((o) => clamp(Math.abs(((hh + o) % 1) * 6 - 3) - 1, 0, 1) * (0.18 + l * 1.4));
  }
  c = c.map((v) => v * (p.hairBright ?? 1));
  const lv = p.levels || 32, d = bayer[(y % 4) * 4 + (x % 4)];
  return c.map((v) => Math.round((Math.floor(clamp(v, 0, 1) * lv + d) / lv) * 255));
}
function hueRotate(c, deg) {
  if (!deg) return c;
  const a = (deg * Math.PI) / 180, Y = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  let I = 0.596 * c[0] - 0.274 * c[1] - 0.322 * c[2], Q = 0.211 * c[0] - 0.523 * c[1] + 0.312 * c[2];
  const h = Math.atan2(Q, I) + a, m = Math.hypot(I, Q); I = m * Math.cos(h); Q = m * Math.sin(h);
  return [Y + 0.956 * I + 0.621 * Q, Y - 0.272 * I - 0.647 * Q, Y - 1.106 * I + 1.703 * Q];
}
