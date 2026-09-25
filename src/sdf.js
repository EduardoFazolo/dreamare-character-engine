import * as THREE from 'three';
import { MeshoptSimplifier } from 'meshoptimizer';
import { perf } from './perf.js';

// Signed distance field of a sculpted body: primitives in their joint's local frame, smooth-unioned,
// polygonized with surface nets, then decimated to a low-poly budget with meshoptimizer.
// Units are head units (face width = 1), model space of the bind (T-) pose.

export const simplifierReady = MeshoptSimplifier.ready;

// ---- primitives (iq's formulas), evaluated in local coordinates ----
function sdRoundCone(px, py, pz, a, b, r1, r2) {
  const bax = b[0] - a[0], bay = b[1] - a[1], baz = b[2] - a[2];
  const l2 = bax * bax + bay * bay + baz * baz, rr = r1 - r2, a2 = l2 - rr * rr, il2 = 1 / l2;
  const pax = px - a[0], pay = py - a[1], paz = pz - a[2];
  const y = pax * bax + pay * bay + paz * baz, z = y - l2;
  const xx = pax * l2 - bax * y, xy = pay * l2 - bay * y, xz = paz * l2 - baz * y;
  const x2 = xx * xx + xy * xy + xz * xz, y2 = y * y * l2, z2 = z * z * l2;
  const k = Math.sign(rr) * rr * rr * x2;
  if (Math.sign(z) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r2;
  if (Math.sign(y) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r1;
  return (Math.sqrt(x2 * a2 * il2) + y * rr) * il2 - r1;
}
function sdEllipsoid(px, py, pz, c, r) {
  const qx = (px - c[0]) / r[0], qy = (py - c[1]) / r[1], qz = (pz - c[2]) / r[2];
  const k0 = Math.sqrt(qx * qx + qy * qy + qz * qz);
  const k1 = Math.sqrt((qx / r[0]) ** 2 + (qy / r[1]) ** 2 + (qz / r[2]) ** 2);
  return k1 < 1e-9 ? -Math.min(r[0], r[1], r[2]) : (k0 * (k0 - 1)) / k1;
}
function sdRoundBox(px, py, pz, c, b, r) {
  const qx = Math.abs(px - c[0]) - b[0] + r, qy = Math.abs(py - c[1]) - b[1] + r, qz = Math.abs(pz - c[2]) - b[2] + r;
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0), oz = Math.max(qz, 0);
  return Math.sqrt(ox * ox + oy * oy + oz * oz) + Math.min(Math.max(qx, qy, qz), 0) - r;
}
function smin(a, b, k) {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

// 3D value noise for the clay look
function hash3(x, y, z, s) {
  let h = (x * 374761393 + y * 668265263 + z * 1274126177 + s * 2654435761) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x, y, z, s) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy), uz = fz * fz * (3 - 2 * fz);
  const L = (a, b, t) => a + (b - a) * t;
  const n = (dx, dy, dz) => hash3(ix + dx, iy + dy, iz + dz, s);
  return L(L(L(n(0, 0, 0), n(1, 0, 0), ux), L(n(0, 1, 0), n(1, 1, 0), ux), uy),
    L(L(n(0, 0, 1), n(1, 0, 1), ux), L(n(0, 1, 1), n(1, 1, 1), ux), uy), uz);
}

