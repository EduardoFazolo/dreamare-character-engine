// Life: a body that passes for human, with moments where it doesn't (pose.alive.life: 0..1, how often and how far
// it slips). Everything here is smooth in time (no steps: every value eases in and out, nothing moves faster than
// a startled person), driven by time alone (a snapped frame or an export is the same every run), and laid on top
// of whatever pose the body holds.
//   human, always: breathing whose rate wanders (inhale shorter than exhale, now and then a deeper one), the
//     weight shifting from foot to foot, the trunk swaying, the head and hands never perfectly still
//   slips, now and then (a seeded schedule): the head tilting too far and holding it, a shoulder hitching up, the
//     fingers curling slowly, a breath that catches and doesn't come, and the worst one: everything stopping, the
//     breathing too, for a second or two, as if it forgot it was supposed to be moving
import * as THREE from 'three';

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _a = new THREE.Vector3();
const AX = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) }; // (as a bone's local x, the elbow / knee hinge)
function turn(root, bone, axis, angle) { // about an axis in the character's own frame (+X its left, +Y up, +Z forward)
  if (!bone || !angle) return;
  root.getWorldQuaternion(_q); bone.getWorldQuaternion(_q2);
  bone.rotateOnAxis(_a.copy(axis).applyQuaternion(_q).applyQuaternion(_q2.invert()).normalize(), angle); bone.updateMatrixWorld(true);
}
const sm = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };
// smooth noise: a few incommensurate sines (C-infinity, never repeats in a shot)
const noise = (t, s, f = 1) => Math.sin(t * 0.71 * f + s) * 0.5 + Math.sin(t * 1.37 * f + s * 2.1) * 0.3 + Math.sin(t * 2.93 * f + s * 3.7) * 0.2;
// an envelope: in over `a` s, hold `h`, out over `r` (all eased), 0 outside
const env = (u, a, h, r) => (u <= 0 || u >= a + h + r ? 0 : u < a ? sm(u / a) : u < a + h ? 1 : 1 - sm((u - a - h) / r));

// the slips active at time t: [{ kind, k (0..1), side }]; also `still` (0..1: how far life has stopped).
// A twitch snaps in (2-3 frames: a real jerk, with a little overshoot), holds a moment, then the body corrects
// itself slowly and smoothly (0.8-1.6 s), as if it noticed and put itself back. Often (every ~1-2 s), overlapping.
function slips(t, amt, seed) {
  const h = (n, k) => { const x = Math.sin(n * 127.1 + k * 311.7 + seed * 17.3) * 43758.5453; return x - Math.floor(x); };
  const S = 2.2 - 1.2 * amt, out = []; let still = 0;
  const KINDS = ['head', 'elbow', 'shoulder', 'arm', 'head', 'wrist', 'spine', 'fingers', 'elbow', 'head', 'arm', 'still'];
  const snap = (u, a) => { const x = u / a; return x < 1 ? 1 - (1 - x) ** 3 + Math.sin(x * Math.PI) * 0.15 : 1; }; // (fast in, a touch past, back)
  for (let n = Math.max(0, Math.floor(t / S) - 3); n <= Math.floor(t / S); n++) {
    if (h(n, 1) > 0.6 + 0.38 * amt) continue;
    const kind = KINDS[Math.floor(h(n, 2) * KINDS.length)], start = n * S + h(n, 3) * S, u = t - start, side = h(n, 4) < 0.5 ? 1 : -1;
    if (u <= 0) continue;
    let k;
    if (kind === 'still') { k = env(u, 0.3, 1.0 + h(n, 5) * 0.8, 0.6); if (k > 0) still = Math.max(still, k); continue; }
    const a = 0.06 + h(n, 6) * 0.04, hold = 0.1 + h(n, 5) * 0.25, rel = 0.8 + h(n, 7) * 0.8; // (in 2-3 frames, a beat, then the slow fix)
    if (u >= a + hold + rel) continue;
    k = u < a ? snap(u, a) : u < a + hold ? 1 : 1 - sm((u - a - hold) / rel);
    out.push({ kind, k: k * (0.55 + 0.45 * amt), side, r: h(n, 8), q: h(n, 9) });
  }
  return { list: out, still };
}

