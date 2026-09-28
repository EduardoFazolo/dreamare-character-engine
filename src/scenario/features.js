// Features added on top of the original village scene. Every one of them draws from its own seeded random
// stream (never the original sequence), so a VILLAGE biome, which has them all switched off, is untouched.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { oldMaterial } from './material.js';
import { rng, hash2, fbm, smooth, lerp, mixC, canvasTex, css, blotch, boxG, cylG, place } from './util.js';
import { VEG } from './biomes.js';

const SEA_Y = -1.6;
const up = new THREE.Vector3(0, 1, 0);

// flat-shaded merged mesh per material
function meshes(group, byMat, name) {
  for (const [mat, geos] of byMat) {
    if (!geos.length) continue;
    const g = mergeGeometries(geos.map((q) => (q.index ? q.toNonIndexed() : q)));
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, mat); m.name = name; group.add(m);
  }
}
const col = (c, k = 1.5) => c.map((v) => Math.max(0, (v / 255) * k));

// ---------- plants: each returns { part: [geometries] } in local space, base at y = 0 ----------
const PLANTS = {
  pine(r, s) {
    const trunk = [cylG(0.12 * s, 0.2 * s, 2.4 * s, 5).translate(0, 1.2 * s, 0)], leaf = [];
    const tiers = 3 + (r() * 2 | 0);
    for (let t = 0; t < tiers; t++) {
      const rad = (1.7 - t * 0.36) * s * (0.9 + r() * 0.2), h = 2.3 * s;
      leaf.push(new THREE.ConeGeometry(rad, h, 6, 1).translate(0, 1.3 * s + t * 1.25 * s + h / 2, 0).rotateY(r() * 2));
    }
    return { trunk, leaf, r: 0.25 * s, shade: 1.6 * s };
  },
  broadleaf(r, s) {
    const trunk = [cylG(0.14 * s, 0.24 * s, 2.8 * s, 5).translate(0, 1.4 * s, 0)], leaf = [];
    for (let i = 0, n = 2 + (r() * 3 | 0); i < n; i++) {
      const rad = (1.1 + r() * 0.7) * s;
      leaf.push(new THREE.IcosahedronGeometry(rad, 0).translate((r() - 0.5) * 1.8 * s, (3.1 + r() * 1.1) * s, (r() - 0.5) * 1.8 * s));
    }
    return { trunk, leaf, r: 0.3 * s, shade: 2.2 * s };
  },
  birch(r, s) {
    const lean = (r() - 0.5) * 0.15, trunk = [place(cylG(0.08 * s, 0.13 * s, 5.2 * s, 5).translate(0, 2.6 * s, 0), 0, 0, 0, 0, lean, 0)], leaf = [];
    for (let i = 0, n = 2 + (r() * 2 | 0); i < n; i++) leaf.push(new THREE.IcosahedronGeometry((0.7 + r() * 0.5) * s, 0).translate((r() - 0.5) * 1.2 * s, (4.2 + r() * 1.3) * s, (r() - 0.5) * 1.2 * s + lean * 4 * s));
    return { birch: trunk, leaf, r: 0.18 * s, shade: 1.2 * s };
  },
  willow(r, s) {
    const trunk = [cylG(0.22 * s, 0.34 * s, 2.4 * s, 5).translate(0, 1.2 * s, 0)];
    const leaf = [new THREE.IcosahedronGeometry(2.2 * s, 0).scale(1, 0.55, 1).translate(0, 3.1 * s, 0)];
    for (let i = 0, n = 14; i < n; i++) { // hanging strands
      const a = (i / n) * Math.PI * 2 + r() * 0.3, rad = (1.6 + r() * 0.5) * s, len = (1.6 + r() * 1.2) * s;
      leaf.push(boxG(0.05 * s, len, 0.16 * s, Math.cos(a) * rad, 3 * s - len / 2, Math.sin(a) * rad, -a));
    }
    return { trunk, leaf, r: 0.35 * s, shade: 2.6 * s };
  },
  mushroom(r, s) {
    const tilt = (r() - 0.5) * 0.3, h = (2 + r() * 1.2) * s, capR = (1.1 + r() * 0.8) * s;
    const stem = [place(cylG(0.22 * s, 0.34 * s, h, 7).translate(0, h / 2, 0), 0, 0, 0, 0, tilt, tilt * 0.5)];
    const top = new THREE.Vector3(0, h, 0).applyEuler(new THREE.Euler(tilt, 0, tilt * 0.5, 'YXZ'));
    const cap = [new THREE.SphereGeometry(capR, 9, 4, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.5 + r() * 0.25, 1).translate(top.x, top.y - 0.1 * s, top.z)];
    const gill = [new THREE.CircleGeometry(capR * 0.97, 9).rotateX(Math.PI / 2).translate(top.x, top.y - 0.08 * s, top.z)];
    return { stem, cap, gill, r: 0.3 * s, shade: capR };
  },
  dead(r, s) {
    const parts = [];
    const branch = (base, dir, len, rad, depth) => {
      const g = cylG(rad * 0.6, rad, len, 5).translate(0, len / 2, 0);
      parts.push(g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, dir)).translate(base.x, base.y, base.z));
      if (depth === 0) return;
      const tip = base.clone().addScaledVector(dir, len);
      for (let k = 0, nk = 2 + (r() * 2 | 0); k < nk; k++) {
        const nd = dir.clone().add(new THREE.Vector3((r() - 0.5) * 1.6, 0.2 + r() * 0.5, (r() - 0.5) * 1.6)).normalize();
        branch(tip, nd, len * (0.5 + r() * 0.25), rad * 0.55, depth - 1);
      }
    };
    branch(new THREE.Vector3(0, -0.3, 0), new THREE.Vector3((r() - 0.5) * 0.2, 1, (r() - 0.5) * 0.2).normalize(), (3 + r() * 3) * s, 0.28 * s, s > 1.2 ? 3 : 2); // big ones fork once more
    return { trunk: parts, r: 0.35 * s, shade: 2 * s };
  },
};
const LEAF = { pine: [58, 76, 60], broadleaf: [84, 100, 66], birch: [134, 142, 94], willow: [104, 122, 78], mushroom: [160, 62, 50], dead: [0, 0, 0] };

