// Things worn on the face, built on the head's own mesh (head.js HeadRig, head units: face width = 1):
//   gadgets: monocle, glasses, cigar, cigarette, pipe (small rigid meshes at the eyes / a mouth corner)
//   masks (people only, Face: mask):
//     doll     a porcelain face plate over the face (eye holes, painted cheeks, lips, brows, a crack)
//     plague   a leather plate with glass eyes and a long curved beak
//     sack     a burlap sack over the whole head (painted ragged eye holes, a stitched mouth), hides the hair
//     bandage  gauze strips wound round the whole head, gaps showing skin, eyes left open; hides the hair
// Plates and wraps are offset copies of the head's own surface and carry its morph targets, so they move
// with the jaw and brows. Textures are painted procedurally (nothing to license).
import * as THREE from 'three';
import { ps2Material } from './head.js';
import { MORPHS } from './faceanim.js';

export const GADGETS = ['none', 'monocle', 'glasses', 'cigar', 'cigarette', 'pipe'];
export const MASKS = ['doll', 'plague', 'sack', 'bandage'];
export const MASK_HIDES_HAIR = new Set(['sack', 'bandage']);

const EYE_R = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246]; // subject's right (-x)
const EYE_L = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466];
const V = (a) => new THREE.Vector3(...a);
const avg = (P, ids) => ids.reduce((s, i) => s.add(V(P[i])), new THREE.Vector3()).divideScalar(ids.length);

function mat(color, name) { const m = ps2Material({ color }); m.name = name; return m; }
// a cylinder from a to b
function rod(a, b, r, seg = 6) {
  const g = new THREE.CylinderGeometry(r, r, a.distanceTo(b), seg, 1);
  const o = new THREE.Object3D(); o.position.copy(a).lerp(b, 0.5); o.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize()); o.updateMatrix();
  return g.applyMatrix4(o.matrix);
}
// a ring of wire around c facing +z (tilted by the face's normal n)
function ring(c, r, n, tube = 0.016) {
  const g = new THREE.TorusGeometry(r, tube, 5, 16);
  const o = new THREE.Object3D(); o.position.copy(c); o.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n); o.updateMatrix();
  return g.applyMatrix4(o.matrix);
}
const merge = (list) => { const out = list.map((g) => g.index ? g.toNonIndexed() : g); const pos = [], nor = []; for (const g of out) { pos.push(...g.attributes.position.array); g.computeVertexNormals(); nor.push(...g.attributes.normal.array); } const m = new THREE.BufferGeometry(); m.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); m.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); m.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2)); m.setIndex([...Array(pos.length / 3).keys()]); return m; };

