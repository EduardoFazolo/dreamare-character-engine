import * as THREE from 'three';
import { perf } from './perf.js';
import { BodySDF, GarmentField, sdEllipsoidAt, sampleGrid, splitNets, splitRanges, deriveGrid, polygonize, simplify, shade, sdRoundCone, fuzzFreqFor, hemFor, smin, smax } from './sdf.js';

// Sculpted character in layers, all from one sampled grid:
//   skin body (limbs blend into the torso, never into each other) + two finer-grid hands
//   garments: shells = body pushed out by a thickness, cut to a region (shirt, pants|skirt, shoes)
// Skin fully covered by a garment is removed, so nothing pokes through and no triangles are wasted.

export const REGION = { top: 0, bottom: 1, shoes: 2, skin: 3 };
export const REGION_NAMES = ['top', 'bottom', 'shoes', 'skin', 'hair']; // 'hair' = the head's hair shell

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// negative fat thins proportionally (subtracting a fixed amount would erase thin limbs)
function thin(q, f) {
  if (f >= 1 || q.rigid) return q;
  if (q.type === 'cone') return { ...q, r1: q.r1 * f, r2: q.r2 * f };
  if (q.type === 'ellipsoid') return { ...q, r: [q.r[0] * f, q.r[1], q.r[2] * f] };
  return q;
}

// grid cell small enough that the thinnest cone still spans ~3 cells
function cellFor(prims, max) {
  const cones = prims.filter((q) => q.type === 'cone' && !q.ghost);
  const minR = Math.min(...cones.map((q) => Math.min(q.r1, q.r2)));
  return Math.max(max * 0.4, Math.min(max, minR * 0.6));
}

// ---- clothing regions (model space, head units; negative = inside). Mirrored in the bake shader. ----
export function regionSpec(body, p, model, outfit) {
  const pos = (j) => new THREE.Vector3().setFromMatrixPosition(model(body.j[j]));
  const R = {
    waistY: pos('waist').y,
    collarY: pos('neck').y + 0.05,
    shoulderX: Math.abs(pos('shoulderB').x),
    shoulderY: pos('shoulderB').y,
    armBand: 0.45 * p.girth * Math.max(1, p.handSize) + 0.35, // arms are horizontal at shoulder height in the bind pose
    wristX: Math.abs(pos('wristB').x),
    ankleY: pos('ankleB').y + 0.05,
    toeZ: pos('ankleB').z + 0.42 * p.footSize * (outfit.feet || 1), // where the toes start
    crotchY: pos('hipB').y - 0.25,
    hipZ: pos('pelvis').z,
    neckZ: pos('neck').z,
    neckHole: body.sculpt.dims.neckR * 1.35 + 0.06,
    sleeve: outfit.cut?.sleeves === 'mutton' ? 1 : p.sleeveLen, pants: outfit.cut?.bottom === 'gown' ? 1 : p.pantsLen,
    skirt: (p.bottomType === 'skirt' || outfit.cut?.bottom === 'gown') && outfit.bottom !== 'skin', // (a gown is always a skirt, to the floor)
    details: outfit.details || {},
    hipX: Math.abs(pos('hipB').x), ankleX: Math.abs(pos('ankleB').x), kneeY: pos('kneeB').y,
  };
  // gut: a beer gut, the shirt over it and the trousers' waistline (and belt) dropped under it in front only
  R.gutDrop = Math.max(0, p.gut || 0) * (0.3 + 0.25 * Math.max(0, p.belly || 0)); R.gutZ = 0.35;
  R.hemY = R.crotchY - R.pants * (R.crotchY - R.ankleY) - 0.05;
  // fitted clothes (Clothes: fitted): the outfit's cut (OUTFITS[..].cut) with this character's recipe; see cutShapes
  // (Victorian cuts are always worn: they are the outfit)
  const cut = outfit.cut && (p.clothes === 'fitted' || outfit.cut.always) ? outfit.cut : null;
  const top = cut?.top && outfit.top !== 'skin' ? cut.top : null;
  R.cut = cut ? {
    jacket: ['jacket', 'frockcoat', 'tailcoat', 'bodice'].includes(top), kind: top, sleeves: cut.sleeves || null,
    trousers: cut.bottom === 'trousers' && !R.skirt && outfit.bottom !== 'skin', gown: cut.bottom === 'gown' && outfit.bottom !== 'skin',
    fit: cut.fit ?? p.clothesFit ?? 0.3, square: p.cutSquare ?? 0.5, flare: p.cutFlare ?? 0, length: p.cutLength ?? 0.3, legFlare: p.legFlare ?? 0,
  } : null;
  // hems: a jacket can run down over the hips; a frock coat to the knee; a tailcoat is cut at the waist in
  // front with tails behind to the knee (tailHem, for z behind the body's middle)
  R.topHem = top === 'frockcoat' ? R.kneeY + 0.1 : top === 'bodice' ? R.waistY - 0.1 : R.waistY - 0.15 - (top === 'jacket' || top === 'tailcoat' ? R.cut.length * (top === 'tailcoat' ? 0.1 : 0.7) : 0);
  R.tailHem = top === 'tailcoat' ? R.kneeY + 0.05 : R.topHem;
  R.tailZ = R.hipZ - body.sculpt.dims.hipR * 0.75; // below the front hem only what's behind this is coat: the tails (not the legs' shells)
  return R;
}

