// Things worn on the face, built on the head's own mesh (head.js HeadRig, head units: face width = 1):
//   gadgets: monocle, glasses, cigar, cigarette, pipe (small rigid meshes at the eyes / a mouth corner)
//   masks (people only, Face: mask):
//     doll     a porcelain face plate over the face (eye holes, painted cheeks, lips, brows, a crack)
//     plague   a leather plate with glass eyes and a long curved beak
//     sack     a burlap sack over the whole head (painted ragged eye holes, a stitched mouth), hides the hair
//     bandage  gauze strips wound round the whole head, gaps showing skin, eyes left open; hides the hair
//     kiddie   a cheap glossy children's-character mask: pastel yellow, a huge fixed painted grin, round pink
//              cheeks, cartoon brows, eye holes for the real eyes, an elastic band round the head, a little antenna
// Plates and wraps are offset copies of the head's own surface and carry its morph targets, so they move
// with the jaw and brows. Textures are painted procedurally (nothing to license).
import * as THREE from 'three';
import { ps2Material } from './head.js';
import { MORPHS } from './faceanim.js';

export const GADGETS = ['none', 'monocle', 'glasses', 'cigar', 'cigarette', 'pipe'];
export const MASKS = ['doll', 'plague', 'sack', 'bandage', 'kiddie', 'pig'];
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
export function buildMask(kind, shell, P, size = 1, { hatY = null } = {}) {
  const g = new THREE.Group();
  if (!kind || !shell) return g;
  const full = kind === 'sack' || kind === 'bandage';
  const off = { doll: 0.022, plague: 0.03, sack: 0.075, bandage: 0.028, kiddie: 0.03, pig: 0.035 }[kind];
  const { pos, idx, faceTris, canonUV } = shell;
  // normals of the head surface, then the offset copy
  const tmp = new THREE.BufferGeometry(); tmp.setAttribute('position', new THREE.BufferAttribute(pos, 3)); tmp.setIndex(idx); tmp.computeVertexNormals();
  const nrm = tmp.attributes.normal.array, n = pos.length / 3, out = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; i++) out[i] = pos[i] + nrm[i] * off;
  // which triangles: the face alone (plates) or everything (wraps); plates get eye holes
  const eyeEll = [EYE_R, EYE_L].map((ids) => { const us = ids.map((i) => canonUV[i]); const cx = us.reduce((s, u) => s + u[0], 0) / us.length, cy = us.reduce((s, u) => s + u[1], 0) / us.length; const rx = Math.max(...us.map((u) => Math.abs(u[0] - cx))) * 1.25, ry = Math.max(...us.map((u) => Math.abs(u[1] - cy))) * 1.6; return [cx, cy, rx, ry]; });
  const inEye = (i) => { const u = canonUV[i]; return u && eyeEll.some(([cx, cy, rx, ry]) => ((u[0] - cx) / rx) ** 2 + ((u[1] - cy) / ry) ** 2 < 1); };
  // the kiddie mask: bigger eye holes and a mouth hole (his real eyes and lips show through, lined up), and when
  // smaller than the face (size < 1) the plate is cut down round its middle instead of scaled, so the holes stay on
  // the real features: a child's mask on a big head, the real face all round it
  const kid = kind === 'kiddie' || kind === 'pig', KID_EYE = kind === 'pig' ? [1.15, 1.6] : [1.4, 2.3]; // (the eye holes' size against the eyes: wide, tall, still two holes)
  const mouthEll = (() => { const ids = [61, 291, 0, 17, 13, 14, 39, 269, 181, 405], us = ids.map((i) => canonUV[i]); const cx = us.reduce((s, u) => s + u[0], 0) / us.length, cy = us.reduce((s, u) => s + u[1], 0) / us.length; return [cx, cy, Math.max(...us.map((u) => Math.abs(u[0] - cx))) * 1.05, Math.max(...us.map((u) => Math.abs(u[1] - cy))) * 1.15]; })();
  const inEll = (u, [cx, cy, rx, ry], k = 1) => ((u[0] - cx) / (rx * k)) ** 2 + ((u[1] - cy) / (ry * k)) ** 2 < 1;
  const eyeMid = [(eyeEll[0][0] + eyeEll[1][0]) / 2, (eyeEll[0][1] + eyeEll[1][1]) / 2], midU = [eyeMid[0], (eyeMid[1] * 0.6 + mouthEll[1] * 0.4)];
  const spanX = Math.abs(eyeEll[1][0] - eyeEll[0][0]), spanY = Math.abs(eyeMid[1] - mouthEll[1]); // (the plate's reach: from the eyes' spacing and the eyes-to-mouth height, so any face fits)
  // wide open round the eyes: his real eyes and the skin round them show through
  const keepK = (i) => { const u = canonUV[i]; if (!u) return true; if (eyeEll.some(([cx, cy, rx, ry]) => inEll(u, [cx, cy, rx * KID_EYE[0], ry * KID_EYE[1]]))) return false; return size >= 1 || Math.hypot((u[0] - midU[0]) / (spanX * 1.15), (u[1] - midU[1]) / (spanY * 1.55)) < size * 1.35; };
  const tris = [];
  for (let t = 0; t < (full ? idx.length : faceTris * 3); t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    if (kid && hatY != null && Math.max(out[a * 3 + 1], out[b * 3 + 1], out[c * 3 + 1]) > hatY - 0.03) continue; // (under a hat: the mask ends below its brim instead of running up through it)
    if (kid && a < 468 && b < 468 && c < 468) { if (!keepK(a) || !keepK(b) || !keepK(c)) continue; tris.push(a, b, c); continue; }
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
  // size: the plate scaled about the nose (a child's mask strapped on a big head: the real face shows round it),
  // held just off the skin so it doesn't sink in; the kiddie mask's band still runs round the full-size head
  const c = V(P[4]).add(new THREE.Vector3(0, 0.05, 0)), lift = (1 - size) * 0.12;
  const sp = (v) => (size === 1 || full || kid ? v.clone() : c.clone().add(v.clone().sub(c).multiplyScalar(size)).add(new THREE.Vector3(0, 0, lift)));
  if (size !== 1 && !full && !kid) { const pl = g.children[0]; pl.position.set(c.x * (1 - size), c.y * (1 - size), c.z * (1 - size) + lift); pl.scale.setScalar(size); }
  if (kind === 'pig') g.add(...pigParts(P));
  if (kid) { // the band from the plate's own edges at the eyes' height (measured from what's kept)
    const ey = (avg(P, EYE_R).y + avg(P, EYE_L).y) / 2; let lo = null, hi = null;
    for (const v of new Set(tris)) { const x = out[v * 3], y = out[v * 3 + 1]; if (Math.abs(y - ey) > 0.07) continue; if (!lo || x < lo.x) lo = new THREE.Vector3(x, y, out[v * 3 + 2]); if (!hi || x > hi.x) hi = new THREE.Vector3(x, y, out[v * 3 + 2]); }
    g.add(...kiddieParts(P, sp, lo, hi, hatY != null || kind === 'pig')); // (under a hat, no antenna: it would poke through the cap)
  }
  return g;
}