// prim: { type: 'cone'|'ellipsoid'|'box', matrix: Matrix4 (joint local -> model), k, soft, ...params }
export class BodySDF {
  // pad: extra evaluated margin around the body (room for clothing shells); join: limb->torso blend
  // sagFloor: soft tissue can droop down to here but not below (no flesh webbing between the legs)
  constructor(prims, { inflate = 0, clay = 0, sag = 0, seed = 1, pad: extra = 0, join = 0.18, sagFloor = -Infinity } = {}) {
    this.inflate = inflate; this.clay = clay; this.sag = sag; this.seed = seed; this.join = join; this.sagFloor = sagFloor;
    const pad = inflate + clay * 0.12 + extra;
    this.extraPad = extra;
    this.prims = prims.map((p) => {
      const inv = p.matrix.clone().invert().elements; // model -> local, column-major
      const lb = localBounds(p);
      const box = new THREE.Box3(lb.min, lb.max).applyMatrix4(p.matrix);
      box.expandByScalar(p.k + pad + 0.05);
      if (p.soft && sag) box.min.y -= sag * (lb.max.y - lb.min.y) * 0.6;
      return { ...p, inv, box };
    });
    this.bounds = new THREE.Box3();
    for (const p of this.prims) this.bounds.union(p.box);
    // hot-loop data: numeric type/group codes and precomputed fat per prim (no strings, no Map)
    this.groupNames = ['torso', ...new Set(this.prims.filter((p) => p.group && p.group !== 'torso').map((p) => p.group))];
    for (const p of this.prims) {
      p.t = p.type === 'cone' ? 0 : p.type === 'ellipsoid' ? 1 : 2;
      p.gi = Math.max(0, this.groupNames.indexOf(p.group || 'torso'));
      // fat mostly lands on the torso; limbs get less so legs don't swell into one column
      // (feet keep their exact size so soles stay on the ground)
      p.fat = p.rigid ? 0 : this.inflate * (p.gi === 0 ? 1 : p.group.startsWith('leg') ? 0.4 : 0.6);
    }
    this.acc = new Float64Array(this.groupNames.length);
    this.giA = this.groupNames.indexOf('legA');
    this.giB = this.groupNames.indexOf('legB');
  }

  // exclude: a limb group to leave out (each leg is sculpted in a pass where the other doesn't exist)
  // out: if given, also writes [value without legA, value without legB] from the same evaluation
  evalList(x, y, z, list, exclude = null, out = null) {
    // torso prims smooth-union together; each limb group smooth-unions with the torso;
    // limb groups combine with a hard min, so left/right legs (and feet) never web together
    const acc = this.acc, G = acc.length;
    acc.fill(1e3);
    for (let n = 0; n < list.length; n++) {
      const p = list[n];
      if (p.ghost) continue;
      const e = p.inv;
      const lx = e[0] * x + e[4] * y + e[8] * z + e[12];
      let ly = e[1] * x + e[5] * y + e[9] * z + e[13];
      const lz = e[2] * x + e[6] * y + e[10] * z + e[14];
      let v;
      if (p.t === 0) v = sdRoundCone(lx, ly, lz, p.a, p.b, p.r1, p.r2);
      else if (p.t === 1) {
        // sag: soft tissue stretches downward below its center, fading out near the ground
        if (p.soft && this.sag && ly < p.c[1]) {
          const sag = this.sag * Math.min(1, Math.max(0, (y - 0.5) / 1.2)) * Math.min(1, Math.max(0, (y - this.sagFloor) / 0.4));
          ly = p.c[1] + (ly - p.c[1]) / (1 + sag);
        }
        v = sdEllipsoid(lx, ly, lz, p.c, p.r);
      } else v = sdRoundBox(lx, ly, lz, p.c, p.b, p.round);
      v -= p.fat;
      acc[p.gi] = smin(acc[p.gi], v, p.k);
    }
    const torso = acc[0], ex = exclude === null ? -1 : this.groupNames.indexOf(exclude);
    let d = torso, noA = torso, noB = torso;
    for (let g = 1; g < G; g++) {
      if (acc[g] >= 1e3) continue; // group not present at this point
      const v = smin(torso, acc[g], this.join);
      if (g !== ex) d = Math.min(d, v);
      if (g !== this.giA) noA = Math.min(noA, v);
      if (g !== this.giB) noB = Math.min(noB, v);
    }
    let n = 0;
    if (this.clay) {
      const s = this.seed;
      n = this.clay * Math.min(1, Math.max(0, (y - 0.25) / 0.6)) * (0.09 * (vnoise(x * 1.6, y * 1.6, z * 1.6, s) - 0.5) + 0.035 * (vnoise(x * 5, y * 5, z * 5, s + 7) - 0.5));
    }
    if (out) { out[0] = noA + n; out[1] = noB + n; }
    return d + n;
  }