// ---------------- gadgets ----------------
export function buildGadget(kind, P) {
  const g = new THREE.Group();
  if (!kind || kind === 'none') return g;
  const eR = avg(P, EYE_R), eL = avg(P, EYE_L), wR = V(P[33]).distanceTo(V(P[133])), wL = V(P[263]).distanceTo(V(P[362]));
  const fwd = new THREE.Vector3(0, 0, 1), add = (geo, color) => { const m = new THREE.Mesh(geo, mat(color, 'gadget')); g.add(m); };
  const metal = [0.72, 0.6, 0.32], dark = [0.12, 0.11, 0.1];
  if (kind === 'monocle') { // right eye, with a chain down to the lapel
    const c = eR.clone().add(new THREE.Vector3(0, 0.01, 0.07)), r = wR * 0.68;
    const edge = c.clone().add(new THREE.Vector3(-r * 0.7, -r * 0.7, 0));
    add(merge([ring(c, r, fwd, 0.02), rod(edge, new THREE.Vector3(edge.x - 0.12, P[152][1] - 0.35, edge.z - 0.15), 0.008, 4)]), metal);
    const disc = new THREE.CircleGeometry(r * 0.95, 14).translate(c.x, c.y, c.z - 0.005);
    add(merge([disc]), [0.55, 0.62, 0.66]); // (dull glass, like a flat pane catching the sky)
  }
  if (kind === 'glasses') { // round wire frames, a bridge over the nose, temples back to the ears
    const cR = eR.clone().add(new THREE.Vector3(0, 0.01, 0.075)), cL = eL.clone().add(new THREE.Vector3(0, 0.01, 0.075)), rR = wR * 0.62, rL = wL * 0.62;
    const bridgeY = (cR.y + cL.y) / 2 + 0.02, bz = Math.max(cR.z, cL.z, P[168][2] + 0.04);
    const parts = [ring(cR, rR, fwd), ring(cL, rL, fwd), rod(new THREE.Vector3(cR.x + rR, bridgeY, bz), new THREE.Vector3(cL.x - rL, bridgeY, bz), 0.012, 4)];
    for (const [c, r, s, ear] of [[cR, rR, -1, P[234]], [cL, rL, 1, P[454]]]) {
      const hinge = new THREE.Vector3(c.x + s * r, c.y, c.z - 0.01);
      parts.push(rod(hinge, new THREE.Vector3(ear[0] + s * 0.02, c.y - 0.02, ear[2] - 0.45), 0.011, 4));
    }
    add(merge(parts), dark);
  }
  if (kind === 'cigar' || kind === 'cigarette' || kind === 'pipe') { // from the subject's left mouth corner
    const corner = V(P[291]).lerp(V(P[13]), 0.35).add(new THREE.Vector3(0, 0, 0.02));
    const dir = new THREE.Vector3(0.28, -0.3, 1).normalize();
    if (kind === 'pipe') {
      const end = corner.clone().addScaledVector(dir, 0.42), wood = [0.3, 0.17, 0.09];
      add(merge([rod(corner, end, 0.02, 6)]), [0.08, 0.07, 0.07]);
      add(merge([new THREE.CylinderGeometry(0.075, 0.06, 0.16, 8).translate(end.x, end.y + 0.07, end.z)]), wood);
      add(merge([new THREE.CircleGeometry(0.06, 8).rotateX(-Math.PI / 2).translate(end.x, end.y + 0.151, end.z)]), [0.9, 0.35, 0.08]);
    } else {
      const len = kind === 'cigar' ? 0.55 : 0.42, r = kind === 'cigar' ? 0.036 : 0.017, end = corner.clone().addScaledVector(dir, len);
      const band = corner.clone().addScaledVector(dir, kind === 'cigar' ? 0.12 : 0.1), ash = end.clone().addScaledVector(dir, -0.03);
      add(merge([rod(corner, band, r * 1.02)]), kind === 'cigar' ? [0.72, 0.55, 0.2] : [0.78, 0.52, 0.28]); // band / filter
      add(merge([rod(band, ash, r)]), kind === 'cigar' ? [0.36, 0.2, 0.1] : [0.92, 0.9, 0.85]);
      add(merge([rod(ash, end, r * 0.98)]), [0.95, 0.38, 0.08]); // the ember
    }
  }
  return g;
}

