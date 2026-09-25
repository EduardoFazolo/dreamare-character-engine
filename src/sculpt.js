import * as THREE from 'three';
import { perf } from './perf.js';
import { BodySDF, GarmentField, sampleGrid, splitNets, splitRanges, deriveGrid, polygonize, simplify, shade, sdRoundCone, fuzzFreqFor, hemFor, smin, smax } from './sdf.js';

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
    sleeve: p.sleeveLen, pants: p.pantsLen,
    skirt: p.bottomType === 'skirt' && outfit.bottom !== 'skin',
    details: outfit.details || {},
  };
  R.hemY = R.crotchY - R.pants * (R.crotchY - R.ankleY) - 0.05;
  return R;
}

// Creases between cuts are rounded by R.round (1.5 grid cells, see fitRegions): the mesher can't
// resolve a knife edge, it turns into teeth. Pants floor and shoe top: see fitRegions.
export const masks = {
  top(R, x, y, z) {
    const ax = Math.abs(x), len = R.wristX - R.shoulderX, k = R.round;
    if (ax > R.shoulderX * 0.95 && Math.abs(y - R.shoulderY) < R.armBand) return ((ax - R.shoulderX) / len - Math.min(R.sleeve, 1)) * len;
    // collar = a round hole around the neck (a flat cut would slice off the shoulder tops)
    const hole = R.neckHole - Math.hypot(x, z - R.neckZ);
    return smax(R.waistY - 0.15 - y, smin(hole, y - (R.collarY - 0.12), k), k);
  },
  bottom(R, x, y) {
    const k = R.round;
    if (R.skirt) return smax(y - (R.waistY + 0.05), R.hemY - y, k);
    const span = R.crotchY - R.ankleY;
    const m = smax(y - R.waistY, (Math.max(0, R.crotchY - y) / span - R.pants) * span, k);
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
    outfit: { top: outfit.top, bottom: outfit.bottom, shoes: outfit.shoes, fuzz: outfit.fuzz || 0 },
    p: Object.fromEntries(['fat', 'seed', 'lumps', 'looseness', 'clay', 'sag', 'polyBudget', 'handSize'].map((k) => [k, p[k]])),
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
  return finishPart({ ...cull(mesh, S.covered), field: hsdf, kind: job.side === 'A' ? 'handRight' : 'handLeft', layer: REGION.skin });
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
    const r1 = dims.waistR + thick, r2 = dims.hipR * (1.25 + 0.6 * p.looseness) + thick;
    skirtCone = (x, y, z) => smax(sdRoundCone(x, y, R.hipZ + (z - R.hipZ) * 1.3, top, bot, r1, r2), masks.bottom(R, x, y), R.round); // clipped at waist and hem
    // ghost prim: no body volume, only makes sure the grid covers the flared hem
    prims.push({ type: 'cone', ghost: true, matrix: new THREE.Matrix4(), a: top, b: bot, r1, r2, k: 0 });
  }
  const fat = Math.max(0, p.fat);
  const cell = cellFor(prims, 0.07);
  const sdfOpts = { inflate: fat * 0.28, clay: p.clay, sag: p.sag * 1.5, seed: p.seed, pad: thick + 0.08, sagFloor: R.crotchY + 0.2, ground: 0 };
  const sdf = new BodySDF(prims, sdfOpts);
  const plainPrims = prims.map((q) => ({ ...q, matrix: q.matrix.toArray() }));
  const layers = [];
  if (outfit.top !== 'skin') layers.push({ layer: REGION.top, mask: masks.top, thickness: thick, fuzz, share: 0.22 });
  // pants over shoes (see fitRegions): the cuff thickens over the shoe, the shoe thins inside the pants
  const over = !R.skirt && outfit.shoes !== 'skin' && outfit.bottom !== 'skin';
  if (outfit.bottom !== 'skin') layers.push({ layer: REGION.bottom, mask: masks.bottom, thickness: thick, fuzz, extra: skirtCone, share: 0.18,
    profile: over ? { y: R.shoeTop, w: 0.12, below: Math.max(thick, CUFF), above: thick } : null });
  if (outfit.shoes !== 'skin') layers.push({ layer: REGION.shoes, mask: masks.shoes, thickness: 0.06, share: 0.06,
    profile: over ? { y: R.pantsFloor - 0.04, w: 0.1, below: 0.06, above: 0.02 } : null });

  const B = p.polyBudget;
  const handJobs = ['A', 'B'].map((side) => {
    const hp = hands[side].map(toPrim);
    return {
      side, prims: hp.map((q) => ({ ...q, matrix: q.matrix.toArray() })), cell: cellFor(hp, 0.022 * p.handSize),
      opts: { inflate: fat * 0.07, clay: p.clay * 0.3, seed: p.seed }, budget: Math.round(B * 0.1),
    };
  });
  const covered = (x, y, z) => layers.some((l) => l.mask(R, x, y, z) < -0.06);
  return { prims, sdf, sdfOpts, plainPrims, layers, R, B, cell, handJobs, covered };
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