// Creases between cuts are rounded by R.round (1.5 grid cells, see fitRegions): the mesher can't
// resolve a knife edge, it turns into teeth. Pants floor and shoe top: see fitRegions.
const gutFront = (R, z) => { if (!R.gutDrop) return 0; const t = Math.min(1, Math.max(0, (z - R.hipZ) / R.gutZ)); return R.gutDrop * t * t * (3 - 2 * t); }; // (0 at the sides and back, the full drop at the front of the belly)
export const masks = {
  top(R, x, y, z) {
    const ax = Math.abs(x), len = R.wristX - R.shoulderX, k = R.round;
    if (ax > R.shoulderX * 0.95 && Math.abs(y - R.shoulderY) < R.armBand) return ((ax - R.shoulderX) / len - Math.min(R.sleeve, 1)) * len;
    // collar = a round hole around the neck (a flat cut would slice off the shoulder tops)
    const hole = R.neckHole - Math.hypot(x, z - R.neckZ);
    const hem = (R.tailHem != null && z < R.tailZ ? R.tailHem : R.topHem ?? R.waistY - 0.15) - gutFront(R, z); // (tails behind; a beer gut drops the front hem under it)
    return smax(hem - y, smin(hole, y - (R.collarY - 0.12), k), k);
  },
  bottom(R, x, y, z = R.hipZ) {
    const k = R.round, w = R.waistY - gutFront(R, z);
    if (R.skirt) return smax(y - (w + 0.05), R.hemY - y, k);
    const span = R.crotchY - R.ankleY;
    const m = smax(y - w, (Math.max(0, R.crotchY - y) / span - R.pants) * span, k);
    return smax(m, R.pantsFloor - y, k);
  },
  shoes(R, x, y) { return y - R.shoeTop; },
};

// Everything the sculpt needs, as plain data (runs in a Web Worker): prims carry their joint's
// bind-pose model matrix as a 16-number array instead of a live joint reference.
export function sculptInput(body, p, model, R, outfit) {
  const plain = (q) => { const { joint, ...rest } = q; return { ...rest, matrix: model(joint).toArray() }; };
  return {
    prims: body.sculpt.body.map(plain),
    hands: { A: body.sculpt.hands.A.map(plain), B: body.sculpt.hands.B.map(plain) },
    dims: body.sculpt.dims, R,
    outfit: { top: outfit.top, bottom: outfit.bottom, shoes: outfit.shoes, fuzz: outfit.fuzz || 0, cut: outfit.cut || null },
    p: Object.fromEntries(['fat', 'seed', 'lumps', 'looseness', 'clay', 'sag', 'polyBudget', 'handSize', 'clothes', 'clothesFit', 'cutSquare', 'cutFlare', 'cutLength', 'legFlare'].map((k) => [k, p[k]])), // (boxy keeps the budget: capping it starved the garments to ~120 tris and ate sleeves and collars)
  };
}

