// Posing characters in the scene editor.
//  - detect(image): MediaPipe pose (heavy model, still images) + hands on a photo or a webcam frame
//  - retarget(rig, det, { mirror }): landmarks -> a pose for our GLB skeleton (Mixamo-style names, every bone
//    points along its local +Y, characters face +Z), feet put back on the ground
//  - IK for the editor's drag handles: hands / feet (two-bone, elbows and knees keep their bend plane),
//    head (look), chest (bend spread over the spine), hips (crouch with the feet planted)
//  - breathe(rig, t): a small additive breath on top of a still pose
// A pose is { bones: { name: [x, y, z, w] (local) }, hips: [x, y, z] }: the same shape a keyframe will have.
import * as THREE from 'three';
import { FilesetResolver, PoseLandmarker, HandLandmarker } from '@mediapipe/tasks-vision';

const UP = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _v = new THREE.Vector3(), _m = new THREE.Matrix4();

// ---------------- detection ----------------
let detectors = null;
async function load() {
  detectors ||= (async () => {
    const fileset = await FilesetResolver.forVisionTasks('/wasm');
    const opts = (path) => ({ baseOptions: { modelAssetPath: path, delegate: 'GPU' }, runningMode: 'IMAGE' });
    const [pose, hands] = await Promise.all([
      PoseLandmarker.createFromOptions(fileset, { ...opts('/models/pose_landmarker_heavy.task'), numPoses: 1 }).catch(() => PoseLandmarker.createFromOptions(fileset, { ...opts('/models/pose_landmarker_lite.task'), numPoses: 1 })),
      HandLandmarker.createFromOptions(fileset, { ...opts('/models/hand_landmarker.task'), numHands: 2 }),
    ]);
    return { pose, hands };
  })();
  return detectors;
}
export async function detect(image) {
  const { pose, hands } = await load();
  const p = pose.detect(image), h = hands.detect(image);
  if (!p.worldLandmarks?.[0]) return null;
  return { world: p.worldLandmarks[0], norm: p.landmarks[0], hands: (h.landmarks || []).map((lm, k) => ({ norm: lm, world: h.worldLandmarks[k] })) };
}

// ---------------- the rig: bones of one character, its rest pose ----------------
export function makeRig(root) {
  const bones = {};
  root.traverse((o) => { if (o.isBone) bones[o.name] = o; });
  const skelRoot = bones.Hips?.parent; // the Root node: poses live in its space
  const rest = Object.fromEntries(Object.entries(bones).map(([n, b]) => [n, b.quaternion.clone()]));
  const restHips = bones.Hips.position.clone();
  const rig = { root, bones, skelRoot, rest, restHips };
  rig.restFootY = footMinY(rig);
  return rig;
}
// rotation of a bone in Root space (walk the parents; nothing above Root counts)
function rootQ(rig, bone, out = new THREE.Quaternion()) {
  out.identity();
  for (let b = bone; b && b !== rig.skelRoot; b = b.parent) out.premultiply(b.quaternion);
  return out.normalize();
}
function rootPos(rig, bone, out = new THREE.Vector3()) {
  rig.skelRoot.updateMatrixWorld(true);
  _m.copy(rig.skelRoot.matrixWorld).invert();
  return out.setFromMatrixPosition(bone.matrixWorld).applyMatrix4(_m);
}
// set a bone's Root-space rotation (its parents already final)
function setRootQ(rig, name, q) {
  const b = rig.bones[name]; if (!b) return;
  const parentQ = b.parent === rig.skelRoot ? new THREE.Quaternion() : rootQ(rig, b.parent);
  // always unit length: three's inverse (a conjugate) and setFromUnitVectors assume it, and any drift
  // compounds drag after drag into scaled bone matrices (a stretched, giant limb)
  b.quaternion.copy(parentQ.invert().multiply(q)).normalize();
}
// turn a bone (minimal rotation) so its +Y points along d (Root space)
function aim(rig, name, d) {
  const b = rig.bones[name]; if (!b || d.lengthSq() < 1e-10) return;
  const q = rootQ(rig, b), cur = UP.clone().applyQuaternion(q).normalize();
  setRootQ(rig, name, _q2.setFromUnitVectors(cur, d.clone().normalize()).multiply(q).normalize().clone());
}
// frame from a bone direction y and a reference axis z (made orthogonal); x = y × z
const basis = (y, z) => {
  const Y = y.clone().normalize(), Z = z.clone().addScaledVector(Y, -z.dot(Y)).normalize(), X = new THREE.Vector3().crossVectors(Y, Z);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, Y, Z));
};

