import * as THREE from 'three';
import { perf } from './perf.js';
import { fuzzFreqFor, hemFor, BodySDF, GarmentField, sampleGrid, surfaceNets, deriveGrid, simplify, shade, sdRoundCone, sdEllipsoidAt, sdRoundBoxAt, gradientOf, smax, smin } from './sdf.js';

// Sculpted head (head-local units, face width = 1): cranium, occiput, jaw, ears and a neck stub,
// plus beads along the face mask's rim so the skull always swallows the photo's messy border.
// The skull is then pushed behind the mask wherever the face shows. Hair is a shell over the
// skull (like clothing), cut by per-style masks.

export const HAIR_STYLES = ['auto', 'bald', 'buzz', 'short', 'bowl', 'horseshoe', 'slicked', 'mullet', 'long', 'afro',
  'mohawk', 'pompadour', 'bun', 'ponytail', 'pigtails', 'spiky'];
export const HAT_TYPES = ['none', 'bowler', 'cowboy', 'fedora', 'tophat', 'beanie', 'cap', 'flatcap', 'fez', 'wizard'];

export function headDims(P) {
  const eyeY = (P[33][1] + P[263][1]) / 2;
  return {
    top: P[10][1], chin: P[152][1], eyeY, browY: P[9][1], frontZ: P[151][2],
    sideX: Math.max(Math.abs(P[234][0]), Math.abs(P[454][0])), sideZ: (P[234][2] + P[454][2]) / 2,
    earY: eyeY - 0.14, earTop: eyeY + 0.08,
  };
}

// Where the head turns: the head joint, in head-local units (body.js places the head so). Rigid head parts
// reaching far below it swing out of the body's neck when the head nods (a second neck).
export const HEAD_PIVOT = [0, -0.6, -0.22];

const I4 = new THREE.Matrix4();
const ell = (c, r, k) => ({ type: 'ellipsoid', matrix: I4, c, r, k });

// The head is meshed on a fixed grid. Like clothing, every cut combining hair regions is rounded by
// 1.5 cells (hemFor): a knife edge between two cuts can't be meshed, it turns into folded teeth.
const HEAD_CELL = 0.035, K = hemFor(HEAD_CELL);
const SMAX = (...v) => v.reduce((a, b) => smax(a, b, K)), SMIN = (...v) => v.reduce((a, b) => smin(a, b, K));