// pure: plain input -> parts of plain typed arrays (positions, indices, normals, ao, kind, layer)
export function sculptCore(input) {
  const S = sculptSetup(input);
  const grid = perf.time('  sampleGrid', () => sampleGrid(S.sdf, S.cell));
  const hands = S.handJobs.map((job) => perf.time('  hands', () => handMesh(job)));
  return sculptFinish(S, grid, hands);
}

// Same result, with the heavy independent pieces fanned out to a worker pool: the grid is
// sampled in slabs (merged exact-wins, so identical), both hands are sculpted concurrently.
export async function sculptParallel(input, pool) {
  const S = sculptSetup(input);
  const t0 = performance.now();
  const handsP = S.handJobs.map((_, n) => pool.run('handPart', { input, n }));
  const grid = await pool.sampleGrid(S.plainPrims, S.sdfOpts, S.cell);
  perf.log['  sampleGrid(pool)'] = performance.now() - t0;
  // every surface only reads the grid: body and each garment are meshed + shaded concurrently
  const g = { nx: grid.nx, ny: grid.ny, nz: grid.nz, o: grid.o.toArray(), cell: grid.cell, valL: grid.valL, valR: grid.valR };
  const surfs = await Promise.all(['body', ...S.layers.map((_, i) => i)].map((which) => pool.run('surface', { input, grid: g, which })));
  perf.log['  surfaces(pool)'] = performance.now() - t0;
  const hands = await Promise.all(handsP);
  return [...surfs, ...hands].filter((part) => part && part.indices.length);
}

// ---- per-part work, shared by the single-threaded path and the pool workers ----
export function gridFrom(g) { return { ...g, o: new THREE.Vector3().fromArray(g.o) }; }

export function surfacePart(S, grid, which) {
  const { sdf, layers, R, B } = S;
  const left = sdf.view('legA'), right = sdf.view('legB');
  const seamY = R.crotchY - 0.05;
  // the legless body: seam vertices on its surface (crotch underside, skirt) weld below seamY too
  const core = new BodySDF(S.prims.filter((q) => q.group !== 'legA' && q.group !== 'legB'), S.sdfOpts);
  const onCore = (f) => (x, y, z) => f.eval(x, y, z) < 1.5 * grid.cell;
  if (which === 'body') {
    // each leg sculpted in its own pass (the other leg doesn't exist there), welded at the centerline
    const bodyShare = 0.8 - layers.reduce((s, l) => s + l.share, 0) * 0.6;
    const skinNets = perf.time('  nets.body', () => splitNets(grid, grid.valL, grid.valR, left, right, seamY, onCore(core)));
    const skin = cull(perf.time('  simplify', () => simplify(skinNets, Math.round(B * bodyShare))), S.covered);
    return finishPart({ ...skin, field: sdf, kind: 'body', layer: REGION.skin });
  }
  const l = layers[which];
  const make = (body) => new GarmentField(body, { thickness: l.thickness, mask: (x, y, z) => l.mask(R, x, y, z), extra: l.extra, fuzz: l.fuzz, profile: l.profile, fuzzFreq: fuzzFreqFor(grid.cell), hem: hemFor(grid.cell) });
  const fl = make(left), fr = make(right);
  const rg = splitRanges(grid);
  const dl = perf.time('  deriveGrid', () => deriveGrid(grid, fl, grid.valL, rg.left)), dr = perf.time('  deriveGrid', () => deriveGrid(grid, fr, grid.valR, rg.right));
  const nets = perf.time('  nets.garment', () => splitNets(grid, dl, dr, fl, fr, seamY, onCore(make(core))));
  const mesh = perf.time('  simplify', () => simplify(nets, Math.round(B * l.share)));
  return mesh.indices.length ? finishPart({ ...mesh, field: make(sdf), kind: 'garment', layer: l.layer }) : null;
}

