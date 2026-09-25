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
  // beads along the mask rim, slightly behind it: the skull passes just around the photo's edge (whose
  // ring is then laid onto it, see snapRim)
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
  const rim = snapRim(P, loop, sdf);
  skull.indices = pushBehindMask(skull.positions, skull.indices, rim.Ps, maskIndex, loop);
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
  const band = buildBand(P, loop, [prims[0], prims[1], prims[2], ...earPrims]);
  return { skull, band, maskDz: rim.dz, hair, hat: hatMesh, hatFit: { line0, R, tilt: Math.atan(0.06), z: D.sideZ - 0.02, brim: hsp?.brim || null, crownFront, frontY: line(crownFront) }, dims: D, slick: hs?.slick ? 1 : 0 };
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

// The rest of the head, grown from the face's outline so face and head are ONE mesh (shared rim vertices,
// shared shading: no mask plate on a skull). Every outline point sends a path over the head toward a pole
// at the back (forehead over the scalp, cheeks around past the ears, the jaw under the chin), BAND_RINGS
// rings each, laid on the sculpted head (cranium, occiput, jaw, ears: no neck stub, no rim beads). The
// first rings ease from the face's rim onto that surface. Returns ring vertices (ring k, outline point i
// at 468 + (k - 1) * n + i; ring 0 is the face's own outline), their normalized ring index, and the
// triangles joining them (outward winding).
export const BAND_RINGS = 10;
function buildBand(P, loop, headPrims) {
  const sdf = new BodySDF(headPrims, {});
  const C = new THREE.Vector3().fromArray(headPrims[0].c), n = loop.length, K = BAND_RINGS;
  const pole = new THREE.Vector3(0, -0.12, -1).normalize();
  // each path swings first toward its own direction around the face (the forehead up over the scalp, the
  // chin down under the jaw, cheeks out past the ears), then on to the pole: a straight great circle to
  // the pole went under the chin from the forehead when a tall cranium put the head's center up at the brow
  let fx = 0, fy = 0; for (const i of loop) { fx += P[i][0] / loop.length; fy += P[i][1] / loop.length; }
  const surf = (dir) => { // outermost head surface along dir from C
    let t = 3;
    for (let k = 0; k < 300 && t > 0; k++) { const q = C.clone().addScaledVector(dir, t), d = sdf.eval(q.x, q.y, q.z); if (d < 1e-3) break; t -= Math.max(d, 0.004); }
    return C.clone().addScaledVector(dir, Math.max(t, 0.05));
  };
  const slerp = (a, b, s) => { const w = Math.acos(Math.min(1, Math.max(-1, a.dot(b)))); if (w < 1e-4) return a.clone(); return a.clone().multiplyScalar(Math.sin((1 - s) * w) / Math.sin(w)).addScaledVector(b, Math.sin(s * w) / Math.sin(w)).normalize(); };
  const pos = new Float32Array(K * n * 3), ring = new Float32Array(K * n);
  for (let i = 0; i < n; i++) {
    const rim = new THREE.Vector3(...P[loop[i]]), d0 = rim.clone().sub(C).normalize();
    const th = Math.atan2(P[loop[i]][1] - fy, P[loop[i]][0] - fx), mid = new THREE.Vector3(Math.cos(th), Math.sin(th), -0.15).normalize();
    const path = (s) => (s < 0.45 ? slerp(d0, mid, s / 0.45) : slerp(mid, pole, (s - 0.45) / 0.55));
    const delta = rim.clone().sub(surf(d0)); // the face's rim relative to the head surface there
    for (let k = 1; k <= K; k++) {
      const s = Math.pow(k / K, 1.25), q = k === K ? surf(pole) : surf(path(s));
      const u = Math.min(1, s / 0.3), w = 1 - u * u * (3 - 2 * u); // ease off the rim's offset
      q.addScaledVector(delta, w);
      pos.set([q.x, q.y, q.z], ((k - 1) * n + i) * 3); ring[(k - 1) * n + i] = k / K;
    }
  }
  const id = (k, i) => (k === 0 ? loop[i] : 468 + (k - 1) * n + (i % n));
  const tri = [];
  for (let k = 0; k < K; k++) for (let i = 0; i < n; i++) tri.push(id(k, i), id(k, i + 1), id(k + 1, i + 1), id(k, i), id(k + 1, i + 1), id(k + 1, i));
  // outward winding: test one triangle on ring 1..2 against the direction from C
  const at = (v) => (v < 468 ? new THREE.Vector3(...P[v]) : new THREE.Vector3().fromArray(pos, (v - 468) * 3));
  const t0 = n * 6; const a = at(tri[t0]), b = at(tri[t0 + 1]), c = at(tri[t0 + 2]);
  if (b.clone().sub(a).cross(c.clone().sub(a)).dot(a.clone().add(b).add(c).multiplyScalar(1 / 3).sub(C)) < 0) for (let t = 0; t < tri.length; t += 3) { const x = tri[t + 1]; tri[t + 1] = tri[t + 2]; tri[t + 2] = x; }
  return { positions: pos, ring, index: new Uint32Array(tri), n };
}