export const snapshot = (rig) => ({
  bones: Object.fromEntries(Object.entries(rig.bones).map(([n, b]) => [n, b.quaternion.clone().normalize().toArray().map((v) => +v.toFixed(5))])),
  hips: rig.bones.Hips.position.toArray().map((v) => +v.toFixed(5)),
});
export function applyPose(rig, pose) {
  for (const [n, b] of Object.entries(rig.bones)) { const q = pose.bones[n]; b.quaternion.copy(q ? _q.fromArray(q) : rig.rest[n]).normalize(); } // stored values are rounded
  rig.bones.Hips.position.fromArray(pose.hips || rig.restHips.toArray());
  rig.root.updateMatrixWorld(true);
}
export function resetRest(rig) { for (const [n, b] of Object.entries(rig.bones)) b.quaternion.copy(rig.rest[n]); rig.bones.Hips.position.copy(rig.restHips); rig.root.updateMatrixWorld(true); }
// blend two poses (for the smooth arrival of a new pose)
export function lerpPose(a, b, t) {
  const bones = {};
  for (const n of new Set([...Object.keys(a.bones), ...Object.keys(b.bones)])) {
    const qa = _q.fromArray(a.bones[n] || b.bones[n]).normalize(), qb = _q2.fromArray(b.bones[n] || a.bones[n]).normalize();
    bones[n] = qa.clone().slerp(qb, t).normalize().toArray();
  }
  return { bones, hips: a.hips.map((v, i) => v + (b.hips[i] - v) * t) };
}

// lowest point of the feet (toe and ankle joints), Root space
function footMinY(rig) {
  rig.root.updateMatrixWorld(true);
  let y = Infinity;
  for (const n of ['LeftFoot', 'RightFoot', 'LeftToeBase', 'RightToeBase']) if (rig.bones[n]) y = Math.min(y, rootPos(rig, rig.bones[n], _v).y);
  return y;
}
// keep the feet on the ground: the hips go down (crouch, kneel) or up by however much the lowest foot moved
export function ground(rig) {
  const dy = footMinY(rig) - rig.restFootY;
  rig.bones.Hips.position.y -= dy / (rig.skelRoot.scale.y || 1);
  rig.root.updateMatrixWorld(true);
}