export function addFeatures({ p, B, NB, weights, height, pathDist, path, near, placed, solids, shadows2, group, put, makeHouse, M, tr, anyWater, toSea }) {
  const out = {};
  const T = {
    leaf: canvasTex(32, 32, (g, w, h) => blotch(g, w, h, [196, 196, 186], 60, 40, tr, 4)),
    birch: canvasTex(16, 64, (g, w, h) => { blotch(g, w, h, [214, 210, 198], 20, 14, tr, 2); for (let i = 0; i < 26; i++) { g.fillStyle = 'rgba(30,28,26,.7)'; g.fillRect(tr() * w | 0, tr() * h | 0, 3 + (tr() * 6 | 0), 1 + (tr() * 2 | 0)); } }),
    stem: canvasTex(16, 32, (g, w, h) => { blotch(g, w, h, [214, 206, 186], 26, 16, tr, 2); for (let x = 0; x < w; x += 3) { g.fillStyle = 'rgba(90,80,60,.18)'; g.fillRect(x, 0, 1, h); } }),
    spots: canvasTex(64, 32, (g, w, h) => {
      blotch(g, w, h, [210, 206, 200], 30, 20, tr, 4);
      for (let i = 0; i < 26; i++) { const x = tr() * w, y = tr() * h * 0.9, rr = 1 + tr() * 3; g.fillStyle = 'rgba(250,246,236,.95)'; g.beginPath(); g.ellipse(x, y, rr * 1.4, rr, 0, 0, 7); g.fill(); }
    }),
    gill: canvasTex(32, 32, (g, w, h) => { blotch(g, w, h, [196, 180, 160], 20, 20, tr, 2); g.strokeStyle = 'rgba(90,70,60,.4)'; for (let a = 0; a < 40; a++) { g.beginPath(); g.moveTo(16, 16); g.lineTo(16 + Math.cos(a) * 16, 16 + Math.sin(a) * 16); g.stroke(); } }),
    rock: canvasTex(32, 32, (g, w, h) => blotch(g, w, h, [150, 148, 140], 60, 40, tr, 4)),
    crop: canvasTex(16, 16, (g, w, h) => { for (let i = 0; i < 7; i++) { const x = 1 + (tr() * 14 | 0), hh = 6 + (tr() * 9 | 0); g.fillStyle = css(mixC([96, 116, 64], [196, 176, 104], B.fields > 0.5 ? tr() * 0.6 + 0.4 : tr() * 0.5)); g.fillRect(x, h - hh, 1, hh); } }),
  };

  // blob shadows of added things: a coarse grid, so the terrain pass stays fast with hundreds of trees
  const CELL = 8, grid = new Map(), key = (i, j) => i * 4096 + j;
  out.shadeAt = (x, z) => {
    let k = 1; const ci = Math.floor(x / CELL), cj = Math.floor(z / CELL);
    for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++) {
      const list = grid.get(key(i, j)); if (!list) continue;
      for (const [px, pz, pr] of list) { const d = Math.hypot(x - px, z - pz); if (d < pr * 1.6) k *= lerp(0.55, 1, smooth(pr * 0.5, pr * 1.6, d)); }
    }
    return k;
  };
  const shadow = (x, z, rad) => { shadows2.push([x, z, rad]); const k = key(Math.floor(x / CELL), Math.floor(z / CELL)); (grid.get(k) || grid.set(k, []).get(k)).push([x, z, Math.min(rad, CELL / 1.6)]); };

  // ---- more houses along the path: the farm becomes a hamlet ----
  if (B.houses >= 1 && B.path) {
    const r = rng(p.seed * 17 + 5);
    for (let i = 0, tries = 0; i < Math.round(B.houses) && tries < 60; tries++) {
      const k = Math.floor(path.length * (0.25 + r() * 0.7)), [px, pz] = path[k], [qx, qz] = path[Math.min(path.length - 1, k + 1)];
      const nx = -(qz - pz), nz = qx - px, nl = Math.hypot(nx, nz) || 1, side = r() < 0.5 ? -1 : 1, dd = 9 + r() * 8;
      const x = px + side * (nx / nl) * dd, z = pz + side * (nz / nl) * dd;
      if (near(x, z, 5) || toSea(x, z) > 8 || (anyWater && height(x, z) < SEA_Y + 1)) continue;
      put(makeHouse(r), x, z, 7, { face: [px, pz], shadow: 6, sink: 0.4, tilt: 0.3, solid: 3.6 }, r);
      i++;
    }
  }

  // ---- ploughed fields: soft rectangles of rows, crops standing in lines ----
  if (B.fields > 0.02) {
    const r = rng(p.seed * 23 + 7), fields = [];
    for (let i = 0, n = 1 + Math.floor(B.fields * 3), tries = 0; fields.length < n && tries < 40; tries++) {
      const a = r() * Math.PI * 2, d = 18 + r() * 45, cx = Math.cos(a) * d, cz = Math.sin(a) * d, w = 16 + r() * 18, dp = 14 + r() * 14, ang = r() * Math.PI;
      if (near(cx, cz, Math.max(w, dp) / 2) || pathDist(cx, cz) < Math.max(w, dp) / 2 + 2 || toSea(cx, cz) > 0 || (anyWater && height(cx, cz) < SEA_Y + 1.5)) continue;
      fields.push({ cx, cz, w, dp, c: Math.cos(ang), s: Math.sin(ang) });
      placed.push([cx, cz, Math.max(w, dp) / 2]);
    }
    const local = (f, x, z) => { const dx = x - f.cx, dz = z - f.cz; return [dx * f.c + dz * f.s, -dx * f.s + dz * f.c]; };
    out.fieldAt = (x, z) => {
      for (const f of fields) {
        const [lx, lz] = local(f, x, z);
        const k = (1 - smooth(f.w / 2 - 2, f.w / 2 + 1, Math.abs(lx))) * (1 - smooth(f.dp / 2 - 2, f.dp / 2 + 1, Math.abs(lz)));
        if (k > 0.01) return { k, row: 0.5 + 0.5 * Math.sin(lx * 1.3) };
      }
      return null;
    };
    const crops = [], m = new THREE.Matrix4(), q = new THREE.Quaternion();
    for (const f of fields) for (let lx = -f.w / 2 + 1; lx < f.w / 2 - 1; lx += 1.6) for (let lz = -f.dp / 2 + 1; lz < f.dp / 2 - 1; lz += 0.9) {
      if (r() < 0.12) continue; // gaps
      const x = f.cx + lx * f.c - lz * f.s, z = f.cz + lx * f.s + lz * f.c, sc = 0.6 + r() * 0.5;
      for (const turn of [0, Math.PI / 2]) {
        m.compose(new THREE.Vector3(x, height(x, z) - 0.05, z), q.setFromAxisAngle(up, Math.atan2(f.s, f.c) + turn), new THREE.Vector3(sc, sc, sc));
        crops.push(new THREE.PlaneGeometry(0.9, 0.9).translate(0, 0.42, 0).applyMatrix4(m));
      }
    }
    if (crops.length) { const g = new THREE.Mesh(mergeGeometries(crops), oldMaterial({ map: T.crop, alphaTest: 0.5, side: THREE.DoubleSide })); g.name = 'crops'; group.add(g); }
  }

  // ---- plants (and rocks) for this biome and each neighbour, thinning toward whoever owns the ground ----
  const owners = [B, ...NB.map((n) => n.biome)];
  owners.forEach((b, idx) => {
    const kind = b.trees;
    if (kind && kind !== 'none' && b.treeDensity > 0 && PLANTS[kind]) {
      const r = rng(p.seed * 101 + idx * 7919 + VEG.indexOf(kind) * 131), n = Math.round(b.treeDensity * 2000 * p.density * (idx ? 0.8 : 1)); // density 1 ~ a tree per 25 m2 before clearings
      const tint = b.treeTint || [0, 0, 0], leafC = col(LEAF[kind].map((v, i) => v + tint[i]));
      const mats = {
        trunk: M.bark, birch: oldMaterial({ map: T.birch }), leaf: oldMaterial({ map: T.leaf, color: leafC, side: kind === 'willow' ? THREE.DoubleSide : THREE.FrontSide }),
        stem: oldMaterial({ map: T.stem }), cap: oldMaterial({ map: T.spots, color: leafC }), gill: oldMaterial({ map: T.gill }),
      };
      const byPart = {};
      for (let i = 0; i < n; i++) {
        const a = r() * Math.PI * 2, d = 6 + Math.sqrt(r()) * 124, x = Math.cos(a) * d, z = Math.sin(a) * d;
        const s = b.treeSize * (kind === 'mushroom' ? 0.35 + r() * r() * 2.6 : 0.7 + r() * 0.6); // mushrooms: mostly small, a few giants
        const mask = smooth(0.28, 0.62, fbm(x * 0.018, z * 0.018, p.seed + idx * 13 + 200)); // woods and clearings
        if (r() > mask * 0.85 + 0.15) continue;
        if (NB.length && hash2(x, z, p.seed + idx + 11) > weights(x, z)[idx]) continue;
        if (pathDist(x, z) < 2.5 || (anyWater && height(x, z) < SEA_Y + 0.8) || near(x, z, 0.6 * s + 0.5)) continue;
        const plant = PLANTS[kind](r, s), ry = r() * Math.PI * 2, lean = (r() - 0.5) * 0.12 * (1 + 2 * p.wrongness);
        const mtx = new THREE.Matrix4().compose(new THREE.Vector3(x, height(x, z) - 0.1, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(lean, ry, lean * 0.6, 'YXZ')), new THREE.Vector3(1, 1, 1));
        for (const part of ['trunk', 'birch', 'leaf', 'stem', 'cap', 'gill']) if (plant[part]) (byPart[part] ||= []).push(...plant[part].map((g) => g.applyMatrix4(mtx)));
        placed.push([x, z, plant.r * 2]); solids.push([x, z, plant.r]); shadow(x, z, plant.shade);
      }
      meshes(group, Object.entries(byPart).map(([k, g]) => [mats[k], g]), `plants-${kind}`);
    }
    if (b.rocks > 0.01) {
      const r = rng(p.seed * 211 + idx * 97), n = Math.round(b.rocks * 420 * p.density * (idx ? 0.8 : 1)), geos = [];
      const rockMat = oldMaterial({ map: T.rock, color: col(mixC(b.grassA, [150, 148, 140], 0.7), 1.25) });
      for (let i = 0; i < n; i++) {
        const a = r() * Math.PI * 2, d = 5 + Math.sqrt(r()) * 125, x = Math.cos(a) * d, z = Math.sin(a) * d, s = 0.25 + r() * r() * 2.4;
        if (NB.length && hash2(x, z, p.seed + idx + 23) > weights(x, z)[idx]) continue;
        if (pathDist(x, z) < 2 || near(x, z, s + 0.3) || (anyWater && height(x, z) < SEA_Y + 0.3)) continue;
        const g = new THREE.IcosahedronGeometry(1, 0).toNonIndexed(), pa = g.attributes.position;
        for (let v = 0; v < pa.count; v++) { // jitter by position, so shared corners stay shared (no cracks)
          const vx = pa.getX(v), vy = pa.getY(v), vz = pa.getZ(v), k = 0.75 + hash2(vx * 7 + i, vy * 7 + vz * 3, p.seed) * 0.5;
          pa.setXYZ(v, vx * k, vy * k, vz * k);
        }
        g.scale(s, s * (0.45 + r() * 0.3), s * (0.8 + r() * 0.4)).rotateY(r() * 6).translate(x, height(x, z) - s * 0.15, z);
        geos.push(g);
        if (s > 0.7) { solids.push([x, z, s * 0.8]); placed.push([x, z, s]); }
        shadow(x, z, s * 0.9);
      }
      meshes(group, [[rockMat, geos]], 'rocks');
    }
  });
  return out;
}