  eval(x, y, z) { return this.evalList(x, y, z, this.prims); }

  // the body as seen by one leg's pass
  view(exclude) {
    return { eval: (x, y, z) => this.evalList(x, y, z, this.prims, exclude), gradient(x, y, z) { return gradientOf(this, x, y, z); } };
  }

  gradient(x, y, z) { return gradientOf(this, x, y, z); }
}

export function gradientOf(field, x, y, z, h = 0.01) {
  const g = new THREE.Vector3(
    field.eval(x + h, y, z) - field.eval(x - h, y, z),
    field.eval(x, y + h, z) - field.eval(x, y - h, z),
    field.eval(x, y, z + h) - field.eval(x, y, z - h),
  );
  return g.lengthSq() > 0 ? g.normalize() : g.set(0, 1, 0);
}

// A clothing shell: the body pushed out by `thickness`, optionally unioned with an extra shape
// (a skirt cone that bridges the legs), cut to a region by `mask` (negative inside).
export class GarmentField {
  constructor(body, { thickness, mask, extra = null, fuzz = 0 }) {
    Object.assign(this, { body, thickness, mask, extra, fuzz });
  }
  fromBody(d, x, y, z) {
    let v = d - this.thickness;
    if (this.extra) v = Math.min(v, this.extra(x, y, z));
    if (this.fuzz) v += this.fuzz * (vnoise(x * 9, y * 9, z * 9, 3) - 0.5);
    return Math.max(v, this.mask(x, y, z));
  }
  eval(x, y, z) { return this.fromBody(this.body.eval(x, y, z), x, y, z); }
  gradient(x, y, z) { return gradientOf(this, x, y, z); }
}

export { sdRoundCone };

function localBounds(p) {
  const min = new THREE.Vector3(), max = new THREE.Vector3();
  if (p.type === 'cone') {
    const r = Math.max(p.r1, p.r2);
    min.set(Math.min(p.a[0], p.b[0]) - r, Math.min(p.a[1], p.b[1]) - r, Math.min(p.a[2], p.b[2]) - r);
    max.set(Math.max(p.a[0], p.b[0]) + r, Math.max(p.a[1], p.b[1]) + r, Math.max(p.a[2], p.b[2]) + r);
  } else {
    const h = p.type === 'ellipsoid' ? p.r : p.b;
    min.set(p.c[0] - h[0], p.c[1] - h[1], p.c[2] - h[2]);
    max.set(p.c[0] + h[0], p.c[1] + h[1], p.c[2] + h[2]);
  }
  return { min, max };
}

// ---- surface nets over a block-culled grid ----
export function polygonize(sdf, cell) {
  const grid = sampleGrid(sdf, cell);
  return surfaceNets(grid, grid.val, sdf);
}

// derive another field (a garment) on the same grid from the sampled body values
// iRange: only the corner columns a pass scans (surface nets reads one column beyond each side)
export function deriveGrid(grid, garment, val = grid.val, iRange = [0, grid.nx]) {
  const { nx, ny, nz, o, cell } = grid, out = new Float32Array(val.length).fill(1e3);
  const i0 = Math.max(0, iRange[0] - 2), i1 = Math.min(nx, iRange[1] + 2);
  const far = garment.extra ? Infinity : garment.thickness + 2 * cell + garment.fuzz * 0.5 + 0.02;
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) {
    const row = nx * (j + ny * k);
    for (let i = i0; i < i1; i++) {
      const v = val[row + i];
      // well outside the shell (> 2 cells + fuzz) the garment is positive whatever the mask says,
      // and no surface crossing can touch such a corner: skip the mask there
      out[row + i] = v >= 999 ? 1e3 : v > far ? v - garment.thickness : garment.fromBody(v, o.x + i * cell, o.y + j * cell, o.z + k * cell);
    }
  }
  return out;
}