// ---------------- photo -> pose ----------------
// MediaPipe world landmarks: meters, hip-centred, x right in the image, y down, z away from the camera.
// Character space: +x its left, +y up, +z its front. A person facing the camera: their left is image right.
const L = { shoulder: 11, elbow: 13, wrist: 15, pinky: 17, index: 19, hip: 23, knee: 25, ankle: 27, heel: 29, toe: 31, ear: 7 };
export function retarget(rig, det, { mirror = false } = {}) {
  resetRest(rig);
  const vis = (i) => (det.norm[i]?.visibility ?? 1) > 0.5;
  const side = (i, s) => (s === 'Right' ? i + 1 : i); // MediaPipe: left = odd, right = even (+1)
  // mirror: the character does what a mirror would (your left arm moves its right): swap sides, flip x
  const idx = (i, s) => side(i, mirror ? (s === 'Left' ? 'Right' : 'Left') : s);
  const toChar = (l) => new THREE.Vector3(mirror ? -l.x : l.x, -l.y, -l.z);
  let P = det.world.map(toChar);
  // take out the photo's facing: the pose is relative to the hips (the character keeps its turn in the scene)
  const hipLine = P[idx(L.hip, 'Left')].clone().sub(P[idx(L.hip, 'Right')]); hipLine.y = 0;
  const unturn = new THREE.Quaternion().setFromUnitVectors(hipLine.normalize(), new THREE.Vector3(1, 0, 0));
  P = P.map((p) => p.applyQuaternion(unturn));
  const pt = (i, s) => P[idx(i, s)], mid = (a, b) => a.clone().add(b).multiplyScalar(0.5);

  // torso: hips from the hip line, chest from the shoulder line; the spine shares the difference
  const up = mid(pt(L.shoulder, 'Left'), pt(L.shoulder, 'Right')).sub(mid(pt(L.hip, 'Left'), pt(L.hip, 'Right')));
  const across = (i) => pt(i, 'Left').clone().sub(pt(i, 'Right'));
  const hipsQ = basis(up, new THREE.Vector3().crossVectors(across(L.hip), up)).multiply(new THREE.Quaternion()); // y = up, z = front
  const chestQ = basis(up, new THREE.Vector3().crossVectors(across(L.shoulder), up));
  setRootQ(rig, 'Hips', hipsQ);
  const delta = hipsQ.clone().invert().multiply(chestQ);
  for (const n of ['Spine', 'Spine1', 'Spine2']) rig.bones[n]?.quaternion.copy(rig.rest[n]).multiply(new THREE.Quaternion().slerp(delta, 1 / 3));
  // head: ear line and the nose; the neck takes a third
  if (vis(0) && vis(7) && vis(8)) {
    const ears = pt(L.ear, 'Left').clone().sub(pt(L.ear, 'Right')), front = P[0].clone().sub(mid(pt(L.ear, 'Left'), pt(L.ear, 'Right')));
    const Z = front.addScaledVector(ears.clone().normalize(), -front.dot(ears.clone().normalize())).normalize(), X = ears.normalize(), Y = new THREE.Vector3().crossVectors(Z, X);
    const headQ = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, Y, Z));
    const chest = rootQ(rig, rig.bones.Spine2), rel = chest.clone().invert().multiply(headQ);
    if (2 * Math.acos(Math.min(1, Math.abs(rel.w))) < 1.4) { // ignore wild head guesses (>80°)
      const n = new THREE.Quaternion().slerp(rel, 0.35);
      rig.bones.Neck.quaternion.copy(rig.rest.Neck).multiply(n);
      rig.bones.Head.quaternion.copy(rig.rest.Head).multiply(n.clone().invert().multiply(rel));
    }
  }
  // arms and legs: aim each bone at the next joint (limbs the photo can't see keep standing)
  for (const s of ['Left', 'Right']) {
    const sh = pt(L.shoulder, s), el = pt(L.elbow, s), wr = pt(L.wrist, s);
    if (vis(idx(L.elbow, s)) && vis(idx(L.wrist, s))) {
      aim(rig, `${s}Arm`, el.clone().sub(sh)); aim(rig, `${s}ForeArm`, wr.clone().sub(el));
      // hand frame from the pose's pinky / index points (fingers along +Y, pinky -> index along +Z)
      const pi = pt(L.pinky, s), ix = pt(L.index, s);
      setRootQ(rig, `${s}Hand`, basis(mid(pi, ix).sub(wr), ix.clone().sub(pi)).multiply(restHandTwist(rig, s)));
    }
    const hp = pt(L.hip, s), kn = pt(L.knee, s), an = pt(L.ankle, s);
    if (vis(idx(L.knee, s)) && vis(idx(L.ankle, s))) {
      aim(rig, `${s}UpLeg`, kn.clone().sub(hp)); aim(rig, `${s}Leg`, an.clone().sub(kn));
      if (vis(idx(L.toe, s))) aim(rig, `${s}Foot`, pt(L.toe, s).clone().sub(an));
    }
  }
  // fingers from the hand model, each hand matched to the nearer pose wrist
  for (const hand of det.hands) {
    const w = hand.norm[0], dl = Math.hypot(w.x - det.norm[15].x, w.y - det.norm[15].y), dr = Math.hypot(w.x - det.norm[16].x, w.y - det.norm[16].y);
    let s = dl < dr ? 'Left' : 'Right'; if (mirror) s = s === 'Left' ? 'Right' : 'Left';
    curls(rig, s, hand.world.map(toChar));
  }
  rig.root.updateMatrixWorld(true);
  ground(rig);
  return snapshot(rig);
}
// the hand bone's small rest tilt relative to a clean basis (so an unchanged hand stays as it was built)
function restHandTwist(rig, s) {
  const b = rig.bones[`${s}Hand`], saved = b.quaternion.clone();
  b.quaternion.copy(rig.rest[`${s}Hand`]);
  const q = rootQ(rig, b), y = UP.clone().applyQuaternion(q), z = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  const clean = basis(y, z), twist = clean.invert().multiply(q);
  b.quaternion.copy(saved);
  return twist;
}
// finger curls (angle between consecutive finger segments), bent toward the palm
function curls(rig, s, H) {
  const ang = (a, b, c, d) => H[b].clone().sub(H[a]).angleTo(H[d].clone().sub(H[c]));
  const sign = s === 'Left' ? -1 : 1; // palms face down in the T-pose: curling turns +Y toward the palm side
  const bend = (name, a) => { const b = rig.bones[name]; if (b) b.quaternion.copy(rig.rest[name]).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), sign * Math.min(1.7, a))); };
  [['Index', 5, 6, 7, 8], ['Middle', 9, 10, 11, 12], ['Ring', 13, 14, 15, 16], ['Pinky', 17, 18, 19, 20]].forEach(([f, m, p, d, t]) => {
    bend(`${s}Hand${f}1`, ang(0, m, m, p)); bend(`${s}Hand${f}2`, ang(m, p, p, d)); bend(`${s}Hand${f}3`, ang(p, d, d, t));
  });
  bend(`${s}HandThumb2`, ang(1, 2, 2, 3) * 0.8); bend(`${s}HandThumb3`, ang(2, 3, 3, 4) * 0.8);
}

