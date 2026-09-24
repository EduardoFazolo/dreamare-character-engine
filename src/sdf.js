import * as THREE from 'three';
import { MeshoptSimplifier } from 'meshoptimizer';

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
  constructor(prims, { inflate = 0, clay = 0, sag = 0, seed = 1, pad: extra = 0, join = 0.18 } = {}) {
    this.inflate = inflate; this.clay = clay; this.sag = sag; this.seed = seed; this.join = join;
    const pad = inflate + clay * 0.12 + extra;
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
  }

  evalList(x, y, z, list) {
    // torso prims smooth-union together; each limb group smooth-unions with the torso;
    // limb groups combine with a hard min, so left/right legs (and feet) never web together
    let torso = 1e3;
    const groups = this._g || (this._g = new Map());
    groups.clear();
    for (const p of list) {
      if (p.ghost) continue;
      const e = p.inv;
      const lx = e[0] * x + e[4] * y + e[8] * z + e[12];
      let ly = e[1] * x + e[5] * y + e[9] * z + e[13];
      const lz = e[2] * x + e[6] * y + e[10] * z + e[14];
      let v;
      if (p.type === 'cone') v = sdRoundCone(lx, ly, lz, p.a, p.b, p.r1, p.r2);
      else if (p.type === 'ellipsoid') {
        // sag: soft tissue stretches downward below its center, fading out near the ground
        if (p.soft && this.sag && ly < p.c[1]) {
          const sag = this.sag * Math.min(1, Math.max(0, (y - 0.5) / 1.2));
          ly = p.c[1] + (ly - p.c[1]) / (1 + sag);
        }
        v = sdEllipsoid(lx, ly, lz, p.c, p.r);
      } else v = sdRoundBox(lx, ly, lz, p.c, p.b, p.round);
      if (!p.rigid) v -= this.inflate; // feet keep their exact size so soles stay on the ground
      if (!p.group || p.group === 'torso') torso = smin(torso, v, p.k);
      else groups.set(p.group, smin(groups.has(p.group) ? groups.get(p.group) : 1e3, v, p.k));
    }
    let d = torso;
    for (const g of groups.values()) d = Math.min(d, smin(torso, g, this.join));
    if (this.clay) {
      const s = this.seed;
      d += this.clay * Math.min(1, Math.max(0, (y - 0.25) / 0.6)) * (0.09 * (vnoise(x * 1.6, y * 1.6, z * 1.6, s) - 0.5) + 0.035 * (vnoise(x * 5, y * 5, z * 5, s + 7) - 0.5));
    }
    return d;
  }

  eval(x, y, z) { return this.evalList(x, y, z, this.prims); }

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
export function deriveGrid(grid, garment) {
  const { nx, ny, nz, o, cell, val } = grid, out = new Float32Array(val.length);
  for (let k = 0, i3 = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++, i3++) {
    out[i3] = val[i3] >= 999 ? 1e3 : garment.fromBody(val[i3], o.x + i * cell, o.y + j * cell, o.z + k * cell);
  }
  return out;
}

export function sampleGrid(sdf, cell) {
  const b = sdf.bounds, o = b.min;
  const nx = Math.ceil((b.max.x - o.x) / cell) + 2, ny = Math.ceil((b.max.y - o.y) / cell) + 2, nz = Math.ceil((b.max.z - o.z) / cell) + 2;
  const val = new Float32Array(nx * ny * nz).fill(1e3);
  const idx = (i, j, k) => i + nx * (j + ny * k);
  const B = 8, tmp = new THREE.Box3(), lo = new THREE.Vector3(), hi = new THREE.Vector3();
  for (let bk = 0; bk < nz; bk += B) for (let bj = 0; bj < ny; bj += B) for (let bi = 0; bi < nx; bi += B) {
    lo.set(o.x + bi * cell, o.y + bj * cell, o.z + bk * cell);
    hi.set(o.x + (bi + B) * cell, o.y + (bj + B) * cell, o.z + (bk + B) * cell);
    tmp.set(lo, hi);
    const list = sdf.prims.filter((p) => p.box.intersectsBox(tmp));
    if (!list.length) continue;
    for (let k = bk; k <= Math.min(bk + B, nz - 1); k++) for (let j = bj; j <= Math.min(bj + B, ny - 1); j++) for (let i = bi; i <= Math.min(bi + B, nx - 1); i++) {
      val[idx(i, j, k)] = sdf.evalList(o.x + i * cell, o.y + j * cell, o.z + k * cell, list);
    }
  }
  return { nx, ny, nz, o, cell, val };
}

export function surfaceNets(grid, val, field) {
  const { nx, ny, nz, o, cell } = grid;
  const idx = (i, j, k) => i + nx * (j + ny * k);

  const verts = [], cellVert = new Int32Array(nx * ny * nz).fill(-1);
  const E = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const corner = new Float32Array(8);
  for (let k = 0; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    let mask = 0;
    for (let c = 0; c < 8; c++) {
      const v = (corner[c] = val[idx(i + (c & 1), j + ((c >> 1) & 1), k + ((c >> 2) & 1))]);
      if (v < 0) mask |= 1 << c;
    }
    if (mask === 0 || mask === 255) continue;
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (const [a, c] of E) {
      const va = corner[a], vc = corner[c];
      if ((va < 0) === (vc < 0)) continue;
      const t = va / (va - vc);
      sx += (a & 1) + ((c & 1) - (a & 1)) * t;
      sy += ((a >> 1) & 1) + (((c >> 1) & 1) - ((a >> 1) & 1)) * t;
      sz += ((a >> 2) & 1) + (((c >> 2) & 1) - ((a >> 2) & 1)) * t;
      n++;
    }
    cellVert[idx(i, j, k)] = verts.length / 3;
    verts.push(o.x + (i + sx / n) * cell, o.y + (j + sy / n) * cell, o.z + (k + sz / n) * cell);
  }

  const tris = [];
  const quad = (a, b, c, d, flip) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) tris.push(a, d, c, a, c, b); else tris.push(a, b, c, a, c, d);
  };
  for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const inside = val[idx(i, j, k)] < 0;
    // edge along x from corner (i,j,k): cells sharing it differ in j,k
    if (inside !== (val[idx(i + 1, j, k)] < 0))
      quad(cellVert[idx(i, j, k)], cellVert[idx(i, j - 1, k)], cellVert[idx(i, j - 1, k - 1)], cellVert[idx(i, j, k - 1)], inside);
    if (inside !== (val[idx(i, j + 1, k)] < 0))
      quad(cellVert[idx(i, j, k)], cellVert[idx(i, j, k - 1)], cellVert[idx(i - 1, j, k - 1)], cellVert[idx(i - 1, j, k)], inside);
    if (inside !== (val[idx(i, j, k + 1)] < 0))
      quad(cellVert[idx(i, j, k)], cellVert[idx(i - 1, j, k)], cellVert[idx(i - 1, j - 1, k)], cellVert[idx(i, j - 1, k)], inside);
  }
  const positions = new Float32Array(verts), indices = new Uint32Array(tris);
  orientOutward(field, positions, indices);
  return { positions, indices };
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
