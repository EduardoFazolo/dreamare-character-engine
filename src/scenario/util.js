// Shared helpers for the scenario generator (seeded noise, canvas textures, low-poly geometry).
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// ---------- seeded helpers ----------
export function rng(seed) {
  let s = (seed * 2654435761) >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export const hash2 = (x, y, s) => { const h = Math.sin(x * 127.1 + y * 311.7 + s * 74.7) * 43758.5453; return h - Math.floor(h); };
export function vnoise(x, y, s) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy, u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, s), b = hash2(ix + 1, iy, s), c = hash2(ix, iy + 1, s), d = hash2(ix + 1, iy + 1, s);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}
export const fbm = (x, y, s) => vnoise(x, y, s) * 0.55 + vnoise(x * 2.1, y * 2.1, s + 1) * 0.3 + vnoise(x * 4.3, y * 4.3, s + 2) * 0.15;
export const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
export const lerp = (a, b, t) => a + (b - a) * t;
export const mixC = (a, b, t) => a.map((v, i) => lerp(v, b[i], t));
export const rgb = (c) => new THREE.Color(c[0] / 255, c[1] / 255, c[2] / 255);

export function canvasTex(w, h, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.magFilter = t.minFilter = THREE.NearestFilter;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
export const css = (c, a = 1) => `rgba(${c.map((v) => Math.max(0, Math.min(255, v)) | 0).join(',')},${a})`;
// photographic-ish tile: blotchy low-frequency value noise + per-pixel grain, wrapping seamlessly
export function blotch(g, w, h, base, spread, grain, r, cells = 6) {
  const s = Math.floor(r() * 1000);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const u = (x / w) * cells, v = (y / h) * cells, wrap = (fx, fy) => hash2(((fx % cells) + cells) % cells, ((fy % cells) + cells) % cells, s);
    const ix = Math.floor(u), iy = Math.floor(v), fx = u - ix, fy = v - iy;
    const n = lerp(lerp(wrap(ix, iy), wrap(ix + 1, iy), fx), lerp(wrap(ix, iy + 1), wrap(ix + 1, iy + 1), fx), fy);
    const k = (n - 0.5) * spread + (r() - 0.5) * grain;
    g.fillStyle = css(base.map((b) => b + k)); g.fillRect(x, y, 1, 1);
  }
}

// ---------- geometry helpers ----------
export function tileUV(geo, sx, sy) { const uv = geo.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * sx, uv.getY(i) * sy); return geo; }
export const _q = new THREE.Quaternion(), _e = new THREE.Euler(), _one = new THREE.Vector3(1, 1, 1);
export const place = (geo, x, y, z, ry = 0, rx = 0, rz = 0) => geo.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz, 'YXZ')), _one));
export const boxG = (w, h, d, x = 0, y = 0, z = 0, ry = 0, rx = 0, rz = 0) => place(new THREE.BoxGeometry(w, h, d), x, y, z, ry, rx, rz);
export const cylG = (r1, r2, h, seg = 5) => new THREE.CylinderGeometry(r1, r2, h, seg, 1);
// a group of named parts -> one mesh per material, sitting on y = 0
export function assemble(parts) {
  const g = new THREE.Group();
  for (const [mat, geos] of parts) {
    if (!geos.length) continue;
    const m = mergeGeometries(geos.map((q) => (q.index ? q.toNonIndexed() : q)));
    m.computeVertexNormals(); // non-indexed -> flat faces, the faceted PS1 look
    g.add(new THREE.Mesh(m, mat));
  }
  return g;
}