// negative inside the hair region (same convention as clothing masks)
// fringeMin: the face zone reaches at least this high (a hat's line can leave a fringe band too thin
// to mesh between itself and the style's own fringe cut; sculptHead raises it then)
export function hairSpec(style, D, vol, fringeMin = -Infinity) {
  const zf = D.sideZ + 0.06; // in front of this and below the hairline is face
  const hairline = D.top - 0.03;
  const TIP = 2 * HEAD_CELL; // thinnest tail radius the head grid resolves
  const back = (z) => Math.min(1, Math.max(0, (D.sideZ - z) / 0.45)); // 0 at the sides, 1 at the back
  const cut = (y, z, front, rear) => front + (rear - front) * back(z) - y; // > 0 below the cut line
  const face = (y, z, line) => SMIN(Math.max(line, fringeMin) - y, z - zf); // > 0 inside the face zone
  // > 0 in front of: the ear plane beside the face, the neck's centre plane below the jaw (D.neck: proxy)
  const behindJaw = (y, z) => z - (D.neck.z + (D.sideZ + 0.02 - D.neck.z) * Math.min(1, Math.max(0, (y - (D.chin - 0.1)) / 0.3)));
  let s;
  switch (style) {
    case 'short': s = { t: 0.07, mask: (x, y, z) => SMAX(cut(y, z, D.earTop, D.chin + 0.12), face(y, z, hairline)) }; break;
    case 'slicked': s = { t: 0.035, slick: 1, fringe: hairline + 0.03, mask: (x, y, z) => SMAX(cut(y, z, D.earTop, D.chin + 0.12), face(y, z, hairline + 0.03)) }; break;
    case 'bowl': s = { t: 0.1, fringe: D.browY + 0.1, mask: (x, y, z) => SMAX(cut(y, z, D.earTop + 0.04, D.earTop - 0.12), face(y, z, D.browY + 0.1)) }; break;
    case 'horseshoe': s = {
      t: 0.05,
      mask: (x, y, z) => SMAX(cut(y, z, D.earY + 0.05, D.chin + 0.12), face(y, z, hairline), SMIN(y - (D.eyeY + 0.3), z - (D.sideZ - 0.5))),
    }; break;
    case 'mullet': s = {
      t: 0.07,
      mask: (x, y, z) => SMAX(cut(y, z, D.earTop, D.chin - 0.75), face(y, z, hairline)),
      extra: (x, y, z) => sdRoundBoxAt(x, y, z, [0, D.chin - 0.3, D.sideZ - 0.4], [D.sideX * 0.7, 0.4, 0.14], 0.1),
      bounds: [[-D.sideX, D.chin - 0.8, D.sideZ - 0.6], [D.sideX, D.chin + 0.2, D.sideZ - 0.2]],
    }; break;
    case 'long': s = {
      t: 0.07,
      // (the shell obeys the same below-the-jaw rule as the slab: it wraps the neck proxy, which is fatter
      // than a thin real neck and showed as a dark collar under the chin)
      mask: (x, y, z) => smax(SMAX(cut(y, z, D.chin - 0.15, D.chin - 1.0), face(y, z, hairline)), behindJaw(y, z), 0.15),
      // Beside the face it hangs behind the ears; below the jaw it hangs behind the neck's centre plane
      // (D.neck: the body-neck proxy), so it can never cover the throat or the chest.
      // (wider than the hair around the neck by 3 cells: coinciding side faces mesh into slivers)
      // (that cut is rounded wide, 0.15: its flat face showed from the front as cardboard flaps)
      extra: (x, y, z) => smax(SMAX(sdRoundBoxAt(x, y, z, [0, D.chin - 0.35, D.sideZ - 0.12], [Math.max(D.sideX + 0.1, D.neck.r + 0.07 * vol + 3 * HEAD_CELL), 0.6, 0.34], 0.14), face(y, z, hairline)),
        behindJaw(y, z), 0.15),
      bounds: [[-D.sideX - 0.3, D.chin - 1.05, D.sideZ - 0.55], [D.sideX + 0.3, D.chin + 0.3, D.sideZ + 0.3]],
    }; break;
    case 'afro': s = { t: 0.3, fuzz: 0.12, fringe: hairline + 0.05, mask: (x, y, z) => SMAX(cut(y, z, D.earY, D.chin + 0.1), face(y, z, hairline + 0.05)) }; break;
    case 'mohawk': s = { t: 0.26, mask: (x, y, z) => SMAX(cut(y, z, D.earTop + 0.1, D.chin + 0.15), face(y, z, hairline), Math.abs(x) - 0.11) }; break;
    case 'spiky': s = { t: 0.13, fuzz: 0.14, mask: (x, y, z) => SMAX(cut(y, z, D.earTop, D.chin + 0.12), face(y, z, hairline)) }; break;
    case 'pompadour': s = {
      t: 0.06,
      mask: (x, y, z) => SMAX(cut(y, z, D.earTop, D.chin + 0.12), face(y, z, hairline)),
      extra: (x, y, z) => sdEllipsoidAt(x, y, z, [0, D.top + 0.12, D.frontZ - 0.12], [0.32, 0.2, 0.3]),
      bounds: [[-0.45, D.top - 0.2, D.frontZ - 0.5], [0.45, D.top + 0.45, D.frontZ + 0.3]],
    }; break;
    case 'bun': s = {
      t: 0.04,
      mask: (x, y, z) => SMAX(cut(y, z, D.earTop, D.chin + 0.15), face(y, z, hairline)),
      extra: (x, y, z) => sdEllipsoidAt(x, y, z, [0, D.top + 0.1, D.sideZ - 0.86], [0.22, 0.22, 0.22]), // behind the crown
      bounds: [[-0.35, D.top - 0.25, D.sideZ - 1.2], [0.35, D.top + 0.45, D.sideZ - 0.5]],
    }; break;
    case 'ponytail': s = {
      t: 0.04,
      mask: (x, y, z) => SMAX(cut(y, z, D.earTop, D.chin + 0.15), face(y, z, hairline)),
      extra: (x, y, z) => sdRoundCone(x, y, z, [0, D.eyeY + 0.12, D.sideZ - 0.62], [0, D.chin - 0.45, D.sideZ - 0.72], 0.12, TIP),
      bounds: [[-0.3, D.chin - 0.65, D.sideZ - 1.0], [0.3, D.eyeY + 0.4, D.sideZ - 0.3]],
    }; break;
    case 'pigtails': s = {
      t: 0.04,
      mask: (x, y, z) => SMAX(cut(y, z, D.earTop, D.chin + 0.15), face(y, z, hairline)),
      extra: (x, y, z) => SMIN(
        sdRoundCone(x, y, z, [D.sideX + 0.02, D.eyeY + 0.05, D.sideZ - 0.2], [D.sideX + 0.28, D.chin - 0.25, D.sideZ - 0.25], 0.1, TIP),
        sdRoundCone(x, y, z, [-D.sideX - 0.02, D.eyeY + 0.05, D.sideZ - 0.2], [-D.sideX - 0.28, D.chin - 0.25, D.sideZ - 0.25], 0.1, TIP)),
      bounds: [[-D.sideX - 0.5, D.chin - 0.45, D.sideZ - 0.5], [D.sideX + 0.5, D.eyeY + 0.3, D.sideZ + 0.05]],
    }; break;
    default: return null; // bald, buzz (buzz is painted as stubble)
  }
  s.t *= vol;
  s.fringe ??= hairline;
  return s;
}