// ---------------- masks ----------------
// shell: { pos: Float32Array (head verts), idx (face + hull triangles, uncut), faceTris (how many of idx are the face's), morphs, canonUV }
export function buildMask(kind, shell, P) {
  const g = new THREE.Group();
  if (!kind || !shell) return g;
  const full = kind === 'sack' || kind === 'bandage';
  const off = { doll: 0.022, plague: 0.03, sack: 0.075, bandage: 0.028 }[kind];
  const { pos, idx, faceTris, canonUV } = shell;
  // normals of the head surface, then the offset copy
  const tmp = new THREE.BufferGeometry(); tmp.setAttribute('position', new THREE.BufferAttribute(pos, 3)); tmp.setIndex(idx); tmp.computeVertexNormals();
  const nrm = tmp.attributes.normal.array, n = pos.length / 3, out = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; i++) out[i] = pos[i] + nrm[i] * off;
  // which triangles: the face alone (plates) or everything (wraps); plates get eye holes
  const eyeEll = [EYE_R, EYE_L].map((ids) => { const us = ids.map((i) => canonUV[i]); const cx = us.reduce((s, u) => s + u[0], 0) / us.length, cy = us.reduce((s, u) => s + u[1], 0) / us.length; const rx = Math.max(...us.map((u) => Math.abs(u[0] - cx))) * 1.25, ry = Math.max(...us.map((u) => Math.abs(u[1] - cy))) * 1.6; return [cx, cy, rx, ry]; });
  const inEye = (i) => { const u = canonUV[i]; return u && eyeEll.some(([cx, cy, rx, ry]) => ((u[0] - cx) / rx) ** 2 + ((u[1] - cy) / ry) ** 2 < 1); };
  const tris = [];
  for (let t = 0; t < (full ? idx.length : faceTris * 3); t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    if (!full && a < 468 && b < 468 && c < 468 && (inEye(a) + inEye(b) + inEye(c)) >= 2) continue;
    tris.push(a, b, c);
  }
  // uvs: plates use the canonical face layout, wraps a cylinder around the head (seam at the back)
  const uv = new Float32Array(n * 2);
  let yMin = Infinity, yMax = -Infinity; for (let i = 0; i < n; i++) { yMin = Math.min(yMin, out[i * 3 + 1]); yMax = Math.max(yMax, out[i * 3 + 1]); }
  const cyl = (x, y, z) => [Math.atan2(x, z) / (2 * Math.PI) + 0.5, (y - yMin) / (yMax - yMin)];
  for (let i = 0; i < n; i++) {
    const [u, v] = !full && i < 468 ? canonUV[i] : cyl(out[i * 3], out[i * 3 + 1], out[i * 3 + 2]);
    uv[i * 2] = u; uv[i * 2 + 1] = v;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(out, 3)); geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); geo.setIndex(tris);
  geo.morphTargetsRelative = true;
  geo.morphAttributes.position = MORPHS.map((m) => Object.assign(new THREE.BufferAttribute(shell.morphs[m] || new Float32Array(n * 3), 3), { name: m }));
  geo.computeVertexNormals(); geo.computeBoundingSphere();
  const eyesAt = full ? [EYE_R, EYE_L].map((ids) => { const c = avg(P, ids); return cyl(c.x, c.y, c.z + off); }) : eyeEll.map((e) => [e[0], e[1]]);
  const mouthAt = full ? cyl(P[13][0], P[13][1], P[13][2] + off) : canonUV[13];
  const tex = paintMask(kind, { eyes: eyesAt, eyeEll, mouth: mouthAt, canonUV });
  const m = ps2Material({ map: tex, alphaTest: kind === 'bandage' ? 0.5 : 0, side: THREE.DoubleSide }); m.name = 'mask';
  g.add(new THREE.Mesh(geo, m));
  if (kind === 'plague') g.add(...plagueParts(P));
  return g;
}