// Narrow band: a block is evaluated exactly only if the surface (or a clothing offset, within
// `band`) can pass through it; blocks provably inside/outside get a conservative fill. Every
// sign change and every garment crossing lies inside exact blocks, so meshes come out identical.
// jRange: optional [j0, j1) block rows to sample (a worker's slab); also returns the exact flags
export function sampleGrid(sdf, cell, jRange = null) {
  const b = sdf.bounds, o = b.min;
  const band = sdf.extraPad + 2 * cell;
  const lip = 1.6 + sdf.clay * 0.8; // safety factor over a 1-Lipschitz field (ellipsoid approx, noise)
  const nx = Math.ceil((b.max.x - o.x) / cell) + 2, ny = Math.ceil((b.max.y - o.y) / cell) + 2, nz = Math.ceil((b.max.z - o.z) / cell) + 2;
  // a slab only stores its own corner rows [j0, jTop]
  const [j0, j1] = jRange || [0, ny];
  const jTop = Math.min(j1, ny - 1), rows = jRange ? jTop - j0 + 1 : ny, jBase = jRange ? j0 : 0;
  const n = nx * rows * nz;
  const val = new Float32Array(n).fill(1e3), valL = new Float32Array(n).fill(1e3), valR = new Float32Array(n).fill(1e3);
  const idx = (i, j, k) => i + nx * (j - jBase + rows * k);
  const B = 8, tmp = new THREE.Box3(), lo = new THREE.Vector3(), hi = new THREE.Vector3(), two = [0, 0];
  const exact = new Uint8Array(n), half = (Math.sqrt(3) * B * cell) / 2;
  // ord: sequential order of the block that wrote each corner, so slabs can be merged with the
  // exact same rules as one pass (first exact evaluation wins; among fills the last one wins)
  const ord = new Int32Array(n), nbx = Math.ceil(nx / B), nby = Math.ceil(ny / B);
  for (let bk = 0; bk < nz; bk += B) for (let bj = j0; bj < j1; bj += B) for (let bi = 0; bi < nx; bi += B) {
    const key = ((bk / B) * nby + bj / B) * nbx + bi / B;
    lo.set(o.x + bi * cell, o.y + bj * cell, o.z + bk * cell);
    hi.set(o.x + (bi + B) * cell, o.y + (bj + B) * cell, o.z + (bk + B) * cell);
    tmp.set(lo, hi);
    const list = sdf.prims.filter((p) => p.box.intersectsBox(tmp));
    if (!list.length) continue;
    const kEnd = Math.min(bk + B, nz - 1), jEnd = Math.min(bj + B, ny - 1, jTop), iEnd = Math.min(bi + B, nx - 1);
    // two levels: the 8-block, then its 4-sub-blocks, each skipped when provably far from the band
    const region = (i0, j0, k0, n, i1, j1, k1) => {
      const hr = (Math.sqrt(3) * n * cell) / 2;
      const d0 = sdf.evalList(o.x + (i0 + n / 2) * cell, o.y + (j0 + n / 2) * cell, o.z + (k0 + n / 2) * cell, list, null, two);
      const a0 = two[0], b0 = two[1], margin = hr * lip + band;
      const far = Math.min(d0, a0, b0) > margin ? 1 : Math.max(d0, a0, b0) < -margin ? -1 : 0;
      if (!far) return false;
      const s = -far * hr * lip; // conservative: still beyond the band, same sign
      for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const at = idx(i, j, k);
        if (exact[at]) continue;
        val[at] = d0 + s; valL[at] = a0 + s; valR[at] = b0 + s; ord[at] = key;
      }
      return true;
    };
    if (region(bi, bj, bk, B, iEnd, jEnd, kEnd)) continue;
    const H = B / 2;
    for (let sk = bk; sk < bk + B && sk <= kEnd; sk += H) for (let sj = bj; sj < bj + B && sj <= jEnd; sj += H) for (let si = bi; si < bi + B && si <= iEnd; si += H) {
      const k1 = Math.min(sk + H, kEnd), j1 = Math.min(sj + H, jEnd), i1 = Math.min(si + H, iEnd);
      if (region(si, sj, sk, H, i1, j1, k1)) continue;
      // third level: 2-cell sub-blocks, same provable skip rule
      const Q = H / 2;
      for (let tk = sk; tk < sk + H && tk <= k1; tk += Q) for (let tj = sj; tj < sj + H && tj <= j1; tj += Q) for (let ti = si; ti < si + H && ti <= i1; ti += Q) {
      const qk1 = Math.min(tk + Q, k1), qj1 = Math.min(tj + Q, j1), qi1 = Math.min(ti + Q, i1);
      if (region(ti, tj, tk, Q, qi1, qj1, qk1)) continue;
      for (let k = tk; k <= qk1; k++) for (let j = tj; j <= qj1; j++) for (let i = ti; i <= qi1; i++) {
      const at = idx(i, j, k);
      if (exact[at]) continue;
      exact[at] = 1; ord[at] = key;
      val[at] = sdf.evalList(o.x + i * cell, o.y + j * cell, o.z + k * cell, list, null, two);
      valL[at] = two[0]; // left pass (+x): the right leg (legA) doesn't exist
      valR[at] = two[1]; // right pass (-x): the left leg (legB) doesn't exist
      }
      }
    }
  }
  return { nx, ny, nz, o, cell, val, valL, valR, exact, ord, j0: jBase, rows };
}