export function handPart(S, n, mesh) {
  const job = S.handJobs[n];
  const hsdf = new BodySDF(job.prims.map((q) => ({ ...q, matrix: new THREE.Matrix4().fromArray(q.matrix) })), job.opts);
  const part = finishPart({ ...cull(mesh, S.covered), field: hsdf, kind: job.side === 'A' ? 'handRight' : 'handLeft', layer: REGION.skin });
  // a hand is mostly tucked-in surface: full AO turned it muddy grey; keep a third of it
  for (let i = 0; i < part.ao.length; i++) part.ao[i] = 1 - (1 - part.ao[i]) * 0.35;
  return part;
}

// normals + AO (soles are already flat on y = 0: the field has a ground plane)
function finishPart(part) {
  Object.assign(part, perf.time('  shade(normals+AO)', () => shade(part.field, part.positions)));
  const { positions, indices, normals, ao, kind, layer } = part;
  return { positions, indices, normals, ao, kind, layer };
}

// a hand: its own finer grid (fingers are thinner than the body grid); plain in, plain out
export function handMesh({ prims, opts, cell, budget }) {
  const hsdf = new BodySDF(prims.map((q) => ({ ...q, matrix: new THREE.Matrix4().fromArray(q.matrix) })), opts);
  return simplify(polygonize(hsdf, cell), budget);
}