// the kiddie mask's elastic band (round the back of the head at the eyes' height) and its little antenna
function kiddieParts(P, sp = (v) => v, edgeA = null, edgeB = null, noAntenna = false) {
  const band = mat([0.08, 0.08, 0.08], 'mask'), wire = mat([0.95, 0.85, 0.35], 'mask'), out = [];
  const eR = avg(P, EYE_R), eL = avg(P, EYE_L), y = (eR.y + eL.y) / 2, hw = V(P[234]).distanceTo(V(P[454])) / 2;
  const a = edgeA ? edgeA.clone().setY(y) : sp(V(P[234]).setY(y)), b = edgeB ? edgeB.clone().setY(y) : sp(V(P[454]).setY(y)); // (from the mask's own edges, however small, round the back of the real head)
  const curve = new THREE.CatmullRomCurve3([a, new THREE.Vector3(-hw * 1.05, y, -hw * 0.2), new THREE.Vector3(-hw * 0.9, y, -hw * 0.8), new THREE.Vector3(0, y + 0.02, -hw * 1.25), new THREE.Vector3(hw * 0.9, y, -hw * 0.8), new THREE.Vector3(hw * 1.05, y, -hw * 0.2), b]);
  out.push(new THREE.Mesh(new THREE.TubeGeometry(curve, 32, 0.012, 4, false), band));
  if (noAntenna) return out;
  const top = sp(V(P[10]).add(new THREE.Vector3(0, 0.02, 0.03)));
  const stem = new THREE.CatmullRomCurve3([top, top.clone().add(new THREE.Vector3(0.01, 0.12, 0.02)), top.clone().add(new THREE.Vector3(-0.02, 0.24, 0.04))]);
  out.push(new THREE.Mesh(new THREE.TubeGeometry(stem, 10, 0.012, 5, false), wire));
  out.push(new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.012, 5, 14).translate(-0.02, 0.29, 0.04).translate(top.x, top.y, top.z), wire)); // (a ring, like a children's-TV antenna)
  return out;
}
// the pig mask's snout (a fat pink disc on a short cone, two dark nostrils) and floppy ears at the temples
function pigParts(P) {
  const pink = mat([1.15, 0.78, 0.82], 'mask'), dark = mat([0.25, 0.08, 0.1], 'mask'), out = [];
  const nose = V(P[4]), hw = V(P[234]).distanceTo(V(P[454])) / 2;
  const base = nose.clone().add(new THREE.Vector3(0, -0.02, -0.02)), r = hw * 0.36, len = hw * 0.32;
  const sn = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.12, len, 20).rotateX(Math.PI / 2).translate(base.x, base.y, base.z + len / 2), pink); out.push(sn);
  out.push(new THREE.Mesh(new THREE.CircleGeometry(r * 0.98, 20).translate(base.x, base.y, base.z + len + 0.003), pink));
  for (const sx of [-1, 1]) out.push(new THREE.Mesh(new THREE.CircleGeometry(r * 0.24, 10).scale(0.7, 1.15, 1).translate(base.x + sx * r * 0.38, base.y, base.z + len + 0.006), dark));
  for (const sx of [-1, 1]) { // ears: flat triangles, flopped forward
    const t = V(P[sx < 0 ? 103 : 332]).add(new THREE.Vector3(sx * 0.04, 0.06, -0.05)), sh = new THREE.Shape(); sh.moveTo(-0.11, 0); sh.lineTo(0.11, 0); sh.lineTo(0, 0.24); sh.lineTo(-0.11, 0);
    const e = new THREE.Mesh(new THREE.ShapeGeometry(sh), mat([0.88, 0.52, 0.58], 'mask')); e.material.side = THREE.DoubleSide; e.position.copy(t); e.rotation.set(-0.5, sx * 0.35, sx * -0.55); out.push(e);
  }
  return out;
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
  } else if (kind === 'pig') { // a cheap rubber pig mask: pink latex, darker in the creases, grubby, painted eyelids, a mouth slit
    noise([246, 200, 204], 12, 2);
    const gr = g.createRadialGradient(X(0.5), Y(0.55), 20, X(0.5), Y(0.5), N * 0.62); gr.addColorStop(0, 'rgba(255,235,238,.3)'); gr.addColorStop(1, 'rgba(150,80,90,.3)'); g.fillStyle = gr; g.fillRect(0, 0, N, N);
    g.fillStyle = 'rgba(90,60,40,.18)'; for (let k = 0; k < 60; k++) { g.beginPath(); g.ellipse(r() * N, r() * N, 2 + r() * 7, 1 + r() * 4, r() * 3, 0, 7); g.fill(); } // grime
    g.strokeStyle = 'rgba(120,50,60,.6)'; g.lineWidth = 2; for (const [cx, cy, rx, ry] of eyeEll) { for (let k = 0; k < 3; k++) { g.beginPath(); g.arc(X(cx), Y(cy) - ry * N * (1.9 + k * 0.35), rx * N * (1.3 + k * 0.2), Math.PI * 1.15, Math.PI * 1.85); g.stroke(); } } // wrinkled brow
    g.fillStyle = 'rgba(60,20,30,.55)'; for (const [cx, cy, rx, ry] of eyeEll) { g.beginPath(); g.ellipse(X(cx), Y(cy), rx * N * 1.25, ry * N * 1.75, 0, 0, 7); g.fill(); } // dark latex round the holes
    const mx = X(mouth[0]), my = Y(mouth[1]); g.strokeStyle = 'rgb(70,20,30)'; g.lineWidth = 4; g.beginPath(); g.moveTo(mx - 40, my - 6); g.quadraticCurveTo(mx, my + 14, mx + 40, my - 6); g.stroke(); // a thin smiling slit
  } else if (kind === 'kiddie') {
    noise([246, 222, 92], 8, 2); // pastel yellow moulded plastic
    const gr = g.createRadialGradient(X(0.5), Y(0.62), 10, X(0.5), Y(0.5), N * 0.7); gr.addColorStop(0, 'rgba(255,255,230,.35)'); gr.addColorStop(1, 'rgba(160,120,20,.25)'); g.fillStyle = gr; g.fillRect(0, 0, N, N);
    g.fillStyle = 'rgba(255,120,150,0.75)'; for (const u of [[0.26, 0.4], [0.74, 0.4]]) { g.beginPath(); g.arc(X(u[0]), Y(u[1]), 22, 0, 7); g.fill(); } // round pink cheeks
    g.strokeStyle = 'rgb(40,24,20)'; g.lineWidth = 5; g.lineCap = 'round';
    for (const [cx, cy, rx, ry] of eyeEll) { g.beginPath(); g.arc(X(cx), Y(cy) + ry * N * 0.9, rx * N * 1.6, Math.PI * 1.2, Math.PI * 1.8); g.stroke(); } // high cartoon brows (above the wide holes)
    for (const [cx, cy, rx, ry] of eyeEll) { g.lineWidth = 3; g.beginPath(); g.ellipse(X(cx), Y(cy), rx * N * 1.45, ry * N * 2.35, 0, 0, 7); g.stroke(); } // painted rims round the (wide) holes
    const mx = X(mouth[0]), my = Y(mouth[1]); // the grin: far too wide, fixed, a dark mouth with a tongue
    g.fillStyle = 'rgb(70,14,24)'; g.beginPath(); g.moveTo(mx - 62, my - 14); g.quadraticCurveTo(mx, my + 70, mx + 62, my - 14); g.quadraticCurveTo(mx, my + 8, mx - 62, my - 14); g.fill();
    g.fillStyle = 'rgb(232,90,110)'; g.beginPath(); g.ellipse(mx, my + 26, 22, 10, 0, 0, 7); g.fill();
    g.fillStyle = 'rgb(250,248,236)'; g.beginPath(); g.moveTo(mx - 52, my - 8); g.quadraticCurveTo(mx, my + 10, mx + 52, my - 8); g.lineTo(mx + 46, my - 2); g.quadraticCurveTo(mx, my + 16, mx - 46, my - 2); g.fill(); // a row of top teeth
    g.strokeStyle = 'rgb(40,24,20)'; g.lineWidth = 4; g.beginPath(); g.moveTo(mx - 62, my - 14); g.quadraticCurveTo(mx, my + 70, mx + 62, my - 14); g.stroke();
    for (const sx of [-1, 1]) { g.beginPath(); g.arc(mx + sx * 66, my - 18, 6, 0, 7); g.stroke(); } // dimples
    g.fillStyle = 'rgba(120,90,40,.35)'; for (let k = 0; k < 40; k++) g.fillRect(r() * N, r() * N, 1 + r() * 3, 1); // scuffs
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
