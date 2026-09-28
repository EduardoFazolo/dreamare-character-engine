// Biomes: what a region is made of. Like the character generator, a biome is a flat bag of numbers and
// switches, so it can be randomized, mutated, blended with neighbours and saved as JSON.
// VILLAGE is the original scenario (The Dunes farm/village): generate() with VILLAGE must rebuild it exactly.

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export const VEG = ['none', 'dead', 'pine', 'broadleaf', 'birch', 'mushroom', 'willow'];

export const VILLAGE = {
  archetype: 'village',
  // terrain
  duneHeight: 7, hills: 0, water: 1,
  // ground colours (0..255)
  grassA: [118, 124, 84], grassB: [138, 132, 96], dirt: [128, 114, 96], sand: [150, 142, 124], wet: [92, 90, 84],
  tuftA: [112, 116, 82], tuftB: [170, 162, 124], tufts: 1,
  // the original set pieces (1 = present; booth is a chance 0..1)
  house: 1, path: 1, busStop: 1, booth: 0.3, lamps: 1, fence: 1, poles: 1, tower: 1, pier: 1, figure: 1, deadTrees: 1,
  // added features (their own random streams; 0 = absent, so the village is untouched)
  houses: 0, // extra houses clustered along the path
  trees: 'none', treeDensity: 0, treeSize: 1, treeTint: [0, 0, 0], // tint: rgb offset for foliage / caps
  rocks: 0, fields: 0,
};

// archetypes: starting points for random biomes. Each is a partial override of a "wild" base.
const WILD = { ...VILLAGE, house: 0, path: 0, busStop: 0, booth: 0, lamps: 0, fence: 0, poles: 0, tower: 0, pier: 0, figure: 1, deadTrees: 0, water: 0 };
export const ARCHETYPES = {
  village: VILLAGE,
  farmland: { ...VILLAGE, archetype: 'farmland', pier: 0, water: 0, tower: 0, houses: 3, fields: 0.7, trees: 'broadleaf', treeDensity: 0.12, treeSize: 1, duneHeight: 3, hills: 4, grassA: [112, 126, 78], grassB: [140, 138, 92] },
  pinemoor: { ...WILD, archetype: 'pinemoor', trees: 'pine', treeDensity: 0.55, treeSize: 1.1, hills: 10, duneHeight: 2, rocks: 0.4, grassA: [92, 104, 80], grassB: [118, 116, 94], tuftA: [96, 104, 80], tuftB: [140, 136, 110], poles: 1 },
  deadwood: { ...WILD, archetype: 'deadwood', trees: 'dead', treeDensity: 0.22, treeSize: 1.2, hills: 4, duneHeight: 3, grassA: [104, 100, 90], grassB: [126, 118, 104], dirt: [96, 88, 80], tuftA: [120, 114, 96], tuftB: [160, 150, 126], tufts: 0.6 },
  fungal: { ...WILD, archetype: 'fungal', trees: 'mushroom', treeDensity: 0.4, treeSize: 1.6, hills: 6, duneHeight: 2, grassA: [96, 92, 110], grassB: [120, 108, 124], dirt: [104, 92, 100], tuftA: [120, 104, 132], tuftB: [168, 150, 170], treeTint: [40, -20, -10], rocks: 0.2 },
  birchmere: { ...WILD, archetype: 'birchmere', trees: 'birch', treeDensity: 0.35, treeSize: 1, water: 1, pier: 1, duneHeight: 2, hills: 3, grassA: [120, 128, 96], grassB: [150, 146, 116] },
  heath: { ...WILD, archetype: 'heath', trees: 'dead', treeDensity: 0.04, rocks: 0.6, hills: 8, duneHeight: 1, grassA: [112, 96, 96], grassB: [134, 116, 104], tuftA: [120, 96, 104], tuftB: [150, 120, 128], tufts: 1.4, poles: 1 },
  saltflats: { ...WILD, archetype: 'saltflats', duneHeight: 0.6, hills: 0, water: 1, grassA: [196, 192, 180], grassB: [214, 208, 196], sand: [220, 214, 200], dirt: [170, 160, 146], tufts: 0.15, poles: 1, tower: 1, booth: 0.5, path: 1 },
  willowfen: { ...WILD, archetype: 'willowfen', trees: 'willow', treeDensity: 0.3, treeSize: 1.1, water: 1, duneHeight: 1, hills: 2, grassA: [96, 112, 88], grassB: [120, 130, 100], tufts: 1.6, tuftA: [100, 116, 80], tuftB: [150, 156, 110] },
};
export const ARCHETYPE_NAMES = Object.keys(ARCHETYPES);

