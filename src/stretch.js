// "Expanding space" at the face's edge: the photo is left alone up to STRETCH_START of the way to the
// outline; beyond, the sampled radius eases toward the outline ever slower (same slope where it starts,
// so no crease), and keeps easing over the skull: the skin at the face's edge is stretched over the head
// instead of the photo ending in a border. ratio = radius / outline radius in that direction.
// It freezes at STRETCH_LIMIT, short of the outline itself: the photo's very edge is the hairline, the
// jaw's shadow and background, which stretched over the head read as dark bands.
export const STRETCH_START = 0.7, STRETCH_LIMIT = 0.9;
export function stretchT(ratio) {
  const a = STRETCH_START, T = STRETCH_LIMIT;
  return ratio <= a ? ratio : a + (T - a) * (1 - Math.exp(-(ratio - a) / (T - a)));
}

// distance from c along unit dir to the polygon's boundary (the largest hit)
export function rayToPolygon(c, dir, poly) {
  let best = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j], [bx, by] = poly[i], ex = bx - ax, ey = by - ay;
    const den = dir[0] * ey - dir[1] * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((ax - c[0]) * ey - (ay - c[1]) * ex) / den, s = ((ax - c[0]) * dir[1] - (ay - c[1]) * dir[0]) / den;
    if (t > 0 && s >= 0 && s <= 1) best = Math.max(best, t);
  }
  return best;
}

// the face mesh's outline as an ordered vertex loop
export function boundaryLoop(index) {
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