// The mask's outer ring is laid onto the skull (snapRim), and the skull stays behind the mask everywhere
// inside the outline, so the two surfaces meet in one smooth curve (the face outline) and never cross:
// crossing, the skull's bumps (the rim beads) cut a wavy, scalloped line through the face's rim.
// Exact, no grid: the footprint is the mask's own outline polygon (point-in-polygon), the depth comes
// from the containing mask triangle. The gap behind the mask grows from MIN_GAP at the outline (where
// the mask lies on the skull: sub-pixel, no lip) to BEHIND_MASK by RIM_CORE in, where the photo shows.
// Triangles deeper than HIDDEN_BAND are dropped (never seen), and every kept triangle is sampled so a
// flat one spanning a hollow of the face (eye socket, beside the nose) can't cut in front of it even with
// its vertices behind. Returns the kept indices.
const BEHIND_MASK = 0.03, MIN_GAP = 0.004, RIM_CORE = 0.12, HIDDEN_BAND = 0.14;
const gapAt = (e) => { const u = Math.min(1, e / RIM_CORE); return MIN_GAP + (BEHIND_MASK - MIN_GAP) * u * u * (3 - 2 * u); };

// The mask's outer ring (within RIM_CORE of its outline) eases onto the skull's front surface (ray-
// marched in the skull field): exactly on it at the outline, the mask's own shape by RIM_CORE in.
// Returns the snapped points and each point's z offset (the head applies these to the live mask).
function snapRim(P, loop, sdf) {
  const poly = loop.map((i) => [P[i][0], P[i][1]]);
  const Ps = P.map((v) => v.slice()), dz = new Float32Array(P.length);
  for (let i = 0; i < P.length; i++) {
    const [x, y, z0] = P[i];
    let e = Infinity;
    for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
      const [ax, ay] = poly[b], [bx, by] = poly[a], ex = bx - ax, ey = by - ay;
      const t = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey)));
      e = Math.min(e, Math.hypot(x - ax - ex * t, y - ay - ey * t));
    }
    if (e >= RIM_CORE) continue;
    let z = z0 + 0.3, hit = false;
    for (let k = 0; k < 200 && z > z0 - 0.3; k++) {
      const d = sdf.eval(x, y, z);
      if (d < 1e-4) { hit = true; break; }
      z -= Math.max(d, 0.002);
    }
    if (!hit) continue;
    const u = e / RIM_CORE, w = u * u * (3 - 2 * u);
    Ps[i][2] = z + (z0 - z) * w;
    dz[i] = Ps[i][2] - z0;
  }
  return { Ps, dz };
}
function pushBehindMask(pos, index, P, tri, loop) {
  const poly = loop.map((i) => [P[i][0], P[i][1]]);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, y] of poly) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  // triangle buckets for the depth lookup
  const N = 24, buckets = Array.from({ length: N * N }, () => []);
  const bi = (x) => Math.min(N - 1, Math.max(0, Math.floor(((x - x0) / (x1 - x0)) * N)));
  const bj = (y) => Math.min(N - 1, Math.max(0, Math.floor(((y - y0) / (y1 - y0)) * N)));
  for (let t = 0; t < tri.length; t += 3) {
    const xs = [P[tri[t]][0], P[tri[t + 1]][0], P[tri[t + 2]][0]], ys = [P[tri[t]][1], P[tri[t + 1]][1], P[tri[t + 2]][1]];
    for (let j = bj(Math.min(...ys)); j <= bj(Math.max(...ys)); j++) for (let i = bi(Math.min(...xs)); i <= bi(Math.max(...xs)); i++) buckets[j * N + i].push(t);
  }
  const depth = (x, y) => {
    let best = -Infinity;
    for (const t of buckets[bj(y) * N + bi(x)]) {
      const a = P[tri[t]], b = P[tri[t + 1]], c = P[tri[t + 2]];
      const den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
      if (Math.abs(den) < 1e-12) continue;
      const l1 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / den, l2 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / den, l3 = 1 - l1 - l2;
      if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
      best = Math.max(best, l1 * a[2] + l2 * b[2] + l3 * c[2]);
    }
    return best;
  };
  const inside = (x, y) => {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  // distance to the outline
  const edgeDist = (x, y) => {
    let d = Infinity;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [ax, ay] = poly[j], [bx, by] = poly[i], ex = bx - ax, ey = by - ay;
      const t = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey)));
      const dd = Math.hypot(x - ax - ex * t, y - ay - ey * t);
      d = Math.min(d, dd);
    }
    return d;
  };
  const deep = new Uint8Array(pos.length / 3);
  for (let v = 0; v < pos.length; v += 3) {
    const x = pos[v], y = pos[v + 1];
    if (!inside(x, y)) continue;
    const e = edgeDist(x, y);
    if (e > HIDDEN_BAND) deep[v / 3] = 1;
    const d = depth(x, y);
    if (d === -Infinity) continue;
    pos[v + 2] = Math.min(pos[v + 2], d - gapAt(e));
  }
  const keep = [];
  for (let t = 0; t < index.length; t += 3) if (!(deep[index[t]] && deep[index[t + 1]] && deep[index[t + 2]])) keep.push(index[t], index[t + 1], index[t + 2]);
  // Vertices behind the mask don't make a flat triangle behind it where the face curves more than the
  // margin across it: sample each kept triangle (vertices, edge midpoints, centroid) and push the whole
  // triangle back by any overshoot, until none is left (only ever backwards, only near/inside the mask).
  const near = new Uint8Array(pos.length / 3);
  for (let v = 0; v < pos.length; v += 3) near[v / 3] = inside(pos[v], pos[v + 1]) ? 1 : 0;
  const W = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0.5, 0.5, 0], [0, 0.5, 0.5], [0.5, 0, 0.5], [1 / 3, 1 / 3, 1 / 3]];
  for (let pass = 0; pass < 6; pass++) {
    let moved = 0;
    for (let t = 0; t < keep.length; t += 3) {
      const a = keep[t] * 3, b = keep[t + 1] * 3, c = keep[t + 2] * 3;
      if (!near[a / 3] && !near[b / 3] && !near[c / 3]) continue;
      let over = 0;
      for (const [wa, wb, wc] of W) {
        const x = wa * pos[a] + wb * pos[b] + wc * pos[c], y = wa * pos[a + 1] + wb * pos[b + 1] + wc * pos[c + 1];
        if (!inside(x, y)) continue;
        const d = depth(x, y);
        if (d === -Infinity) continue;
        over = Math.max(over, wa * pos[a + 2] + wb * pos[b + 2] + wc * pos[c + 2] - (d - gapAt(edgeDist(x, y)) / 2));
      }
      if (over <= 0) continue;
      for (const v of [a, b, c]) if (near[v / 3]) pos[v + 2] -= over + 0.005;
      moved++;
    }
    if (!moved) break;
  }
  return new Uint32Array(keep);
}
