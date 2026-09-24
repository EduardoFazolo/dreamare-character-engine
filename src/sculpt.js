import * as THREE from 'three';
import { BodySDF, GarmentField, sampleGrid, splitNets, deriveGrid, polygonize, simplify, shade, sdRoundCone } from './sdf.js';

// Sculpted character in layers, all from one sampled grid:
//   skin body (limbs blend into the torso, never into each other) + two finer-grid hands
//   garments: shells = body pushed out by a thickness, cut to a region (shirt, pants|skirt, shoes)
// Skin fully covered by a garment is removed, so nothing pokes through and no triangles are wasted.

export const REGION = { top: 0, bottom: 1, shoes: 2, skin: 3 };
export const REGION_NAMES = ['top', 'bottom', 'shoes', 'skin'];

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

export const masks = {
  top(R, x, y, z) {
    const ax = Math.abs(x), len = R.wristX - R.shoulderX;
    if (ax > R.shoulderX * 0.95 && Math.abs(y - R.shoulderY) < R.armBand) return ((ax - R.shoulderX) / len - Math.min(R.sleeve, 1)) * len;
    // collar = a round hole around the neck (a flat cut would slice off the shoulder tops)
    const hole = R.neckHole - Math.hypot(x, z - R.neckZ);
    return Math.max(R.waistY - 0.15 - y, Math.min(hole, y - (R.collarY - 0.12)));
  },
  bottom(R, x, y) {
    if (R.skirt) return Math.max(y - (R.waistY + 0.05), R.hemY - y);
    let m = y - R.waistY;
    const span = R.crotchY - R.ankleY;
    if (y < R.crotchY) m = Math.max(m, ((R.crotchY - y) / span - R.pants) * span);
    return Math.max(m, R.ankleY - 0.02 - y);
  },
  shoes(R, x, y) { return y - (R.ankleY + 0.1); },
};

export function sculptBody(body, p, model, R, outfit) {
  const f = 1 + Math.min(0, p.fat) * 0.5;
  const toPrim = (q) => thin({ ...q, matrix: model(q.joint) }, f);
  const prims = body.sculpt.body.map(toPrim);

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
    prims.push({ type: 'ellipsoid', matrix: h.matrix, group: h.group, c: c.toArray(), r: [rad, rad * (0.8 + 0.4 * rnd()), rad], k: rad * 0.6, soft: true });
  }

  // garments
  const fuzz = outfit.fuzz || 0;
  const thick = 0.035 + p.looseness * 0.15 + fuzz * 0.5;
  const dims = body.sculpt.dims;
  let skirtCone = null;
  if (R.skirt) {
    const top = [0, R.waistY - 0.05, R.hipZ], bot = [0, R.hemY, R.hipZ];
    const r1 = dims.waistR + thick, r2 = dims.hipR * (1.25 + 0.6 * p.looseness) + thick;
    skirtCone = (x, y, z) => sdRoundCone(x, y, R.hipZ + (z - R.hipZ) * 1.3, top, bot, r1, r2);
    // ghost prim: no body volume, only makes sure the grid covers the flared hem
    prims.push({ type: 'cone', ghost: true, matrix: new THREE.Matrix4(), a: top, b: bot, r1, r2, k: 0 });
  }
  const fat = Math.max(0, p.fat);
  const sdf = new BodySDF(prims, { inflate: fat * 0.28, clay: p.clay, sag: p.sag * 1.5, seed: p.seed, pad: thick + 0.08, sagFloor: R.crotchY + 0.2 });
  const layers = [];
  if (outfit.top !== 'skin') layers.push({ layer: REGION.top, mask: masks.top, thickness: thick, fuzz, share: 0.22 });
  if (outfit.bottom !== 'skin') layers.push({ layer: REGION.bottom, mask: masks.bottom, thickness: thick, fuzz, extra: skirtCone, share: 0.18 });
  if (outfit.shoes !== 'skin') layers.push({ layer: REGION.shoes, mask: masks.shoes, thickness: 0.06, share: 0.06 });

  const B = p.polyBudget;
  const grid = sampleGrid(sdf, cellFor(prims, 0.07));
  const bodyShare = 0.8 - layers.reduce((s, l) => s + l.share, 0) * 0.6;
  const covered = (x, y, z) => layers.some((l) => l.mask(R, x, y, z) < -0.06);

  const parts = [];
  // each leg sculpted in its own pass (the other leg doesn't exist there), welded at the centerline
  const left = sdf.view('legA'), right = sdf.view('legB');
  const seamY = R.crotchY - 0.05;
  const skin = cull(simplify(splitNets(grid, grid.valL, grid.valR, left, right, seamY), Math.round(B * bodyShare)), covered);
  parts.push({ ...skin, field: sdf, kind: 'body', layer: REGION.skin });
  for (const l of layers) {
    const make = (body) => new GarmentField(body, { thickness: l.thickness, mask: (x, y, z) => l.mask(R, x, y, z), extra: l.extra, fuzz: l.fuzz });
    const fl = make(left), fr = make(right);
    const mesh = simplify(splitNets(grid, deriveGrid(grid, fl, grid.valL), deriveGrid(grid, fr, grid.valR), fl, fr, seamY), Math.round(B * l.share));
    if (mesh.indices.length) parts.push({ ...mesh, field: make(sdf), kind: 'garment', layer: l.layer });
  }
  for (const side of ['A', 'B']) {
    const hp = body.sculpt.hands[side].map(toPrim);
    const hsdf = new BodySDF(hp, { inflate: fat * 0.07, clay: p.clay * 0.3, seed: p.seed });
    const mesh = cull(simplify(polygonize(hsdf, cellFor(hp, 0.022 * p.handSize)), Math.round(B * 0.1)), covered);
    parts.push({ ...mesh, field: hsdf, kind: side === 'A' ? 'handRight' : 'handLeft', layer: REGION.skin });
  }

  // the render mesh, not the proxies, defines ground contact: flatten soles onto y = 0
  for (const part of parts) {
    if (part.kind !== 'body' && part.layer !== REGION.shoes) continue;
    const P = part.positions;
    for (let i = 1; i < P.length; i += 3) if (P[i] < 0.03) P[i] = 0;
  }
  for (const part of parts) Object.assign(part, shade(part.field, part.positions));
  return parts.filter((part) => part.indices.length);
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