// Merge worker slabs (ascending rows) with the same rules as one sequential pass: an exactly
// evaluated corner always wins, otherwise the later writer wins, so the grid is identical.
export function mergeSlabs(slabs) {
  const { nx, ny, nz, cell } = slabs[0], o = new THREE.Vector3().fromArray(slabs[0].o);
  const n = nx * ny * nz;
  const val = new Float32Array(n).fill(1e3), valL = new Float32Array(n).fill(1e3), valR = new Float32Array(n).fill(1e3);
  const exact = new Uint8Array(n), ord = new Int32Array(n).fill(-1);
  for (const sl of slabs) {
    for (let k = 0; k < nz; k++) for (let j = sl.j0; j < sl.j0 + sl.rows; j++) {
      const row = nx * (j + ny * k), srow = nx * (j - sl.j0 + sl.rows * k);
      for (let i = 0; i < nx; i++) {
        const at = row + i, s = srow + i, key = sl.ord[s];
        const take = sl.exact[s]
          ? !exact[at] || key < ord[at] // earliest exact evaluation
          : !exact[at] && sl.val[s] < 999 && key > ord[at]; // latest fill, never over an exact
        if (take) {
          val[at] = sl.val[s]; valL[at] = sl.valL[s]; valR[at] = sl.valR[s];
          exact[at] = sl.exact[s]; ord[at] = key;
        }
      }
    }
  }
  return { nx, ny, nz, o, cell, val, valL, valR, exact };
}