export function sculptSetup({ prims: rawPrims, hands, dims, R, outfit, p }) {
  const f = 1 + Math.min(0, p.fat) * 0.5;
  const toPrim = (q) => thin({ ...q, matrix: new THREE.Matrix4().fromArray(q.matrix) }, f);
  const prims = rawPrims.map(toPrim);

  // lumps / tumors: seeded bumps sitting on the surface of random limbs and torso parts
  const rnd = mulberry32(p.seed | 0);
  const hosts = prims.filter((q) => q.type !== 'box');
  for (let i = 0, n = Math.round(p.lumps * 7); i < n; i++) {
    const h = hosts[Math.floor(rnd() * hosts.length)];
    const dir = new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize();
    let c;
    if (h.type === 'cone') {
      const t = rnd(), r = h.r1 + (h.r2 - h.r1) * t;
      c = new THREE.Vector3().fromArray(h.a).lerp(new THREE.Vector3().fromArray(h.b), t).addScaledVector(dir, r * 0.85);
    } else {
      c = new THREE.Vector3(h.c[0] + dir.x * h.r[0] * 0.9, h.c[1] + dir.y * h.r[1] * 0.9, h.c[2] + dir.z * h.r[2] * 0.9);
    }
    const rad = (0.08 + 0.18 * rnd()) * (0.6 + p.lumps * 0.6);
    prims.push({ type: 'ellipsoid', matrix: h.matrix, group: h.group, neck: h.neck, c: c.toArray(), r: [rad, rad * (0.8 + 0.4 * rnd()), rad], k: rad * 0.6, soft: true });
  }

  // garments
  const fuzz = outfit.fuzz || 0;
  const thick = 0.035 + p.looseness * 0.15 + fuzz * 0.5;
  let skirtCone = null;
  if (R.skirt) {
    const top = [0, R.waistY - 0.05, R.hipZ], bot = [0, R.hemY, R.hipZ];
    const gown = R.cut?.gown, r1 = dims.waistR + thick, r2 = dims.hipR * (gown ? 1.7 + 0.7 * Math.max(0, R.cut.flare) : 1.25 + 0.6 * p.looseness) + thick;
    // a gown: a bell to the floor, and a bustle standing out behind the hips
    const bustle = gown ? (x, y, z) => sdEllipsoidAt(x, y, z, [0, R.waistY - 0.35, R.hipZ - dims.hipR * 0.95], [dims.hipR * 0.95, 0.42, 0.42]) : null;
    skirtCone = (x, y, z) => { let v = sdRoundCone(x, y, R.hipZ + (z - R.hipZ) * 1.3, top, bot, r1, r2); if (bustle) v = smin(v, bustle(x, y, z), 0.25); return smax(v, masks.bottom(R, x, y, z), R.round); }; // clipped at waist and hem
    // ghost prim: no body volume, only makes sure the grid covers the flared hem
    prims.push({ type: 'cone', ghost: true, matrix: new THREE.Matrix4(), a: top, b: bot, r1, r2, k: 0 });
  }
  const fat = Math.max(0, p.fat);
  const cell = cellFor(prims, 0.07);
  const C = R.cut, ease = C ? Math.max(0, C.fit) : 0;
  const sdfOpts = { inflate: fat * 0.28, clay: p.clay, sag: p.sag * 1.5, seed: p.seed, pad: thick + 0.08 + ease * 0.6, sagFloor: R.crotchY + 0.2, ground: 0 };
  const sdf = new BodySDF(prims, sdfOpts);
  // fitted clothes: tight (fit < 0) thins the shell down to a skin-hugging layer; loose adds the cut's shape
  const fitThick = (t) => (C && C.fit < 0 ? Math.max(0.018, t * (1 + C.fit * 0.8)) : t);
  const shapes = C ? cutShapes(sdf, R, C, fitThick(thick)) : {};
  const plainPrims = prims.map((q) => ({ ...q, matrix: q.matrix.toArray() }));
  const layers = [];
  if (outfit.top !== 'skin') layers.push({ layer: REGION.top, mask: masks.top, thickness: C?.jacket ? fitThick(thick) + 0.03 : thick, fuzz, share: 0.22, // (a jacket clears the trousers it overlaps)
    extra: shapes.jacket ? (x, y, z) => smax(shapes.jacket(x, y, z), masks.top(R, x, y, z), R.round) : null });
  // pants over shoes (see fitRegions): the cuff thickens over the shoe, the shoe thins inside the pants
  const over = !R.skirt && outfit.shoes !== 'skin' && outfit.bottom !== 'skin';
  const trouserShape = shapes.trousers ? (x, y, z) => smax(shapes.trousers(x, y, z), masks.bottom(R, x, y, z), R.round) : null;
  if (outfit.bottom !== 'skin') layers.push({ layer: REGION.bottom, mask: masks.bottom, thickness: C?.trousers ? fitThick(thick) : thick, fuzz, extra: skirtCone || trouserShape, share: 0.18,
    profile: over ? { y: R.shoeTop, w: 0.12, below: Math.max(thick, CUFF), above: thick } : null });
  if (outfit.shoes !== 'skin') layers.push({ layer: REGION.shoes, mask: masks.shoes, thickness: 0.06, share: 0.06,
    profile: over ? { y: R.pantsFloor - 0.04, w: 0.1, below: 0.06, above: 0.02 } : null });

  const B = p.polyBudget;
  // hands: never thinned (thin fingers broke into floating pieces), grid cell sized so the thinnest
  // fingertip is ~3 cells across (cellFor), fingers joined to the palm with a hand-scale blend (the body's
  // 0.18 join swallowed them), and enough triangles that decimation can't shatter them
  const handJobs = ['A', 'B'].map((side) => {
    const hp = hands[side].map((q) => ({ ...q, matrix: new THREE.Matrix4().fromArray(q.matrix) }));
    return {
      side, prims: hp.map((q) => ({ ...q, matrix: q.matrix.toArray() })), cell: cellFor(hp, 0.022 * p.handSize),
      opts: { inflate: fat * 0.05, clay: p.clay * 0.2, seed: p.seed, join: 0.035 * p.handSize }, budget: Math.max(320, Math.round(B * 0.14)),
    };
  });
  const covered = (x, y, z) => layers.some((l) => l.mask(R, x, y, z) < -0.06);
  return { prims, sdf, sdfOpts, plainPrims, layers, R, B, cell, handJobs, covered };
}