const NUM = { booth: [0, 1], duneHeight: [0, 14], hills: [0, 16], tufts: [0, 2], houses: [0, 6], treeDensity: [0, 1], treeSize: [0.4, 2.5], rocks: [0, 1], fields: [0, 1] };
const COLORS = ['grassA', 'grassB', 'dirt', 'sand', 'wet', 'tuftA', 'tuftB'];
const FLAGS = ['water', 'house', 'path', 'busStop', 'lamps', 'fence', 'poles', 'tower', 'pier', 'figure'];

// a random biome: an archetype, jittered
export function randomBiome(r, archetype) {
  const a = archetype || ARCHETYPE_NAMES[1 + Math.floor(r() * (ARCHETYPE_NAMES.length - 1))];
  return mutate(structuredClone(ARCHETYPES[a]), r, 0.25);
}

// drift a biome by `amount` (0 small .. 1 wild): numbers wander, colours shift, switches sometimes flip,
// and past ~0.5 it may turn into another archetype altogether
export function mutate(b, r, amount) {
  const o = structuredClone(b);
  if (r() < amount * 0.45) { const next = randomBiome(r); return { ...next, archetype: next.archetype }; }
  for (const [k, [lo, hi]] of Object.entries(NUM)) o[k] = clamp(o[k] + (r() - 0.5) * (hi - lo) * amount * 0.6, lo, hi);
  o.houses = Math.round(o.houses);
  const shift = (r() - 0.5) * 40 * amount; // the whole palette leans together, plus a little per colour
  for (const k of COLORS) o[k] = o[k].map((v) => clamp(Math.round(v + shift + (r() - 0.5) * 24 * amount), 0, 255));
  o.treeTint = o.treeTint.map((v) => clamp(Math.round(v + (r() - 0.5) * 60 * amount), -80, 80));
  for (const k of FLAGS) if (r() < amount * 0.12) o[k] = o[k] ? 0 : 1;
  if (r() < amount * 0.2) o.trees = VEG[Math.floor(r() * VEG.length)];
  if (o.trees !== 'none' && o.treeDensity < 0.03) o.treeDensity = 0.1;
  o.archetype = b.archetype;
  return o;
}

// blend biome numbers/colours (for the map's colour and for edge fades); switches come from `a`
export function mix(a, b, t) {
  const o = structuredClone(a);
  for (const k of Object.keys(NUM)) o[k] = lerp(a[k], b[k], t);
  for (const k of COLORS) o[k] = a[k].map((v, i) => lerp(v, b[k][i], t));
  return o;
}

// the colour a biome shows on the world map
export function mapColor(b) {
  const g = b.grassA.map((v, i) => (v + b.grassB[i]) / 2);
  const tree = { none: [0, 0, 0], dead: [-10, -12, -10], pine: [-40, -20, -35], broadleaf: [-30, -10, -40], birch: [10, 10, 0], mushroom: [30, -30, 10], willow: [-30, -5, -30] }[b.trees] || [0, 0, 0];
  const k = Math.min(1, b.treeDensity * 1.6);
  return g.map((v, i) => clamp(Math.round(v * 1.05 + tree[i] * k + (b.water ? [-4, 0, 8][i] : 0)), 0, 255));
}