// ---------------- IK for the drag handles ----------------
export const HANDLES = { LeftHand: ['LeftArm', 'LeftForeArm'], RightHand: ['RightArm', 'RightForeArm'], LeftFoot: ['LeftUpLeg', 'LeftLeg'], RightFoot: ['RightUpLeg', 'RightLeg'], Head: null, Spine2: null, Hips: null };
export const handlePos = (rig, name) => rootPos(rig, rig.bones[name], new THREE.Vector3());

// two-bone IK: upper -> lower -> end reaches target T (Root space); the elbow/knee stays in its current bend plane
function twoBone(rig, upper, lower, end, T, poleHint = null) { // poleHint: a Root-space direction the elbow / knee bends toward
  const A = rootPos(rig, rig.bones[upper]), B = rootPos(rig, rig.bones[lower]), C = rootPos(rig, rig.bones[end]);
  const l1 = A.distanceTo(B), l2 = B.distanceTo(C), toT = T.clone().sub(A);
  const d = Math.min(Math.max(toT.length(), Math.abs(l1 - l2) + 1e-4), (l1 + l2) * 0.999);
  const dir = toT.normalize();
  let pole = (poleHint ? poleHint.clone() : B.clone().sub(A)); pole.addScaledVector(dir, -pole.dot(dir)); // current bend direction (or the hint)
  if (pole.lengthSq() < 1e-8) pole = new THREE.Vector3(0, 0, upper.includes('Leg') ? 1 : -1).addScaledVector(dir, -dir.z); // straight limb: knees forward, elbows back
  pole.normalize();
  const a = Math.acos(Math.min(1, Math.max(-1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d))));
  const elbow = A.clone().addScaledVector(dir, Math.cos(a) * l1).addScaledVector(pole, Math.sin(a) * l1);
  aim(rig, upper, elbow.clone().sub(A)); rig.root.updateMatrixWorld(true);
  aim(rig, lower, A.clone().addScaledVector(dir, d).sub(elbow)); rig.root.updateMatrixWorld(true);
}
// drag a handle to a Root-space target; ctx carries what was captured when the drag started
export function dragHandle(rig, name, T, ctx) {
  rig.root.updateMatrixWorld(true);
  const endQ = rig.bones[name] && rootQ(rig, rig.bones[name]);
  if (HANDLES[name]) {
    twoBone(rig, ...HANDLES[name], name, T, ctx?.poles?.[name]);
    if (name.endsWith('Foot')) setRootQ(rig, name, ctx.footQ?.[name] || endQ); // feet keep their angle to the ground
  } else if (name === 'Head') { // look toward the target: the neck takes a third
    const head = rig.bones.Head, P = rootPos(rig, head), chest = rootQ(rig, rig.bones.Spine2);
    const want = basis(new THREE.Vector3(0, 1, 0).applyQuaternion(chest), T.clone().sub(P)); // upright-ish, facing the target
    const rel = chest.clone().invert().multiply(want), n = new THREE.Quaternion().slerp(rel, 0.35);
    rig.bones.Neck.quaternion.copy(n); head.quaternion.copy(n.clone().invert().multiply(rel));
  } else if (name === 'Spine2') { // bend: the chest leans toward the target, spread over three spine bones
    const base = rootPos(rig, rig.bones.Spine), cur = rootPos(rig, rig.bones.Spine2).sub(base), want = T.clone().sub(base);
    const step = new THREE.Quaternion().setFromUnitVectors(cur.normalize(), want.normalize());
    const part = new THREE.Quaternion().slerp(step, 1 / 3);
    for (const n of ['Spine', 'Spine1', 'Spine2']) { setRootQ(rig, n, part.clone().multiply(rootQ(rig, rig.bones[n]))); rig.root.updateMatrixWorld(true); }
  } else if (name === 'Hips') { // move the hips (crouch, lean), the feet stay where they were
    const H = ctx.hips0.clone().add(T.clone().sub(ctx.handle0).divideScalar(rig.skelRoot.scale.y || 1));
    // the body can't leave its feet: each leg's root stays within that leg's reach of its planted foot,
    // and the hips stay above the feet (no sinking into the ground)
    for (let k = 0; k < 3; k++) for (const s of ['Left', 'Right']) {
      const root = H.clone().add(ctx.legOff[s]), f = ctx.feet[s], d = root.distanceTo(f), max = ctx.reach[s] * 0.985;
      if (d > max) H.add(f.clone().add(root.sub(f).multiplyScalar(max / d)).sub(H.clone().add(ctx.legOff[s])));
    }
    H.y = Math.max(H.y, Math.min(ctx.feet.Left.y, ctx.feet.Right.y) + ctx.reach.Left * 0.25); // above the lower foot (a raised leg may go higher)
    rig.bones.Hips.position.copy(H);
    rig.root.updateMatrixWorld(true);
    for (const s of ['Left', 'Right']) { twoBone(rig, `${s}UpLeg`, `${s}Leg`, `${s}Foot`, ctx.feet[s]); setRootQ(rig, `${s}Foot`, ctx.footQ[`${s}Foot`]); rig.root.updateMatrixWorld(true); }
  }
  rig.root.updateMatrixWorld(true);
}
export function dragStart(rig) {
  rig.root.updateMatrixWorld(true);
  const hipsAt = rootPos(rig, rig.bones.Hips), leg = (s) => rootPos(rig, rig.bones[`${s}UpLeg`]);
  const reach = (s) => leg(s).distanceTo(rootPos(rig, rig.bones[`${s}Leg`])) + rootPos(rig, rig.bones[`${s}Leg`]).distanceTo(rootPos(rig, rig.bones[`${s}Foot`]));
  return {
    legOff: { Left: leg('Left').sub(hipsAt), Right: leg('Right').sub(hipsAt) },
    reach: { Left: reach('Left'), Right: reach('Right') },
    hips0: rig.bones.Hips.position.clone(),
    feet: { Left: rootPos(rig, rig.bones.LeftFoot), Right: rootPos(rig, rig.bones.RightFoot) },
    footQ: { LeftFoot: rootQ(rig, rig.bones.LeftFoot), RightFoot: rootQ(rig, rig.bones.RightFoot) },
  };
}
// Root space <-> world
export const toRoot = (rig, p) => { rig.skelRoot.updateMatrixWorld(true); return p.clone().applyMatrix4(_m.copy(rig.skelRoot.matrixWorld).invert()); };
export const toWorld = (rig, p) => p.clone().applyMatrix4(rig.skelRoot.matrixWorld);