function plagueParts(P) {
  const leather = mat([0.24, 0.17, 0.12], 'mask'), glass = mat([0.12, 0.14, 0.13], 'mask'), brass = mat([0.6, 0.48, 0.25], 'mask');
  const eR = avg(P, EYE_R), eL = avg(P, EYE_L), fwd = new THREE.Vector3(0, 0, 1), out = [];
  for (const [c, w] of [[eR, V(P[33]).distanceTo(V(P[133]))], [eL, V(P[263]).distanceTo(V(P[362]))]]) {
    const cc = c.clone().add(new THREE.Vector3(0, 0, 0.06));
    out.push(new THREE.Mesh(new THREE.CircleGeometry(w * 0.62, 12).translate(cc.x, cc.y, cc.z), glass));
    out.push(new THREE.Mesh(ring(cc, w * 0.64, fwd, 0.028), brass));
  }
  // the beak: rings along a curve from over the nose / mouth, forward and down, tapering to a point
  const base = V(P[1]).lerp(V(P[13]), 0.4).add(new THREE.Vector3(0, 0, -0.02)), S = 9, SEG = 8, pts = [], rads = [];
  for (let k = 0; k <= S; k++) { const t = k / S; pts.push(base.clone().add(new THREE.Vector3(0, -0.45 * t * t, 1.15 * t))); rads.push(0.34 * Math.pow(1 - t, 1.25) + 0.012); }
  const pos = [];
  const ringAt = (k) => { const c = pts[k], r = rads[k]; return [...Array(SEG).keys()].map((j) => { const a = (j / SEG) * Math.PI * 2; return c.clone().add(new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r * 0.8, 0)); }); };
  for (let k = 0; k < S; k++) { const A = ringAt(k), B = ringAt(k + 1); for (let j = 0; j < SEG; j++) { const j2 = (j + 1) % SEG; pos.push(...A[j].toArray(), ...B[j].toArray(), ...B[j2].toArray(), ...A[j].toArray(), ...B[j2].toArray(), ...A[j2].toArray()); } }
  const beak = new THREE.BufferGeometry(); beak.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); beak.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2)); beak.setIndex([...Array(pos.length / 3).keys()]); beak.computeVertexNormals();
  out.push(new THREE.Mesh(beak, leather));
  return out;
}