// stubble region for 'buzz' (and the scalp line for everything with hair)
export const stubbleMask = (D) => hairSpec('short', D, 1).mask;

export function sculptHead(P, loop, maskIndex, p, style, hat = 'none') {
  const D = headDims(P);
  const c = p.headDepth, cr = p.cranium, ear = Math.max(0.2, p.earSize);
  const nr = (0.24 * Math.sqrt(p.girth)) / p.headScale; // body neck radius, in head-local units
  // Hair lies on the body's neck, not on the skull's thin stub: the body neck is fattened by fat and
  // clay (sculpt.js), and hair around the stub alone lets it poke out through hanging hair. The hair
  // shell is grown around this proxy: the stub's axis, the body neck's widest radius (1.25 neckR at
  // its base + fat inflation + clay noise amplitude), so it is never smaller than the real neck.
  const neckA = [0, D.chin + 0.15, D.sideZ - 0.22], neckB = [0, D.chin - 1.1, D.sideZ - 0.36];
  const neckRMax = (1.25 * 0.24 * Math.sqrt(p.girth) + 0.28 * Math.max(0, p.fat || 0) + 0.0625 * (p.clay || 0)) / p.headScale;
  const neckProxy = (x, y, z) => sdRoundCone(x, y, z, neckA, neckB, neckRMax, neckRMax);
  D.neck = { z: (neckA[2] + neckB[2]) / 2, r: neckRMax };
  const prims = [
    ell([0, D.eyeY + 0.18 + 0.12 * cr, D.sideZ - 0.08 - 0.12 * c], [D.sideX + 0.05, D.top - D.eyeY + 0.35 + 0.3 * cr, 0.6 + 0.25 * c], 0.15),
    ell([0, D.eyeY + 0.02, D.sideZ - 0.32 - 0.2 * c], [D.sideX * 0.88, 0.5, 0.42 + 0.15 * c], 0.2),
    ell([0, (D.eyeY + D.chin) / 2 - 0.04, D.sideZ + 0.02], [D.sideX * 0.9, (D.eyeY - D.chin) / 2 + 0.1, 0.4], 0.2),
    // neck stub: fills the jaw down to just below the pivot (the body's neck, which bends with the head,
    // covers the rest); any longer and it swings out of the neck when the head nods
    { type: 'cone', matrix: I4, a: [0, D.chin + 0.15, D.sideZ - 0.22], b: [0, Math.min(D.chin - 0.05, HEAD_PIVOT[1] - 0.12), D.sideZ - 0.26], r1: nr * 1.1, r2: nr, k: 0.12 },
  ];
  // beads along the face's rim, slightly behind it: the skull (which shapes hair and hats) hugs the face
  for (const i of loop) prims.push(ell([P[i][0], P[i][1], P[i][2] - 0.025], [0.05, 0.05, 0.05], 0.06));
  const earPrims = [-1, 1].map((sx) => ell([sx * (D.sideX + 0.02), D.earY, D.sideZ - 0.1], [0.055 * ear, 0.2 * Math.sqrt(ear), 0.13 * Math.sqrt(ear)], 0.05));
  prims.push(...earPrims);

  let hs = hairSpec(style, D, p.hairVolume);
  // a hat sits on a line just above the brow (front a touch lower); hair only shows below it
  const hatT = hat !== 'none' ? (hs ? hs.t * 0.6 : 0) + 0.06 : 0;
  const skullTop = D.eyeY + 0.18 + 0.12 * cr + (D.top - D.eyeY + 0.35 + 0.3 * cr); // cranium ellipsoid top
  const R = D.sideX + 0.05 + hatT;
  const hsp = hat !== 'none' ? hatSpec(hat, D, R, skullTop + hatT) : null;
  const line0 = D.top - 0.1 + (hsp?.lift || 0), line = (z) => line0 - 0.06 * (z - D.sideZ);
  if (hs && hsp) {
    // a fringe band between the style's fringe cut and the hat line thinner than 3 cells can't be
    // meshed (folded teeth): lift the face zone over the hat line at the front instead
    const top = line(D.frontZ) + 0.04, band = top - hs.fringe;
    if (band > 0 && band < 3 * HEAD_CELL) hs = hairSpec(style, D, p.hairVolume, top + HEAD_CELL);
  }
  if (hs && hsp) { // tucks just under the brim; extras (bun, ponytail...) are cut at the hat line too
    const m = hs.mask; hs.mask = (x, y, z) => smax(m(x, y, z), y - line(z) - 0.04, K);
    if (hs.extra) {
      const e = hs.extra; hs.extra = (x, y, z) => smax(e(x, y, z), y - line(z) - 0.04, K);
      // what the hat line leaves of an extra (a bun on the crown...) can be a lens thinner than the grid
      // resolves: sample its deepest point, drop it if under 1.5 cells (it's under the hat anyway)
      const [lo, hi] = hs.bounds;
      let depth = 0;
      for (let x = lo[0]; x <= hi[0]; x += HEAD_CELL) for (let y = lo[1]; y <= hi[1]; y += HEAD_CELL) for (let z = lo[2]; z <= hi[2]; z += HEAD_CELL) depth = Math.max(depth, -hs.extra(x, y, z));
      if (depth < K) { delete hs.extra; delete hs.bounds; }
    }
  }
  if (hsp?.top) prims.push({ type: 'cone', ghost: true, matrix: I4, a: [0, line0, D.sideZ - 0.1], b: [0, hsp.top, D.sideZ - 0.1], r1: R + 0.1, r2: R + 0.1, k: 0 });
  if (hs) prims.push({ type: 'cone', ghost: true, matrix: I4, a: neckA, b: neckB, r1: neckRMax, r2: neckRMax, k: 0 });
  if (hs?.bounds) {
    const [lo, hi] = hs.bounds; // ghost: no volume, only grows the sampled grid for hanging hair
    prims.push({ type: 'box', ghost: true, matrix: I4, c: lo.map((v, k) => (v + hi[k]) / 2), b: lo.map((v, k) => (hi[k] - v) / 2), round: 0, k: 0 });
  }
  const sdf = new BodySDF(prims, { pad: Math.max(hs ? hs.t + (hs.fuzz || 0) : 0, hatT + 0.05) + 0.06 });
  const grid = perf.time('head.grid', () => sampleGrid(sdf, HEAD_CELL));

  const skull = perf.time('head.skullNets', () => simplify(surfaceNets(grid, grid.val, sdf), 900));
  Object.assign(skull, perf.time('head.shade', () => shade(sdf, skull.positions)));
  const stub = stubbleMask(D);
  skull.aux = new Float32Array(skull.positions.length / 3);
  if (style === 'buzz') for (let i = 0; i < skull.aux.length; i++) {
    skull.aux[i] = Math.min(1, Math.max(0, -stub(skull.positions[i * 3], skull.positions[i * 3 + 1], skull.positions[i * 3 + 2]) / 0.08));
  }

  let hair = null;
  if (hs) {
    const base = { eval: (x, y, z) => smin(sdf.eval(x, y, z), neckProxy(x, y, z), K) };
    const val = grid.val.slice();
    for (let k = 0, at = 0; k < grid.nz; k++) for (let j = 0; j < grid.ny; j++) for (let i = 0; i < grid.nx; i++, at++) {
      val[at] = smin(val[at], neckProxy(grid.o.x + i * grid.cell, grid.o.y + j * grid.cell, grid.o.z + k * grid.cell), K);
    }
    const field = new GarmentField(base, { thickness: hs.t, mask: hs.mask, extra: hs.extra || null, fuzz: hs.fuzz || 0, fuzzFreq: fuzzFreqFor(grid.cell), hem: hemFor(grid.cell), hemShift: 0 }); // (hair: its cut rules assume no shift)
    const mesh = perf.time('head.hairNets', () => simplify(surfaceNets(grid, deriveGrid(grid, field, val), field), 800));
    if (mesh.indices.length) hair = { ...mesh, ...perf.time('head.shade', () => shade(field, mesh.positions)) };
  }
  // hat crown: a shell fitted around skull + forehead, cut at the hat line (cowboy: taller crown)
  let hatMesh = null;
  if (hat !== 'none') {
    const env = (x, y, z) => sdEllipsoidAt(x, y, z, [0, D.eyeY + 0.25, D.sideZ], [D.sideX + 0.03, 0.5, D.frontZ - D.sideZ + 0.06]);
    const tall = hsp.shape ? (x, y, z) => hsp.shape(x, y, z, line0) : null;
    const field = {
      thickness: hatT, fuzz: 0, extra: true, // (no fast path: the envelope can be closer than the skull)
      fromBody(d, x, y, z) {
        let v = hsp.noShell ? 1e3 : smin(d, env(x, y, z), K) - hatT;
        if (tall) v = smin(v, tall(x, y, z), K);
        if (hsp.flatTop) v = smax(v, y - hsp.flatTop, K);
        return smax(v, line(z) - y, hemFor(grid.cell));
      },
      eval(x, y, z) { return this.fromBody(sdf.eval(x, y, z), x, y, z); },
      gradient(x, y, z) { return gradientOf(this, x, y, z); },
    };
    const mesh = simplify(surfaceNets(grid, deriveGrid(grid, field), field), 500);
    if (mesh.indices.length) {
      hatMesh = { ...mesh, ...shade(field, mesh.positions) };
      // cylindrical UVs: band just above the brim, felt around
      const top = Math.max(...Array.from({ length: mesh.positions.length / 3 }, (_, i) => mesh.positions[i * 3 + 1]));
      hatMesh.uv = new Float32Array((mesh.positions.length / 3) * 2);
      for (let i = 0; i < mesh.positions.length / 3; i++) {
        const x = mesh.positions[i * 3], y = mesh.positions[i * 3 + 1], z = mesh.positions[i * 3 + 2];
        hatMesh.uv[i * 2] = (Math.atan2(z - D.sideZ, x) / (2 * Math.PI) + 0.5) * 3;
        hatMesh.uv[i * 2 + 1] = (y - line(z)) / Math.max(0.1, top - line0);
      }
    }
  }
  let crownFront = D.frontZ;
  if (hatMesh) for (let i = 0; i < hatMesh.positions.length / 3; i++) {
    const x = hatMesh.positions[i * 3], y = hatMesh.positions[i * 3 + 1], z = hatMesh.positions[i * 3 + 2];
    if (Math.abs(x) < 0.15 && Math.abs(y - line(z)) < 0.08) crownFront = Math.max(crownFront, z);
  }
  return { skull, hair, hat: hatMesh, hatFit: { line0, R, tilt: Math.atan(0.06), z: D.sideZ - 0.02, brim: hsp?.brim || null, crownFront, frontY: line(crownFront) }, dims: D, slick: hs?.slick ? 1 : 0 };
}