// ---------------- breathing on top of a still pose ----------------
const BREATH = [['Spine1', 0.018, 0], ['Spine2', 0.022, 0.3], ['Neck', -0.015, 0.5], ['Head', -0.01, 0.7], ['LeftShoulder', 0.012, 0.2], ['RightShoulder', -0.012, 0.2]];
export function breathe(rig, t, phase = 0) {
  const s = Math.sin((t + phase) * 1.35); // ~ a breath every 4.6 s
  for (const [n, amp, lag] of BREATH) {
    const b = rig.bones[n]; if (!b) continue;
    const axis = n.includes('Shoulder') ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(1, 0, 0);
    b.quaternion.multiply(_q.setFromAxisAngle(axis, amp * Math.sin((t + phase) * 1.35 - lag) * (n.includes('Shoulder') ? 1 : -1))).normalize();
  }
  return s;
}

// ---------------- sitting ----------------
// a plain sitting pose: thighs forward, shins down, feet flat, forearms resting on the lap, a slight slump.
// Returns the pose; hipsAt(rig) then gives where the hips ended up (the seat anchor goes there).
export function sitPose(rig) {
  resetRest(rig);
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  rig.bones.Spine?.quaternion.multiply(_q.setFromAxisAngle(V(1, 0, 0), 0.12)).normalize(); // slump
  rig.bones.Neck?.quaternion.multiply(_q.setFromAxisAngle(V(1, 0, 0), 0.1)).normalize();
  for (const s of ['Left', 'Right']) {
    const x = s === 'Left' ? 1 : -1; // Left bones sit on the character's +x side
    aim(rig, `${s}UpLeg`, V(0.07 * x, -0.1, 1));
    aim(rig, `${s}Leg`, V(0.02 * x, -1, 0.1));
    aim(rig, `${s}Foot`, V(0, -0.4, 1));
    aim(rig, `${s}Arm`, V(0.22 * x, -0.9, 0.38));
    aim(rig, `${s}ForeArm`, V(-0.08 * x, -0.3, 1));
  }
  rig.root.updateMatrixWorld(true);
  return snapshot(rig);
}
// the hips joint in the character root's own space (unscaled), for the current bones
export function hipsAt(rig) { rig.root.updateMatrixWorld(true); return rig.root.worldToLocal(rig.bones.Hips.getWorldPosition(new THREE.Vector3())); }