// lay life on the rig (after the pose, before the look). amt: alive.life. Returns { breath (0..1), still }.
export function humanLife(o, t, amt, curl) {
  const B = o.rig.bones, root = o.root, sd = o.data.id.charCodeAt(0) * 3.1 + o.data.id.length;
  root.updateMatrixWorld(true);
  const sl = slips(t, amt, sd), live = 1 - sl.still; // (stopping: every living motion fades out together, the breathing too)
  // breathing: the phase advances at a wandering rate (~13-17 a minute), inhale 40% / exhale 60%, every fourth or
  // so a deeper one; a catch holds the breath halfway
  const ph = t * 0.25 + 0.6 * Math.sin(t * 0.11 + sd) + 0.25 * Math.sin(t * 0.043 + sd * 2), f = ph - Math.floor(ph);
  let b = f < 0.4 ? sm(f / 0.4) : 1 - sm((f - 0.4) / 0.6);
  b *= 0.75 + 0.35 * sm(Math.sin(Math.floor(ph) * 2.7 + sd) * 0.5 + 0.5);
  const cat = sl.list.find((s) => s.kind === 'catch'); if (cat) b = b * (1 - cat.k) + 0.45 * cat.k; // (held, half full)
  b *= live;
  turn(root, B.Spine1, AX.x, -0.05 * b); turn(root, B.Spine2, AX.x, -0.04 * b); // (the chest rising)
  turn(root, B.LeftShoulder, AX.z, 0.045 * b); turn(root, B.RightShoulder, AX.z, -0.045 * b); // (the shoulders lifting with it)
  if (B.Spine2) { const s = 1 + 0.025 * b; B.Spine2.scale.set(s, 1, s); B.Spine2.updateMatrixWorld(true); }
  // the weight shifting and the trunk swaying (slow, a few degrees), the head and hands never quite still
  const w = live;
  turn(root, B.Hips, AX.z, noise(t * 0.7, sd) * 0.04 * w); turn(root, B.Spine, AX.z, -noise(t * 0.7, sd) * 0.03 * w);
  turn(root, B.Spine1, AX.y, noise(t * 0.55, sd + 4) * 0.035 * w); turn(root, B.Spine, AX.x, noise(t * 0.6, sd + 7) * 0.012 * w);
  turn(root, B.Neck, AX.x, noise(t * 1.1, sd + 9) * 0.01 * w); turn(root, B.Head, AX.z, noise(t * 0.9, sd + 11) * 0.015 * w); turn(root, B.Head, AX.y, noise(t * 0.8, sd + 13) * 0.012 * w);
  // the arms: never hanging dead; the upper arm drifting forward/back, out and twisting, the elbow bending and
  // unbending on its own, the forearm turning, the wrist and fingers fidgeting (each side its own rhythm)
  for (const [side, L] of [['Left', 1], ['Right', -1]]) {
    const o2 = L > 0 ? 0 : 50, n1 = noise(t * 0.85, sd + 20 + o2), n2 = noise(t * 0.75, sd + 30 + o2), n3 = noise(t * 0.6, sd + 35 + o2), n4 = noise(t * 0.95, sd + 38 + o2);
    turn(root, B[`${side}Arm`], AX.x, (n1 * 0.14 + 0.04 * b) * w); turn(root, B[`${side}Arm`], AX.z, L * (0.05 + n2 * 0.08) * w); turn(root, B[`${side}Arm`], AX.y, L * n3 * 0.12 * w);
    if (B[`${side}ForeArm`]) { B[`${side}ForeArm`].rotateOnAxis(AX.x, Math.max(0, (0.25 + 0.3 * (n4 * 0.5 + 0.5)) * w)); B[`${side}ForeArm`].rotateOnAxis(AX.y, noise(t * 0.7, sd + 44 + o2) * 0.35 * w); B[`${side}ForeArm`].updateMatrixWorld(true); } // (elbow: its hinge, forward only; and the forearm twisting)
    turn(root, B[`${side}Hand`], AX.x, noise(t * 1.4, sd + 40 + o2) * 0.15 * w); turn(root, B[`${side}Hand`], AX.z, noise(t * 1.1, sd + 47 + o2) * 0.12 * w);
    if (curl) { const c = (noise(t * 0.9, sd + 60 + o2) * 0.5 + 0.5) * 0.35 * w; curl(o.rig, side, { Index: [c * 0.6, c, c * 0.7], Middle: [c * 0.8, c, c * 0.7], Ring: [c, c, c * 0.7], Pinky: [c * 1.1, c, c * 0.7] }); }
  }
  // the slips
  for (const s of sl.list) {
    const k = s.k, L = s.side, side = L > 0 ? 'Left' : 'Right', fa = B[`${side}ForeArm`];
    if (s.kind === 'head') { turn(root, B.Head, AX.z, -L * (0.25 + 0.2 * s.r) * k); turn(root, B.Head, AX.y, L * (s.q - 0.5) * 0.5 * k); turn(root, B.Neck, AX.z, -L * 0.1 * k); }
    else if (s.kind === 'shoulder') { turn(root, B[`${side}Shoulder`], AX.z, L * 0.22 * k); turn(root, B.Head, AX.z, L * 0.08 * k); }
    else if (s.kind === 'elbow' && fa) { fa.rotateOnAxis(AX.x, (0.7 + 0.6 * s.r) * k); fa.updateMatrixWorld(true); turn(root, B[`${side}Arm`], AX.x, 0.25 * k); } // (the elbow snapping up)
    else if (s.kind === 'arm') { turn(root, B[`${side}Arm`], AX.z, L * (0.35 + 0.3 * s.r) * k); turn(root, B[`${side}Arm`], AX.y, L * 0.3 * (s.q - 0.5) * k); } // (the arm flung out)
    else if (s.kind === 'wrist') { turn(root, B[`${side}Hand`], AX.x, (s.q < 0.5 ? -1 : 1) * 0.8 * k); turn(root, B[`${side}Hand`], AX.z, L * 0.4 * k); }
    else if (s.kind === 'spine') { turn(root, B.Spine1, AX.x, 0.18 * k); turn(root, B.Spine2, AX.z, L * 0.1 * k); turn(root, B.Head, AX.x, -0.15 * k); } // (the trunk hiccuping)
    else if (s.kind === 'fingers' && curl) curl(o.rig, side, { Index: [1.0 * k, 1.1 * k, 0.7 * k], Middle: [-0.3 * k, 1.1 * k, 0.8 * k], Ring: [1.1 * k, 1.1 * k, 0.8 * k], Pinky: [-0.4 * k, 0.9 * k, 0.6 * k], Thumb: [0.3 * k, 0.5 * k, 0.3 * k] }); // (a spasm, uneven)
  }
  root.updateMatrixWorld(true);
  return { breath: b, still: sl.still };
}
