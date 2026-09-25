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