// Hat types: shape added to the fitted shell, where it sits, and its brim. top = extra height.
function hatSpec(hat, D, R, crown) {
  const c = D.sideZ - 0.1;
  const cone = (r1, r2, h) => (x, y, z, line) => sdRoundCone(x, y, z, [0, line, c], [0, crown + h, c], r1, r2);
  switch (hat) {
    case 'bowler': return { brim: { kind: 'round', scale: 1.3 } };
    case 'cowboy': return { shape: cone(R - 0.04, (R - 0.04) * 0.78, 0.04), top: crown + 0.2, brim: { kind: 'round', scale: 1.85 } };
    case 'fedora': return { shape: cone(R - 0.04, (R - 0.04) * 0.84, -0.02), top: crown + 0.15, brim: { kind: 'round', scale: 1.5 } };
    case 'tophat': return { shape: cone(R - 0.03, R - 0.03, 0.45), top: crown + 0.6, brim: { kind: 'round', scale: 1.35 } };
    case 'wizard': return { shape: cone(R - 0.02, 0.06, 1.2), top: crown + 1.35, brim: { kind: 'round', scale: 1.7 } };
    case 'fez': return { lift: 0.2, shape: cone(R * 0.74, R * 0.6, 0.12), top: crown + 0.3 };
    case 'beanie': return { lift: -0.07 };
    case 'cap': return { brim: { kind: 'visor', scale: 1.0 } };
    case 'flatcap': return { flatTop: crown - 0.08, brim: { kind: 'visor', scale: 0.7 } };
    default: return null;
  }
}