// ---- fitted clothes: the garment's own designed shape (clothes-first), unioned with the shell around the body ----
// Measured from the sculpted body (the field), so the cut always contains it: torso half-width / depth below
// the armpits, arm and leg radii along their bones. Then the cut's recipe:
//   fit    -1 (absurdly tight) .. 0 (fitted: the shell alone) .. 1 (baggy: the cut stands off the body)
//   square  0 (sloped) .. 1 (padded square shoulders)   flare  -0.5 (tapered to the hem) .. 1 (A-line)
//   length  0 (at the waist) .. 1 (over the hips)         legFlare  -0.5 (pegged) .. 1 (wide bell-bottoms)
// Tight or fitted (fit <= 0.05): no designed shape at all, the shell hugs the body.
function extent(sdf, o, dir, max = 4) { // distance from o along dir to the body's surface (0 if o is outside)
  if (sdf.eval(o[0], o[1], o[2]) > 0) return 0;
  let t = 0; for (let s = 0.08; s > 0.004; s /= 2) while (t + s < max && sdf.eval(o[0] + dir[0] * (t + s), o[1] + dir[1] * (t + s), o[2] + dir[2] * (t + s)) < 0) t += s;
  return t;
}
function cutShapes(sdf, R, C, t) {
  const loose = C.fit > 0.05, e = Math.max(0, C.fit), out = {}, zc = R.neckZ;
  const victorian = C.kind === 'frockcoat' || C.kind === 'tailcoat' || C.sleeves === 'mutton';
  if (C.jacket && (loose || victorian)) {
    // torso below the arm band: widest half-width, and front / back extents
    let W = 0, F = 0, B = 0;
    const yLo = R.topHem, yHi = R.shoulderY - R.armBand;
    for (let k = 0; k <= 8; k++) { const y = yLo + ((yHi - yLo) * k) / 8; W = Math.max(W, extent(sdf, [0, y, zc], [1, 0, 0])); F = Math.max(F, extent(sdf, [0, y, zc], [0, 0, 1])); B = Math.max(B, extent(sdf, [0, y, zc], [0, 0, -1])); }
    const pad = t + 0.04 + 0.28 * e, top = R.shoulderY + 0.02 + 0.1 * C.square, bot = Math.max(R.topHem, R.waistY - 0.15 - 0.7);
    // (the hem widens with flare only; bagginess alone no longer balloons the bottom into a puffer)
    const wTop = Math.max(W, R.shoulderX * (0.8 + 0.35 * C.square)) + pad, wBot = W + t + 0.04 + 0.12 * e + C.flare * 0.3;
    const zMid = zc + (F - B) / 2, D = (F + B) / 2 + pad * 0.8;
    // arm radius along the sleeve (horizontal in the bind pose)
    let ar = 0; for (let k = 1; k <= 5; k++) { const x = R.shoulderX + ((R.wristX - R.shoulderX) * k) / 7; for (const d of [[0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) ar = Math.max(ar, extent(sdf, [x, R.shoulderY, zc], d)); }
    const r1 = ar + pad * 0.9, r2 = ar + pad * 0.6 + 0.05 * e, rr = 0.06 + 0.06 * (1 - C.square);
    const elbowX = (R.shoulderX + R.wristX) / 2;
    // below the waist: a frock coat's skirt (a flared cone around both legs to the knee), a tailcoat's tails (a
    // split slab behind the thighs to the knee)
    let hipW = 0, back = 0;
    for (let k = 0; k <= 3; k++) { const y = R.crotchY + ((R.waistY - R.crotchY) * k) / 3; hipW = Math.max(hipW, extent(sdf, [0, y, R.hipZ], [1, 0, 0])); back = Math.max(back, extent(sdf, [0, y, R.hipZ], [0, 0, -1])); }
    // (the trousers' own cut stands tp off the body: the coat's skirt and tails clear it, or trousers poke through)
    const tp = (C.trousers && loose ? 0.03 + 0.22 * e : 0) + 2 * t + 0.08;
    const skirtTop = [0, R.waistY - 0.1, R.hipZ], skirtBot = [0, R.topHem, R.hipZ], sr1 = hipW + tp + 0.04, sr2 = hipW + tp + 0.22 + 0.3 * Math.max(0, C.flare);
    out.jacket = (x, y, z) => {
      const ax = Math.abs(x);
      let v = 1e3;
      if (loose) {
        const s = Math.min(1, Math.max(0, (y - bot) / (top - bot))), hw = wBot + (wTop - wBot) * s;
        v = smin(sdRoundBoxY(x, y, z - zMid, hw, bot, top, D, rr), sdRoundCone(ax, y, z, [R.shoulderX * 0.6, R.shoulderY, zc], [R.wristX, R.shoulderY, zc], r1, r2), 0.12);
      }
      // leg-of-mutton sleeves: a big puff from the shoulder to the elbow, tight below it
      if (C.sleeves === 'mutton') v = smin(v, sdRoundCone(ax, y, z, [R.shoulderX + 0.15, R.shoulderY + 0.05, zc], [elbowX, R.shoulderY, zc], ar + 0.32, ar + t + 0.04), 0.1);
      if (C.kind === 'frockcoat') v = smin(v, sdRoundCone(x, y, R.hipZ + (z - R.hipZ) * 1.15, skirtTop, skirtBot, sr1, sr2), 0.2);
      if (C.kind === 'tailcoat') {
        const tail = sdRoundBoxY(x, y, z - Math.min(R.hipZ - back - tp, R.tailZ - 0.12), hipW * 0.85 + tp, R.tailHem, R.waistY - 0.05, 0.09, 0.04);
        v = smin(v, smax(tail, 0.03 - ax, 0.03), 0.1); // (split up the middle)
      }
      return v;
    };
  }
  if (!loose) return out;
  if (C.trousers) {
    let thigh = 0, calf = 0;
    for (const sx of [1, -1]) {
      const at = (f) => { const y = R.crotchY + (R.ankleY - R.crotchY) * f, x = sx * (R.hipX + (R.ankleX - R.hipX) * f); return [x, y, R.hipZ]; };
      for (const d of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) { thigh = Math.max(thigh, extent(sdf, at(0.12), d)); calf = Math.max(calf, extent(sdf, at(0.7), d)); }
    }
    const pad = t + 0.03 + 0.22 * e, rTop = thigh + pad, rBot = Math.max(calf + pad * 0.7, calf + 0.05 + C.legFlare * (0.25 + 0.2 * e));
    let hw = 0, hd = 0; for (let k = 0; k <= 4; k++) { const y = R.crotchY + ((R.waistY - R.crotchY) * k) / 4; hw = Math.max(hw, extent(sdf, [0, y, R.hipZ], [1, 0, 0])); hd = Math.max(hd, extent(sdf, [0, y, R.hipZ], [0, 0, 1]), extent(sdf, [0, y, R.hipZ], [0, 0, -1])); }
    out.trousers = (x, y, z) => {
      const ax = Math.abs(x);
      // each leg stays on its own side (a wide leg met the other and read as a skirt): a flat inseam at x = 0
      const leg = smax(sdRoundCone(ax, y, z, [R.hipX, R.crotchY + 0.15, R.hipZ], [R.ankleX, R.ankleY, R.hipZ], rTop, rBot), (y < R.crotchY ? 0.035 : -1) - ax, 0.04);
      // (under a long coat or tails the seat stays close: its box corners poked out through the coat's skirt)
      if (C.kind === 'frockcoat' || C.kind === 'tailcoat') return leg;
      const seat = sdRoundBoxY(x, y, z - R.hipZ, hw + pad, R.crotchY - 0.1, R.waistY + 0.02, hd + pad, 0.12);
      return smin(leg, seat, 0.15);
    };
  }
  return out;
}
// a box standing between y0 and y1, half-width hw (in x) and half-depth hd (in z, around 0), rounded by r
function sdRoundBoxY(x, y, z, hw, y0, y1, hd, r) {
  const qx = Math.abs(x) - hw + r, qy = Math.abs(y - (y0 + y1) / 2) - (y1 - y0) / 2 + r, qz = Math.abs(z) - hd + r;
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0), oz = Math.max(qz, 0);
  return Math.sqrt(ox * ox + oy * oy + oz * oz) + Math.min(Math.max(qx, qy, qz), 0) - r;
}

// Region fitting that depends on the actual sculpt (both the worker sculpt and the bake call this on
// the same input, so geometry and paint agree). Deterministic: pure in input. Mutates input.R:
// round: the crease rounding of the masks, 1.5 grid cells.
// neckHole: the collar hole must clear the shirt's own shell around the neck. The neck is nearly parallel to
// the hole's cylinder, so a shell radius within a cell of the hole radius leaves a sub-cell sliver
// of shirt up the whole neck (non-manifold teeth). Measure the real shell (fat, clay, sag, fuzz)
// around the hole's axis along the neck, and open the hole to 1.5 cells past it. Mutates
// input.R (the bake reads the same R, so paint and geometry agree). Deterministic: pure in input.
const CUFF = 0.11; // pant cuff thickness over a shoe (which thins to 0.02 inside the pants)

export function fitRegions(input) {
  const R = input.R;
  const S = sculptSetup(input);
  R.round = hemFor(S.cell);
  // Pants floor: one cell above the flat top of the foot (ankleY - 0.08) grown by the cuff's thickness,
  // or the cuff drapes over the foot as a flat shelf (a cut parallel to it: slivers). Where pants come
  // down to the shoe, the shoe top rises 2 roundings above the pants' lowest point: the overlap sits
  // inside the (thickened, see CUFF) cuff instead of both rims fighting in one band thinner than a cell.
  const bottom = S.layers.find((l) => l.layer === REGION.bottom), shod = input.outfit.shoes !== 'skin';
  R.pantsFloor = R.ankleY - 0.08 + Math.max(bottom ? bottom.thickness : 0, shod ? CUFF : 0) + 0.07 + R.round / 2;
  R.shoeTop = R.ankleY + 0.1;
  if (bottom && shod && !R.skirt) {
    const low = Math.max(R.hemY + 0.05, R.pantsFloor);
    if (low < R.shoeTop + 2.5 * R.round) R.shoeTop = low + 2.5 * R.round;
  }
  if (input.outfit.top === 'skin') return R;
  const top = S.layers.find((l) => l.layer === REGION.top);
  // the neck prim (and lumps on it) alone: arms, traps and humps merge into it and would run the
  // rays out, but they meet the cylinder at a steep angle, only the neck runs parallel to it
  const neck = new BodySDF(S.prims.filter((q) => q.neck), S.sdfOpts);
  const shell = new GarmentField(neck, { thickness: top.thickness, mask: () => -1, fuzz: top.fuzz, fuzzFreq: fuzzFreqFor(S.cell) });
  const limit = R.shoulderX * 0.9;
  let rMax = 0;
  for (let y = R.collarY - 0.12; y < R.collarY + 1.5; y += 0.05) {
    if (shell.eval(0, y, R.neckZ) > 0) break; // above the neck
    let ry = 0;
    for (let a = 0; a < 32 && ry < limit; a++) {
      const cx = Math.cos((a / 32) * Math.PI * 2), cz = Math.sin((a / 32) * Math.PI * 2);
      let r0 = 0, r1 = 0.02;
      while (r1 < limit && shell.eval(cx * r1, y, R.neckZ + cz * r1) < 0) { r0 = r1; r1 += 0.02; }
      for (let i = 0; i < 6; i++) { const m = (r0 + r1) / 2; if (shell.eval(cx * m, y, R.neckZ + cz * m) < 0) r0 = m; else r1 = m; }
      ry = Math.max(ry, r1);
    }
    if (ry < limit) rMax = Math.max(rMax, ry);
  }
  R.neckHole = Math.max(R.neckHole, rMax + 1.5 * S.cell + R.round / 2); // (+ the hem's reach past the cut)
  return R;
}

function sculptFinish(S, grid, handMeshes) {
  const parts = [surfacePart(S, grid, 'body'), ...S.layers.map((_, i) => surfacePart(S, grid, i)), ...handMeshes.map((m, n) => handPart(S, n, m))];
  return parts.filter((part) => part && part.indices.length);
}

// drop triangles whose three vertices are all under clothing, then compact
function cull(mesh, covered) {
  const { positions: P, indices: I } = mesh;
  const hidden = new Uint8Array(P.length / 3);
  for (let i = 0; i < hidden.length; i++) hidden[i] = covered(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]) ? 1 : 0;
  const keep = [];
  for (let t = 0; t < I.length; t += 3) if (!(hidden[I[t]] && hidden[I[t + 1]] && hidden[I[t + 2]])) keep.push(I[t], I[t + 1], I[t + 2]);
  const map = new Map(), pos = [], idx = [];
  for (const v of keep) {
    if (!map.has(v)) { map.set(v, map.size); pos.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]); }
    idx.push(map.get(v));
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}