// keep(x): optional filter on a quad's edge-midpoint x (used to take one body half per pass)
// iRange: optional [i0, i1) corner columns the pass needs (a leg pass only scans its own half)
export function surfaceNets(grid, val, field, keep = null, iRange = null) {
  const { nx, ny, nz, o, cell } = grid;
  const idx = (i, j, k) => i + nx * (j + ny * k);
  const [iA, iB] = iRange || [0, nx];
  // blocks (8 cells) with both signs among their corners; everything else can't hold surface
  const B = 8, bx = Math.ceil(nx / B), by = Math.ceil(ny / B), bz = Math.ceil(nz / B);
  const blocks = [];
  const iLo = Math.max(0, iA - 1), iHi = Math.min(nx - 1, iB + 1);
  for (let kb = 0; kb < bz; kb++) for (let jb = 0; jb < by; jb++) for (let ib = 0; ib < bx; ib++) {
    const i0 = Math.max(ib * B, iLo), i1 = Math.min(ib * B + B, iHi);
    if (i0 > i1) continue;
    let pos = false, neg = false;
    scan: for (let k = kb * B; k <= Math.min(kb * B + B, nz - 1); k++) for (let j = jb * B; j <= Math.min(jb * B + B, ny - 1); j++) {
      const row = nx * (j + ny * k);
      for (let i = i0; i <= i1; i++) {
        if (val[row + i] < 0) neg = true; else pos = true;
        if (pos && neg) break scan;
      }
    }
    if (pos && neg) blocks.push([ib * B, jb * B, kb * B]);
  }

  // flat strides and lookup tables: no closures, no destructuring in the hot loops
  const SY = nx, SZ = nx * ny;
  const OFF = [0, 1, SY, SY + 1, SZ, SZ + 1, SZ + SY, SZ + SY + 1];
  const EA = [0, 2, 4, 6, 0, 1, 4, 5, 0, 1, 2, 3], EC = [1, 3, 5, 7, 2, 3, 6, 7, 4, 5, 6, 7];
  const BX = [0, 1, 0, 1, 0, 1, 0, 1], BY = [0, 0, 1, 1, 0, 0, 1, 1], BZ = [0, 0, 0, 0, 1, 1, 1, 1];
  const verts = [], cellVert = new Int32Array(nx * ny * nz).fill(-1);
  const corner = new Float64Array(8);
  for (let q = 0; q < blocks.length; q++) {
    const bi = blocks[q][0], bj = blocks[q][1], bk = blocks[q][2];
    const kE = Math.min(bk + B, nz - 1), jE = Math.min(bj + B, ny - 1), iS = Math.max(bi, iA - 1), iE = Math.min(bi + B, nx - 1, iB + 1);
    for (let k = bk; k < kE; k++) for (let j = bj; j < jE; j++) {
      const rowBase = SY * j + SZ * k;
      for (let i = iS; i < iE; i++) {
        const base = rowBase + i;
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const v = (corner[c] = val[base + OFF[c]]);
          if (v < 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;
        let sx = 0, sy = 0, sz = 0, n = 0;
        for (let e = 0; e < 12; e++) {
          const ea = EA[e], ec = EC[e], va = corner[ea], vc = corner[ec];
          if ((va < 0) === (vc < 0)) continue;
          const t = va / (va - vc);
          sx += BX[ea] + (BX[ec] - BX[ea]) * t;
          sy += BY[ea] + (BY[ec] - BY[ea]) * t;
          sz += BZ[ea] + (BZ[ec] - BZ[ea]) * t;
          n++;
        }
        cellVert[base] = verts.length / 3;
        verts.push(o.x + (i + sx / n) * cell, o.y + (j + sy / n) * cell, o.z + (k + sz / n) * cell);
      }
    }
  }

  const tris = [];
  const xKeep = keep ? keep : null;
  for (let q = 0; q < blocks.length; q++) {
    const bi = blocks[q][0], bj = blocks[q][1], bk = blocks[q][2];
    const kE = Math.min(bk + B, nz - 1), jE = Math.min(bj + B, ny - 1), iS = Math.max(1, bi, iA), iE = Math.min(bi + B, nx - 1, iB);
    for (let k = Math.max(1, bk); k < kE; k++) for (let j = Math.max(1, bj); j < jE; j++) {
      const rowBase = SY * j + SZ * k;
      for (let i = iS; i < iE; i++) {
        const at = rowBase + i;
        const inside = val[at] < 0;
        const x0 = o.x + i * cell;
        // edge along x: the 4 cells sharing it differ in j,k ; along y: in k,i ; along z: in i,j
        if (inside !== (val[at + 1] < 0) && (!xKeep || xKeep(x0 + cell / 2))) {
          const a0 = cellVert[at], b0 = cellVert[at - SY], c0 = cellVert[at - SY - SZ], d0 = cellVert[at - SZ];
          if (a0 >= 0 && b0 >= 0 && c0 >= 0 && d0 >= 0) { if (inside) tris.push(a0, c0, d0, a0, b0, c0); else tris.push(a0, c0, b0, a0, d0, c0); }
        }
        if (inside !== (val[at + SY] < 0) && (!xKeep || xKeep(x0))) {
          const a0 = cellVert[at], b0 = cellVert[at - SZ], c0 = cellVert[at - SZ - 1], d0 = cellVert[at - 1];
          if (a0 >= 0 && b0 >= 0 && c0 >= 0 && d0 >= 0) { if (inside) tris.push(a0, c0, d0, a0, b0, c0); else tris.push(a0, c0, b0, a0, d0, c0); }
        }
        if (inside !== (val[at + SZ] < 0) && (!xKeep || xKeep(x0))) {
          const a0 = cellVert[at], b0 = cellVert[at - 1], c0 = cellVert[at - 1 - SY], d0 = cellVert[at - SY];
          if (a0 >= 0 && b0 >= 0 && c0 >= 0 && d0 >= 0) { if (inside) tris.push(a0, c0, d0, a0, b0, c0); else tris.push(a0, c0, b0, a0, d0, c0); }
        }
      }
    }
  }
  // winding is emitted outward directly (a runtime gradient check flipped 120/120 meshes, always)
  return { positions: new Float32Array(verts), indices: new Uint32Array(tris) };
}

// Legs sculpted separately: the left half (+x) comes from the pass without the right leg and vice
// versa, so the two legs can never be bridged by one grid cell. Both passes contain the same torso,
// so the halves meet at the centerline and are welded there.
// seamMinY: only the torso needs welding; below it (between the legs) nothing may be joined
// corner columns each leg pass scans (its own half plus a small overlap at the centerline)
export function splitRanges(grid) {
  const i0 = Math.floor(-grid.o.x / grid.cell); // corner column at/just left of x = 0
  return { left: [Math.max(1, i0 - 1), grid.nx], right: [1, Math.min(grid.nx, i0 + 3)] };
}

export function splitNets(grid, valLeft, valRight, fieldLeft, fieldRight, seamMinY = -Infinity) {
  const r = splitRanges(grid);
  const a = perf.time('pass', () => surfaceNets(grid, valLeft, fieldLeft, (x) => x >= 0, r.left));
  const b = perf.time('pass', () => surfaceNets(grid, valRight, fieldRight, (x) => x < 0, r.right));
  return perf.time('weld', () => weldSeam(a, b, grid.cell, seamMinY));
}

function weldSeam(a, b, cell, seamMinY) {
  const na = a.positions.length / 3, nt = na + b.positions.length / 3, tol = cell * 0.75, band = cell * 1.01;
  const P = new Float32Array(nt * 3);
  P.set(a.positions); P.set(b.positions, a.positions.length);
  const I = new Uint32Array(a.indices.length + b.indices.length);
  I.set(a.indices);
  for (let t = 0; t < b.indices.length; t++) I[a.indices.length + t] = b.indices[t] + na;
  const used = new Uint8Array(nt);
  for (let t = 0; t < I.length; t++) used[I[t]] = 1;
  // only seam vertices (a thin band at the centerline, above the crotch) take part in welding
  const key = (y, z) => `${Math.floor(y / tol)},${Math.floor(z / tol)}`;
  const hash = new Map();
  for (let v = 0; v < na; v++) {
    if (!used[v] || Math.abs(P[v * 3]) > band || P[v * 3 + 1] < seamMinY) continue;
    const k = key(P[v * 3 + 1], P[v * 3 + 2]);
    (hash.get(k) || hash.set(k, []).get(k)).push(v);
  }
  const remap = new Int32Array(nt);
  for (let v = 0; v < nt; v++) remap[v] = v;
  for (let v = na; v < nt; v++) {
    if (!used[v] || Math.abs(P[v * 3]) > band || P[v * 3 + 1] < seamMinY) continue;
    const y = P[v * 3 + 1], z = P[v * 3 + 2];
    let best = -1, bd = tol * tol;
    for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const list = hash.get(`${Math.floor(y / tol) + dy},${Math.floor(z / tol) + dz}`);
      if (!list) continue;
      for (const u of list) {
        const d = (P[u * 3] - P[v * 3]) ** 2 + (P[u * 3 + 1] - y) ** 2 + (P[u * 3 + 2] - z) ** 2;
        if (d < bd) { bd = d; best = u; }
      }
    }
    if (best >= 0) remap[v] = best;
  }
  // compact in first-use order (same order a Map-based compaction would give)
  const newId = new Int32Array(nt).fill(-1), pos = new Float32Array(nt * 3), idx = new Uint32Array(I.length);
  let nv = 0, ni = 0;
  for (let t = 0; t < I.length; t += 3) {
    const t0 = remap[I[t]], t1 = remap[I[t + 1]], t2 = remap[I[t + 2]];
    if (t0 === t1 || t1 === t2 || t0 === t2) continue; // collapsed at the seam
    for (const v of [t0, t1, t2]) {
      if (newId[v] < 0) { newId[v] = nv; pos[nv * 3] = P[v * 3]; pos[nv * 3 + 1] = P[v * 3 + 1]; pos[nv * 3 + 2] = P[v * 3 + 2]; nv++; }
      idx[ni++] = newId[v];
    }
  }
  return { positions: pos.slice(0, nv * 3), indices: idx.slice(0, ni) };
}

