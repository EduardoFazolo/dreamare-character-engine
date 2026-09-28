// World map model (no DOM): a grid of cells, each owned by at most one region. Regions are dropped as
// organic blobs, grown out of a parent in a direction (drifting further from its biome the deeper they go),
// removed, locked, re-rolled. Everything is seeded and the whole world saves as JSON.
import { rng, fbm } from './util.js';
import { VILLAGE, randomBiome, mutate } from './biomes.js';
import { placeName } from '../names/gen.js';

export const DIRS = { N: [0, -1], NE: [1, -1], E: [1, 0], SE: [1, 1], S: [0, 1], SW: [-1, 1], W: [-1, 0], NW: [-1, -1] };
const MOOD = () => ({ time: 0.3, haze: 0.62, skyHue: 0, wrongness: 0.2 });

export function createWorld(seed = 1 + Math.floor(Math.random() * 99998), w = 96, h = 64) {
  return { version: 1, seed, w, h, cells: new Int32Array(w * h).fill(-1), regions: [], nextId: 0, ops: 0 };
}
const opRng = (world) => rng(world.seed * 7919 + ++world.ops * 104729);
export const regionById = (world, id) => world.regions.find((r) => r.id === id);
export const cellOwner = (world, x, y) => (x < 0 || y < 0 || x >= world.w || y >= world.h ? -2 : world.cells[y * world.w + x]);
export function regionCells(world, id) { const out = []; world.cells.forEach((o, i) => { if (o === id) out.push([i % world.w, Math.floor(i / world.w)]); }); return out; }
export function centroid(world, id) {
  const c = regionCells(world, id); if (!c.length) return [0, 0];
  return [c.reduce((a, p) => a + p[0], 0) / c.length, c.reduce((a, p) => a + p[1], 0) / c.length];
}
export const regionName = (reg) => placeName(reg.seed, { kind: reg.biome.water ? 'coast' : 'any' });

// grow a blob from (cx, cy) over free cells: lowest "cost" first, where cost is distance warped by noise,
// so edges come out ragged and lobed like coastlines
function grow(world, cx, cy, id, r) {
  const target = 70 + Math.floor(r() * 120), ns = Math.floor(r() * 1e4), stretch = 0.6 + r() * 0.8, ang = r() * Math.PI;
  const ca = Math.cos(ang), sa = Math.sin(ang);
  const cost = (x, y) => {
    const dx = x - cx, dy = y - cy, u = dx * ca + dy * sa, v = (-dx * sa + dy * ca) * stretch;
    return Math.hypot(u, v) * (0.55 + fbm(x * 0.12, y * 0.12, ns) * 0.9) + r() * 0.8;
  };
  const frontier = new Map(), taken = [];
  const push = (x, y) => { const k = y * world.w + x; if (cellOwner(world, x, y) === -1 && !frontier.has(k)) frontier.set(k, cost(x, y)); };
  push(cx, cy);
  while (taken.length < target && frontier.size) {
    let bk = -1, bc = Infinity;
    for (const [k, c] of frontier) if (c < bc) { bc = c; bk = k; }
    frontier.delete(bk);
    const x = bk % world.w, y = Math.floor(bk / world.w);
    world.cells[bk] = id; taken.push([x, y]);
    push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
  }
  return taken.length;
}

export function dropRegion(world, cx, cy, { biome, parent = null, depth = 0 } = {}) {
  if (cellOwner(world, cx, cy) !== -1) return null;
  const r = opRng(world), id = world.nextId++;
  const size = grow(world, cx, cy, id, r);
  if (size < 10) { world.cells.forEach((o, i) => { if (o === id) world.cells[i] = -1; }); return null; } // no room
  const seed = 1 + Math.floor(r() * 99998);
  const reg = { id, seed, biome: biome || (world.regions.length ? randomBiome(rng(seed * 3)) : structuredClone(VILLAGE)), mood: MOOD(), locked: false, parent, depth, rolls: 0 };
  if (parent != null) { const p = regionById(world, parent); if (p) reg.mood = { ...p.mood, time: Math.min(1, Math.max(0, p.mood.time + (r() - 0.5) * 0.2)) }; }
  reg.name = regionName(reg);
  world.regions.push(reg);
  return reg;
}

// the free cell just past the region's edge in a direction
export function continueFrom(world, reg, dirKey) {
  const [dx, dy] = DIRS[dirKey], cells = regionCells(world, reg.id);
  let best = null, bs = -Infinity;
  for (const [x, y] of cells) for (let step = 1; step <= 3; step++) {
    const nx = x + dx * step, ny = y + dy * step;
    if (cellOwner(world, nx, ny) !== -1) continue;
    const s = nx * dx + ny * dy - step * 0.01;
    if (s > bs) { bs = s; best = [nx, ny]; }
    break;
  }
  if (!best) return null;
  // each step away drifts the biome further: the deeper, the stranger
  const r = opRng(world), depth = reg.depth + 1;
  const biome = mutate(reg.biome, r, Math.min(0.9, 0.22 + depth * 0.09));
  return dropRegion(world, best[0], best[1], { biome, parent: reg.id, depth });
}

export function removeRegion(world, reg) {
  if (reg.locked) return false;
  world.cells.forEach((o, i) => { if (o === reg.id) world.cells[i] = -1; });
  world.regions = world.regions.filter((x) => x !== reg);
  return true;
}

export function rerollBiome(world, reg) {
  if (reg.locked) return false;
  reg.rolls++;
  reg.biome = randomBiome(rng(reg.seed * 3 + reg.rolls * 7));
  reg.name = regionName(reg);
  return true;
}

// neighbours for the scene: direction (scene x = map x, scene z = map y) toward the shared border, strongest first
export function neighborsOf(world, reg) {
  const [cx, cy] = centroid(world, reg.id), acc = new Map();
  for (const [x, y] of regionCells(world, reg.id)) for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const o = cellOwner(world, x + ox, y + oy);
    if (o < 0 || o === reg.id) continue;
    const a = acc.get(o) || { n: 0, x: 0, y: 0 }; a.n++; a.x += x + ox - cx; a.y += y + oy - cy; acc.set(o, a);
  }
  return [...acc.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 6).map(([id, a]) => {
    const l = Math.hypot(a.x, a.y) || 1, other = regionById(world, id);
    return { id, u: [a.x / l, a.y / l], biome: other.biome, contact: a.n };
  });
}
// water lies toward open (unclaimed) map, if there is any beside the region
export function seaAngleOf(world, reg) {
  const [cx, cy] = centroid(world, reg.id); let sx = 0, sy = 0, n = 0;
  for (const [x, y] of regionCells(world, reg.id)) for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const o = cellOwner(world, x + ox, y + oy);
    if (o === -1 || o === -2) { sx += x + ox - cx; sy += y + oy - cy; n++; }
  }
  return n ? Math.atan2(sy, sx) : undefined;
}

// ---- save / load: cells as run-length pairs ----
export function serialize(world) {
  const runs = []; let prev = world.cells[0], n = 0;
  for (const c of world.cells) { if (c === prev) n++; else { runs.push(prev, n); prev = c; n = 1; } }
  runs.push(prev, n);
  return { ...world, cells: runs, format: 'dreamare-world' };
}
export function deserialize(json) {
  if (json.format !== 'dreamare-world') throw new Error('not a Dreamare world file');
  const cells = new Int32Array(json.w * json.h); let i = 0;
  for (let k = 0; k < json.cells.length; k += 2) cells.fill(json.cells[k], i, (i += json.cells[k + 1]));
  return { ...json, cells };
}