// ---------------- directed poses: a preset plus targets, compiled with the IK ----------------
// spec = { preset: 'stand' | 'sit' | 'crouch' | 'kneel' | 'arms-up' | 'reach' | 't-pose',
//          look: [x,y,z] (world),  leftHand / rightHand / leftFoot / rightFoot: [x,y,z] (world),  hipsDown: metres }
// Targets arrive already resolved to world points (the editor resolves names like "rocking-chair" or "camera").
export const PRESETS = ['stand', 'sit', 'crouch', 'kneel', 'arms-up', 'reach', 't-pose'];
function standPose(rig) {
  resetRest(rig);
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  for (const s of ['Left', 'Right']) {
    const x = s === 'Left' ? 1 : -1; // Left bones sit on the character's +x side
    aim(rig, `${s}Arm`, V(0.14 * x, -1, 0.04));
    aim(rig, `${s}ForeArm`, V(0.05 * x, -1, 0.14));
  }
  rig.root.updateMatrixWorld(true);
}
function presetPose(rig, name) {
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  if (name === 't-pose') { resetRest(rig); return; }
  if (name === 'sit') { sitPose(rig); return; }
  standPose(rig);
  if (name === 'arms-up') for (const s of ['Left', 'Right']) { const x = s === 'Left' ? 1 : -1; aim(rig, `${s}Arm`, V(0.25 * x, 1, 0.1)); aim(rig, `${s}ForeArm`, V(0.1 * x, 1, 0.05)); }
  if (name === 'reach') { aim(rig, 'RightArm', V(-0.12, 0.05, 1)); aim(rig, 'RightForeArm', V(-0.05, 0.08, 1)); }
  if (name === 'crouch' || name === 'kneel') {
    const ctx = dragStart(rig), h0 = handlePos(rig, 'Hips');
    const legLen = ctx.reach.Left;
    if (name === 'crouch') {
      dragHandle(rig, 'Hips', h0.clone().add(V(0, -legLen * 0.38, -legLen * 0.08)), { ...ctx, handle0: h0 });
      for (const n of ['Spine', 'Spine1']) rig.bones[n].quaternion.multiply(_q.setFromAxisAngle(V(1, 0, 0), 0.18)).normalize(); // lean in
    } else { // kneeling on the left knee, the right foot planted forward
      rig.bones.Hips.position.y -= legLen * 0.42 / (rig.skelRoot.scale.y || 1);
      rig.root.updateMatrixWorld(true);
      aim(rig, 'RightUpLeg', V(-0.05, -0.2, 1)); aim(rig, 'RightLeg', V(0, -1, 0.02)); aim(rig, 'RightFoot', V(0, -0.35, 1));
      aim(rig, 'LeftUpLeg', V(0.05, -1, 0.15)); aim(rig, 'LeftLeg', V(0, -0.1, -1)); aim(rig, 'LeftFoot', V(0, -0.2, -1));
      rig.root.updateMatrixWorld(true); ground(rig);
    }
  }
  rig.root.updateMatrixWorld(true);
}
// hand shapes: curl of each finger's three joints toward the palm (radians); point: the index stays straight
const GRIPS = {
  fist: { Index: [1.4, 1.5, 1.1], Middle: [1.4, 1.5, 1.1], Ring: [1.4, 1.5, 1.1], Pinky: [1.4, 1.5, 1.1], Thumb: [0.3, 0.7, 0.6] },
  point: { Index: [0.05, 0.05, 0], Middle: [1.4, 1.5, 1.1], Ring: [1.5, 1.5, 1.1], Pinky: [1.5, 1.5, 1.1], Thumb: [0.4, 0.8, 0.6] },
  claw: { Index: [-0.2, 1.1, 0.9], Middle: [-0.2, 1.1, 0.9], Ring: [-0.2, 1.1, 0.9], Pinky: [-0.2, 1.1, 0.9], Thumb: [0.2, 0.5, 0.5] },
  pinch: { Index: [0.55, 0.95, 0.55], Middle: [1.25, 1.35, 0.9], Ring: [1.35, 1.4, 0.9], Pinky: [1.45, 1.4, 0.9], Thumb: [0.55, 0.75, 0.45] }, // (thumb and index meeting: the hold point is between their tips)
  hook: { Index: [1.4, 1.35, 0.9], Middle: [1.42, 1.4, 0.9], Ring: [1.45, 1.4, 0.9], Pinky: [1.5, 1.4, 0.9], Thumb: [0.3, 0.55, 0.4] }, // (carrying: fingers wrapped round a handle with its room inside, looser than a fist)
};
export const GRIP_SIGN = { Left: -1 }; // (measured in the T-pose: the left fingers curl toward the palm about -z; the right hand mirrors it, see curlAxis)
// a bone's rest rotation in Root space (the rest quaternions chained up to Root)
function restRootQ(rig, bone) {
  const q = new THREE.Quaternion();
  for (let b = bone; b && b !== rig.skelRoot; b = b.parent) if (b.isBone) q.premultiply(rig.rest[b.name] || b.quaternion);
  return q;
}
// The left hand curls about each finger's local z (measured, see GRIP_SIGN). The right hand's fingers curl about
// the mirror image of that axis (reflected through the body's middle plane; an axis flips y and z), brought into
// the right finger's own frame: the right hand is always the exact mirror of the left, whatever the bones' axes.
export function curlAxis(rig, side, name) {
  const z = new THREE.Vector3(0, 0, 1);
  if (side === 'Left') return z;
  const L = rig.bones[name.replace('Right', 'Left')], R = rig.bones[name]; if (!L) return z;
  const a = z.clone().applyQuaternion(restRootQ(rig, L)); a.set(a.x, -a.y, -a.z);
  return a.applyQuaternion(restRootQ(rig, R).invert()).normalize();
}
function grip(rig, side, name) {
  const g = GRIPS[name]; if (!g) return;
  for (const [f, curl] of Object.entries(g)) curl.forEach((a, i) => {
    const b = rig.bones[`${side}Hand${f}${i + 1}`]; if (!b) return;
    b.quaternion.copy(rig.rest[b.name]).multiply(_q.setFromAxisAngle(curlAxis(rig, side, b.name), a * GRIP_SIGN.Left * CURL.k)).normalize();
  });
  rig.root.updateMatrixWorld(true);
}
export const CURL = { k: 1 };
// compile a spec to a stored pose ({ bones, hips }); world targets need the character already placed in the scene
export function compilePose(rig, spec) {
  presetPose(rig, spec.preset || 'stand');
  if (spec.hipsDown) {
    const ctx = dragStart(rig), h0 = handlePos(rig, 'Hips');
    dragHandle(rig, 'Hips', h0.clone().add(new THREE.Vector3(0, -spec.hipsDown / (rig.root.scale.y || 1), 0)), { ...ctx, handle0: h0 });
  }
  // bow: the back curls forward (radians, spread down the spine, most of it high in the back), knees giving a little
  if (spec.bow) {
    // from the hips up (the hips-to-waist segment is the longest: left straight, the arch was an L), the legs
    // held where they were; then even down the spine: an inverted U, the head coming down in front
    const b = spec.bow, share = { Spine: 0.2, Spine1: 0.2, Spine2: 0.15, Neck: 0.15 }, legs = ['LeftUpLeg', 'RightUpLeg'].map((n) => [n, rootQ(rig, rig.bones[n])]);
    rig.bones.Hips.quaternion.multiply(_q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), b * 0.3)).normalize(); rig.root.updateMatrixWorld(true);
    for (const [n, q] of legs) setRootQ(rig, n, q);
    rig.root.updateMatrixWorld(true);
    for (const [n, k] of Object.entries(share)) rig.bones[n]?.quaternion.multiply(_q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), b * k)).normalize();
    rig.root.updateMatrixWorld(true);
  }
  const ctx = { ...dragStart(rig) };
  for (const [key, bone] of [['leftHand', 'LeftHand'], ['rightHand', 'RightHand'], ['leftFoot', 'LeftFoot'], ['rightFoot', 'RightFoot']]) {
    if (!Array.isArray(spec[key])) continue;
    // an elbow (knee) target: the upper limb aims at it first, so the IK bends that way (it keeps the current bend)
    const pole = spec[key.replace('Hand', 'Elbow').replace('Foot', 'Knee')];
    if (Array.isArray(pole)) { const up = HANDLES[bone][0]; aim(rig, up, toRoot(rig, new THREE.Vector3(...pole)).sub(rootPos(rig, rig.bones[up]))); rig.root.updateMatrixWorld(true); }
    dragHandle(rig, bone, toRoot(rig, new THREE.Vector3(...spec[key])), ctx);
  }
  if (Array.isArray(spec.look)) dragHandle(rig, 'Head', toRoot(rig, new THREE.Vector3(...spec.look)), ctx);
  // a hand can aim at a point (the wrist bends: fingers toward it), then take its grip
  for (const side of ['Left', 'Right']) { const t = spec[`${side.toLowerCase()}Aim`]; if (Array.isArray(t)) { const h = rig.bones[`${side}Hand`]; aim(rig, `${side}Hand`, toRoot(rig, new THREE.Vector3(...t)).sub(rootPos(rig, h))); rig.root.updateMatrixWorld(true); } }
  for (const side of ['Left', 'Right']) if (spec[`${side.toLowerCase()}Grip`]) grip(rig, side, spec[`${side.toLowerCase()}Grip`]);
  // palm down: roll the hand about its own axis until its curled fingers hook downward (measured, not guessed:
  // the hand from above, fingers over a handle, like carrying a bag)
  for (const side of ['Left', 'Right']) if (spec[`${side.toLowerCase()}PalmDown`]) {
    const hand = rig.bones[`${side}Hand`], P = (n) => rootPos(rig, rig.bones[n]);
    const axis = P(`${side}HandMiddle1`).sub(P(`${side}Hand`)).normalize();
    const curl = P(`${side}HandMiddle3`).sub(P(`${side}HandMiddle1`)); curl.addScaledVector(axis, -curl.dot(axis));
    const down = new THREE.Vector3(0, -1, 0); down.addScaledVector(axis, -down.dot(axis));
    if (curl.lengthSq() < 1e-8 || down.lengthSq() < 1e-8) continue;
    curl.normalize(); down.normalize();
    const ang = Math.atan2(axis.dot(curl.clone().cross(down)), curl.dot(down));
    setRootQ(rig, `${side}Hand`, new THREE.Quaternion().setFromAxisAngle(axis, ang).multiply(rootQ(rig, hand)));
    rig.root.updateMatrixWorld(true);
  }
  rig.root.updateMatrixWorld(true);
  return snapshot(rig);
}

// curl one hand's fingers on top of what they're doing: amounts per joint ([base, mid, tip] radians, toward
// the palm; negative splays), the right hand mirrored exactly like the grips
export function curlFingers(rig, side, fingers) {
  for (const [f, c] of Object.entries(fingers)) c.forEach((a, i) => {
    const b = rig.bones[`${side}Hand${f}${i + 1}`]; if (!b || !a) return;
    b.quaternion.multiply(_q.setFromAxisAngle(curlAxis(rig, side, b.name), a * GRIP_SIGN.Left)).normalize();
  });
}