// make triangle winding agree with the SDF gradient (outward)
function orientOutward(sdf, P, I) {
  let agree = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const step = Math.max(3, Math.floor(I.length / 3 / 200)) * 3;
  for (let t = 0; t < I.length; t += step) {
    a.fromArray(P, I[t] * 3); b.fromArray(P, I[t + 1] * 3); c.fromArray(P, I[t + 2] * 3);
    const n = b.clone().sub(a).cross(c.clone().sub(a));
    const m = a.add(b).add(c).multiplyScalar(1 / 3);
    agree += Math.sign(n.dot(sdf.gradient(m.x, m.y, m.z)));
  }
  if (agree < 0) for (let t = 0; t < I.length; t += 3) { const x = I[t + 1]; I[t + 1] = I[t + 2]; I[t + 2] = x; }
}

// decimate to a triangle budget and drop unused vertices
export function simplify(mesh, targetTris) {
  const { positions, indices } = mesh;
  if (indices.length / 3 <= targetTris) return mesh;
  const [out] = MeshoptSimplifier.simplify(indices, positions, 3, targetTris * 3, 0.05, ['Regularize']);
  const [remap, unique] = MeshoptSimplifier.compactMesh(out);
  const p = new Float32Array(unique * 3);
  for (let i = 0; i < remap.length; i++) if (remap[i] !== 0xffffffff) p.set(positions.subarray(i * 3, i * 3 + 3), remap[i] * 3);
  return { positions: p, indices: out };
}

// smooth normals from the field and cheap SDF ambient occlusion (crevices, armpits, crotch)
export function shade(sdf, positions) {
  const n = positions.length / 3;
  const normals = new Float32Array(n * 3), ao = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    const g = sdf.gradient(x, y, z);
    normals.set([g.x, g.y, g.z], i * 3);
    let occ = 0;
    for (let s = 1; s <= 5; s++) {
      const h = s * 0.09;
      occ += (h - sdf.eval(x + g.x * h, y + g.y * h, z + g.z * h)) / 2 ** s;
    }
    ao[i] = Math.min(1, Math.max(0, 1 - occ * 2.2));
  }
  return { normals, ao };
}