// grass tufts of the neighbouring biomes, only where they own the ground (outer ring)
export function addNeighbourGrass({ p, NB, weights, height, pathDist, near, group, seed }) {
  NB.forEach((nb, j) => {
    const b = nb.biome, idx = j + 1; if (!b.tufts) return;
    const r = rng(seed * 331 + idx * 17), tex = canvasTex(32, 32, (g, w, h) => {
      for (let i = 0; i < 9; i++) { const x0 = 2 + r() * 28, hh = 8 + r() * 22, lean = (r() - 0.5) * 10; g.fillStyle = css(mixC(b.tuftA, b.tuftB, r())); for (let y = 0; y < hh; y++) g.fillRect(Math.round(x0 + lean * (y / hh) ** 2), h - 1 - y, 1, 1); }
    });
    const parts = [], m = new THREE.Matrix4(), q = new THREE.Quaternion(), n = Math.round(300 * p.density * b.tufts);
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2, d = 40 + Math.sqrt(r()) * 90, x = Math.cos(a) * d, z = Math.sin(a) * d, y = height(x, z);
      if (hash2(x, z, seed + idx + 5) > weights(x, z)[idx] || y < SEA_Y + 1.2 || pathDist(x, z) < 1.5 || near(x, z, 0.5)) continue;
      const sc = 0.7 + r() * 0.8;
      for (const turn of [0, Math.PI / 2]) { m.compose(new THREE.Vector3(x, y - 0.08, z), q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), a + turn), new THREE.Vector3(sc, sc, sc)); parts.push(new THREE.PlaneGeometry(1.1, 1.1).translate(0, 0.52, 0).applyMatrix4(m)); }
    }
    if (parts.length) { const g = new THREE.Mesh(mergeGeometries(parts), oldMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide })); g.name = `grass-${idx}`; group.add(g); }
  });
}