// ---------------- textures (procedural, deterministic) ----------------
function rnd(seed) { let s = seed; return () => { s = (s * 16807) % 2147483647; return s / 2147483647; }; }
function paintMask(kind, { eyes, eyeEll, mouth }) {
  const N = 256, c = document.createElement('canvas'); c.width = c.height = N;
  const g = c.getContext('2d'), r = rnd(kind.length * 7919), X = (u) => u * N, Y = (v) => (1 - v) * N;
  const noise = (base, amp, cell = 2) => { for (let y = 0; y < N; y += cell) for (let x = 0; x < N; x += cell) { const k = (r() - 0.5) * amp; g.fillStyle = `rgb(${base.map((b) => Math.max(0, Math.min(255, b + k))).join(',')})`; g.fillRect(x, y, cell, cell); } };
  if (kind === 'doll') {
    noise([232, 224, 210], 14);
    g.fillStyle = 'rgba(210,90,95,0.45)'; for (const u of [[0.3, 0.42], [0.7, 0.42]]) { g.beginPath(); g.ellipse(X(u[0]), Y(u[1]), 20, 14, 0, 0, 7); g.fill(); }
    // eye rims and painted lashes
    g.strokeStyle = 'rgba(40,28,24,0.9)'; g.lineWidth = 2;
    for (const [cx, cy, rx, ry] of eyeEll) { g.beginPath(); g.ellipse(X(cx), Y(cy), rx * N * 1.05, ry * N * 1.05, 0, 0, 7); g.stroke(); for (let k = -3; k <= 3; k++) { const a = -Math.PI / 2 + k * 0.28; g.beginPath(); g.moveTo(X(cx) + Math.cos(a) * rx * N, Y(cy) + Math.sin(a) * ry * N); g.lineTo(X(cx) + Math.cos(a) * rx * N * 1.35, Y(cy) + Math.sin(a) * ry * N * 1.6); g.stroke(); } }
    // thin high brows
    g.lineWidth = 2.5; for (const [cx, cy, rx] of eyeEll) { g.beginPath(); g.arc(X(cx), Y(cy) + 4, rx * N * 1.3, Math.PI * 1.15, Math.PI * 1.85); g.stroke(); }
    // small painted lips (a cupid's bow, smaller than the real mouth)
    g.fillStyle = 'rgb(170,40,50)'; const mx = X(mouth[0]), my = Y(mouth[1]);
    g.beginPath(); g.moveTo(mx - 14, my); g.quadraticCurveTo(mx - 7, my - 8, mx, my - 3); g.quadraticCurveTo(mx + 7, my - 8, mx + 14, my); g.quadraticCurveTo(mx, my + 9, mx - 14, my); g.fill();
    // a crack down one side
    g.strokeStyle = 'rgba(60,50,45,0.85)'; g.lineWidth = 1.2; g.beginPath(); let x = X(0.62), y = Y(0.95); g.moveTo(x, y); for (let k = 0; k < 14; k++) { x += (r() - 0.35) * 10; y += 10; g.lineTo(x, y); } g.stroke();
  } else if (kind === 'plague') {
    noise([62, 44, 32], 22, 3);
    g.strokeStyle = 'rgba(20,14,10,0.8)'; g.lineWidth = 1.5; g.setLineDash([4, 4]);
    for (const x of [0.2, 0.8]) { g.beginPath(); g.moveTo(X(x), 0); g.lineTo(X(x), N); g.stroke(); }
    g.setLineDash([]);
  } else if (kind === 'sack') {
    noise([150, 118, 78], 26, 2);
    g.strokeStyle = 'rgba(80,58,34,0.5)'; g.lineWidth = 1; for (let k = 0; k < N; k += 4) { g.beginPath(); g.moveTo(0, k); g.lineTo(N, k); g.stroke(); g.beginPath(); g.moveTo(k, 0); g.lineTo(k, N); g.stroke(); }
    // ragged eye holes and a stitched mouth
    g.fillStyle = 'rgb(12,8,6)';
    for (const [u, v] of eyes) { const cx = X(u), cy = Y(v); g.beginPath(); for (let k = 0; k <= 16; k++) { const a = (k / 16) * Math.PI * 2, rr = 9 + r() * 5; g.lineTo(cx + Math.cos(a) * rr * 1.1, cy + Math.sin(a) * rr); } g.fill(); }
    g.strokeStyle = 'rgb(40,20,14)'; g.lineWidth = 2; const mx = X(mouth[0]), my = Y(mouth[1]);
    g.beginPath(); g.moveTo(mx - 22, my); g.lineTo(mx + 22, my + 2); g.stroke();
    for (let k = -20; k <= 20; k += 6) { g.beginPath(); g.moveTo(mx + k, my - 5); g.lineTo(mx + k + 2, my + 6); g.stroke(); }
    // a drawstring near the bottom
    g.strokeStyle = 'rgb(90,70,40)'; g.lineWidth = 3; g.beginPath(); g.moveTo(0, Y(0.04)); g.lineTo(N, Y(0.05)); g.stroke();
  } else if (kind === 'bandage') {
    g.clearRect(0, 0, N, N);
    for (let k = -N; k < N * 2; k += 15) { // diagonal strips, overlapping, with the odd gap
      const w = 12 + r() * 8, tilt = 0.35 + r() * 0.2;
      g.fillStyle = `rgb(${220 + r() * 20 | 0},${212 + r() * 18 | 0},${190 + r() * 18 | 0})`;
      g.beginPath(); g.moveTo(0, k); g.lineTo(N, k + N * tilt); g.lineTo(N, k + N * tilt + w); g.lineTo(0, k + w); g.fill();
      g.strokeStyle = 'rgba(150,120,90,0.5)'; g.lineWidth = 1; g.stroke();
    }
    g.fillStyle = 'rgba(140,40,30,0.55)'; for (let k = 0; k < 4; k++) { g.beginPath(); g.ellipse(r() * N, r() * N, 6 + r() * 8, 4 + r() * 6, r() * 3, 0, 7); g.fill(); } // old stains
    g.globalCompositeOperation = 'destination-out'; // the eyes stay open
    for (const [u, v] of eyes) { g.beginPath(); g.ellipse(X(u), Y(v), 14, 9, 0, 0, 7); g.fill(); }
    g.globalCompositeOperation = 'source-over';
  }
  const t = new THREE.CanvasTexture(c); t.magFilter = t.minFilter = THREE.NearestFilter;
  return t;
}
