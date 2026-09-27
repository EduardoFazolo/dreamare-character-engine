// EXPERIMENTAL: drive the character from the webcam with MediaPipe (face, upper-body pose, hands).
// Mode 'chest': head rotation + face expressions (the face morph targets), chest twist/tilt, arms, wrists
// and finger curls. 'full' (legs) is not implemented yet.
//
// How: each video frame poses the internal driver rig (the same one the baked clips come from), then
// converts it to bone rotations exactly like clip baking does (joint model rotation * bind offset, made
// local to the parent bone), so arms, head and fingers use the rig's real bone axes. It is a true mirror:
// the character is your reflection (you raise your left hand, its right hand, on the same side of the
// screen as yours in the mirrored preview, goes up); sides, eye looks and head turns are reflected.
import * as THREE from 'three';
import { FilesetResolver, FaceLandmarker, PoseLandmarker, HandLandmarker } from '@mediapipe/tasks-vision';
import { METERS } from '../src/rig.js';
import { SCHEMA } from '../src/mutate.js';

const SMOOTH = 0.55; // per-frame blend of the joints toward the (already filtered) tracked pose

// One Euro filter (Casiez et al. 2012): a low-pass whose cutoff rises with speed, so it is very smooth
// when you're nearly still (no jitter) and still follows fast moves without lag.
class OneEuro {
  constructor(minCutoff = 1.0, beta = 0.6, dCutoff = 1.0) { Object.assign(this, { minCutoff, beta, dCutoff, x: null, dx: 0, t: 0 }); }
  filter(v, t) {
    if (this.x === null) { this.x = v; this.t = t; return v; }
    const dt = Math.max(1e-3, t - this.t), a = (c) => 1 / (1 + 1 / (2 * Math.PI * c * dt));
    this.t = t;
    const dx = (v - this.x) / dt;
    this.dx += a(this.dCutoff) * (dx - this.dx);
    this.x += a(this.minCutoff + this.beta * Math.abs(this.dx)) * (v - this.x);
    return this.x;
  }
}
// a bank of filters addressed by key (one per landmark coordinate, blendshape, quaternion component)
class Filters {
  constructor() { this.m = new Map(); }
  f(key, v, t, minCutoff, beta) { let o = this.m.get(key); if (!o) this.m.set(key, (o = new OneEuro(minCutoff, beta))); return o.filter(v, t); }
  points(key, list, t, minCutoff = 1.2, beta = 0.8) { return list.map((l, i) => ({ ...l, x: this.f(`${key}${i}x`, l.x, t, minCutoff, beta), y: this.f(`${key}${i}y`, l.y, t, minCutoff, beta), z: this.f(`${key}${i}z`, l.z, t, minCutoff, beta) })); }
}

export function mount(app) {
  const ui = document.createElement('div');
  ui.className = 'experimental';
  ui.innerHTML = `<div style="margin-top:8px;padding:6px;border:1px dashed #666">
    <b style="font-size:11px">EXPERIMENTAL · webcam</b><br>
    <select id="camMode" style="margin:4px 0">
      <option value="chest">chest and above</option>
      <option value="full" disabled>full body (soon)</option>
    </select>
    <button id="camToggle">Start webcam</button>
    <label style="display:block;font-size:11px;margin-top:4px">expression strength <span id="camGainV">1.8</span>
      <input id="camGain" type="range" min="0.5" max="3" step="0.1" value="1.8" style="width:100%"></label>
    <div id="camStatus" style="font-size:11px;opacity:.7"></div></div>`;
  document.querySelector('#panel .buttons').after(ui);
  const status = (t) => { ui.querySelector('#camStatus').textContent = t; };
  const gain = ui.querySelector('#camGain');
  app.camGain = +gain.value;
  gain.oninput = () => { app.camGain = +gain.value; ui.querySelector('#camGainV').textContent = gain.value; };
  let live = null;
  ui.querySelector('#camToggle').onclick = async () => {
    const btn = ui.querySelector('#camToggle');
    if (live) { live.stop(); live = null; btn.textContent = 'Start webcam'; status(''); return; }
    btn.disabled = true;
    try {
      live = await start(app, ui.querySelector('#camMode').value, status);
      btn.textContent = 'Stop webcam';
    } catch (e) { status('webcam failed: ' + e.message); live = null; }
    btn.disabled = false;
  };
}

async function start(app, mode, status) {
  status('loading trackers…');
  const fileset = await FilesetResolver.forVisionTasks('/wasm');
  const opts = (path) => ({ baseOptions: { modelAssetPath: path, delegate: 'GPU' }, runningMode: 'VIDEO' });
  const [face, pose, hands] = await Promise.all([
    FaceLandmarker.createFromOptions(fileset, { ...opts('/models/face_landmarker.task'), numFaces: 1, outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true }),
    PoseLandmarker.createFromOptions(fileset, { ...opts('/models/pose_landmarker_lite.task'), numPoses: 1 }),
    HandLandmarker.createFromOptions(fileset, { ...opts('/models/hand_landmarker.task'), numHands: 2 }),
  ]);
  status('starting camera…');
  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: false });
  const video = document.createElement('video');
  Object.assign(video, { srcObject: stream, muted: true, playsInline: true });
  Object.assign(video.style, { position: 'fixed', right: '12px', bottom: '12px', width: '200px', transform: 'scaleX(-1)', border: '1px solid #444', zIndex: 50 });
  document.body.appendChild(video);
  await video.play();
  status(`live (${mode === 'chest' ? 'chest and above' : mode})`);
  app.setYaw(0); // face the camera
  app.camLive = true; // and no idle sway while live (a mirror shouldn't rotate); see main.js
  // neutral face while live: the face warps (grin, mouth, eyes, nose...) and the painted teeth fight the
  // tracked expressions (a painted grin can't close); the character's own values come back on stop
  const neutralKeys = [...SCHEMA.find((g) => g.group === 'Face mutations').items.map((i) => i[0]), 'teeth'];
  const neutral = Object.fromEntries(neutralKeys.map((k) => [k, SCHEMA.flatMap((g) => g.items).find((i) => i[0] === k)[4]]));
  const saved = Object.fromEntries(neutralKeys.map((k) => [k, app.params[k]]));
  app.params = { ...app.params, ...neutral };

  const smooth = new Map(), morphs = {}, filt = new Filters();
  let stopped = false, lastTime = -1;
  const loop = () => {
    if (stopped) return;
    requestAnimationFrame(loop);
    if (video.currentTime === lastTime || video.readyState < 2) return;
    lastTime = video.currentTime;
    const now = performance.now();
    const f = face.detectForVideo(video, now), p = pose.detectForVideo(video, now), h = hands.detectForVideo(video, now);
    // filter every input before it drives anything
    const t = now / 1000;
    if (p.worldLandmarks?.[0]) p.worldLandmarks[0] = filt.points('pw', p.worldLandmarks[0], t);
    (h.worldLandmarks || []).forEach((w, k) => {
      const side = (h.landmarks[k][0].x > 0.5) ? 'r' : 'l'; // (keyed by screen half: stable per hand)
      h.worldLandmarks[k] = filt.points('h' + side, w, t, 1.5, 1.2);
    });
    const M = f.facialTransformationMatrixes?.[0];
    if (M) {
      const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().fromArray(M.data));
      if (filt.lastQ && filt.lastQ.dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w); // keep the same hemisphere
      const c = ['x', 'y', 'z', 'w'].map((k) => filt.f('fq' + k, q[k], t, 0.8, 0.5));
      q.set(...c).normalize(); filt.lastQ = q.clone();
      f.headQ = q;
    }
    for (const c of f.faceBlendshapes?.[0]?.categories || []) c.score = filt.f('bs' + c.categoryName, c.score, t, 1.5, 1.5);
    apply(app, { f, p, h }, smooth, morphs);
  };
  loop();
  return {
    stop() {
      stopped = true;
      stream.getTracks().forEach((t) => t.stop());
      video.remove();
      face.close(); pose.close(); hands.close();
      app.camLive = false;
      app.sk.mesh?.morphTargetInfluences?.fill(0);
      app.params = { ...app.params, ...saved }; // the character's own face (rebuilds, then plays its animation)
      app.sk.play(app.params.anim); // back to the character's animation
    },
  };
}

// ---------------------------------------------------------------------------------------------------
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _v = new THREE.Vector3(), _s = new THREE.Vector3(), _m = new THREE.Matrix4();
const DOWN = new THREE.Vector3(0, -1, 0);
// MediaPipe world coordinates (x right in the image, y down, z away from the camera) -> character space
// (+x its left, +y up, +z toward the camera), reflected: your left side (image right) becomes its right
const toChar = (l) => new THREE.Vector3(-l.x, -l.y, -l.z);

function apply(app, { f, p, h }, smooth, morphs) {
  const { body, sk, params } = app;
  if (!sk.mesh || !sk.defs) return;
  sk.mixer?.stopAllAction();
  const j = body.j;
  const yaw = body.root.rotation.y;
  body.root.rotation.y = 0;
  // neutral base: the plain standing pose (no hunch), whatever pose the character had, then the tracking
  // on top; standing on the ground (snapped once per character build: a full scan is too slow per frame)
  const base = { ...params, hunch: 0 };
  body.pose(base, 'stand');
  if (smooth.snapFor !== sk.mesh) { body.snap(); smooth.snapFor = sk.mesh; smooth.snapY = body.parts.position.y; smooth.clear(); }
  body.parts.position.y = smooth.snapY;
  body.root.updateMatrixWorld(true);
  if (smooth.reframe !== sk.mesh) { // re-frame the camera for the standing body (it was framed for the old pose)
    smooth.reframe = sk.mesh;
    document.querySelector('#view')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  }

  // blend each driven joint toward its target (in its parent's frame), applied top-down
  const touched = new Set();
  const set = (name, qLocal) => {
    touched.add(name);
    const cur = smooth.get(name) || j[name].quaternion.clone();
    cur.slerp(qLocal, SMOOTH);
    smooth.set(name, cur);
    j[name].quaternion.copy(cur);
    j[name].updateMatrixWorld(true);
  };
  // rotate a joint so its limb axis (local -Y) points along world direction d (minimal rotation)
  const aim = (name, d) => {
    const jt = j[name];
    jt.getWorldQuaternion(_q);
    const cur = DOWN.clone().applyQuaternion(_q);
    _q2.setFromUnitVectors(cur, d.clone().normalize()).multiply(_q);
    const parentQ = jt.parent.getWorldQuaternion(new THREE.Quaternion());
    set(name, parentQ.invert().multiply(_q2));
  };

  // ---- chest: shoulder line twist and tilt ----
  const W = p.worldLandmarks?.[0], N = p.landmarks?.[0];
  const vis = (i) => N && N[i].visibility > 0.5;
  if (W && vis(11) && vis(12)) {
    const s = toChar(W[12]).sub(toChar(W[11])); // character left (your right, 12) minus character right
    const twist = Math.atan2(-s.z, s.x), tilt = Math.atan2(s.y, s.x);
    set('waist', j.waist.quaternion.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, twist * 0.8, tilt * 0.8))));
    // ---- arms: shoulder -> elbow -> wrist (mirror: your left = 11/13/15 drives the character's right, A) ----
    for (const [side, sh, el, wr] of [['A', 11, 13, 15], ['B', 12, 14, 16]]) {
      if (!vis(el) || !vis(wr)) continue;
      aim('shoulder' + side, toChar(W[el]).sub(toChar(W[sh])));
      aim('elbow' + side, toChar(W[wr]).sub(toChar(W[el])));
    }
  }

  // ---- hands: wrist direction and finger curls; each hand goes to the nearest pose wrist ----
  (h.landmarks || []).forEach((lm, k) => {
    const hw = h.worldLandmarks?.[k];
    if (!hw) return;
    // (your left hand, nearest your left wrist 15 / image right, drives the character's right hand, A)
    let side = lm[0].x > 0.5 ? 'A' : 'B';
    if (N) side = Math.hypot(lm[0].x - N[15].x, lm[0].y - N[15].y) < Math.hypot(lm[0].x - N[16].x, lm[0].y - N[16].y) ? 'A' : 'B';
    // the whole hand frame, not just its direction (without the twist the palm faced anywhere and the
    // finger curls bent sideways): fingers run along the wrist joint's -Y, the index->pinky knuckles along
    // its +x on A (character right) and -x on B, the palm faces +Z
    {
      const H = hw.map(toChar), fwd = H[9].clone().sub(H[0]).normalize(), across = H[17].clone().sub(H[5]);
      const x = across.addScaledVector(fwd, -across.dot(fwd)).normalize().multiplyScalar(side === 'B' ? -1 : 1);
      const y = fwd.clone().negate(), z = new THREE.Vector3().crossVectors(x, y).normalize();
      const worldQ = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
      const parentQ = j['wrist' + side].parent.getWorldQuaternion(new THREE.Quaternion());
      set('wrist' + side, parentQ.invert().multiply(worldQ));
    }
    const P = hw.map(toChar), ang = (a, b, c, d) => P[b].clone().sub(P[a]).angleTo(P[d].clone().sub(P[c]));
    // index -> pinky: driver finger joints (the index sits next to the thumb: finger3 on B, finger0 on A)
    const order = side === 'B' ? [3, 2, 1, 0] : [0, 1, 2, 3];
    [[5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]].forEach(([m, pp, d, t], fi) => {
      const n = `finger${side}${order[fi]}`;
      if (!j[n] || !j[n + 'm']) return;
      const c0 = ang(0, m, m, pp), c1 = ang(m, pp, pp, d), c2 = ang(pp, d, d, t);
      const spread = (order[fi] - 1.5) * 0.11;
      set(n, new THREE.Quaternion().setFromEuler(new THREE.Euler(-c0, 0, spread)));
      set(n + 'm', new THREE.Quaternion().setFromEuler(new THREE.Euler(-c1, 0, 0)));
      set(n + 't', new THREE.Quaternion().setFromEuler(new THREE.Euler(-c2, 0, 0)));
    });
    if (j['thumb' + side + 'm']) {
      set('thumb' + side + 'm', new THREE.Quaternion().setFromEuler(new THREE.Euler(-ang(1, 2, 2, 3), 0, 0)));
      set('thumb' + side + 't', new THREE.Quaternion().setFromEuler(new THREE.Euler(-ang(2, 3, 3, 4), 0, 0)));
    }
  });

  // ---- head: the face's rotation, split between neck (35%) and head ----
  if (f.headQ) {
    const q = new THREE.Quaternion(f.headQ.x, -f.headQ.y, -f.headQ.z, f.headQ.w); // reflected (turn and tilt swap)
    const qn = new THREE.Quaternion().slerp(q, 0.35), qh = new THREE.Quaternion().slerp(q, 0.65);
    set('neck', j.neck.quaternion.clone().multiply(qn));
    set('head', qh);
  }

  // joints that lost tracking this frame ease back to the pose instead of snapping
  for (const [name, cur] of smooth) {
    if (touched.has(name)) continue;
    cur.slerp(j[name].quaternion, 0.15);
    j[name].quaternion.copy(cur);
  }
  body.root.updateMatrixWorld(true);

  // ---- driver -> bones, exactly like clip baking ----
  const rootInv = new THREE.Matrix4().copy(body.root.matrixWorld).invert();
  const world = { Root: new THREE.Quaternion() };
  for (const [n, parent, joint] of sk.defs) {
    if (!joint || !j[joint]) continue;
    _m.multiplyMatrices(rootInv, j[joint].matrixWorld).decompose(_v, _q, _s);
    world[n] = _q.clone().multiply(sk.offset[n]);
    const bone = sk.bones[n];
    if (!bone || !world[parent]) continue;
    bone.quaternion.copy(world[parent].clone().invert().multiply(world[n]));
    if (n === 'Hips') bone.position.copy(_v).multiplyScalar(METERS);
  }
  body.root.rotation.y = yaw;
  body.root.updateMatrixWorld(true);

  // ---- face expressions -> face morph targets ----
  const bs = Object.fromEntries((f.faceBlendshapes?.[0]?.categories || []).map((c) => [c.categoryName, c.score]));
  if (Object.keys(bs).length && sk.mesh.morphTargetDictionary) {
    // Each channel mapped from its real range: MediaPipe scores rarely reach 1 (a big smile or brow raise
    // often peaks near 0.5-0.7) and idle at a small noise floor. [dead zone, typical peak] -> 0..1, then the
    // expression strength on top; morph weights past 1 extrapolate the shape (capped at MAX_W).
    const G = app.camGain ?? 1.8, MAX_W = 1.8;
    const avg = (a, b) => ((bs[a] || 0) + (bs[b] || 0)) / 2;
    const map = (v, dead, peak) => Math.min(MAX_W, Math.max(0, (v - dead) / (peak - dead)) * G);
    const target = {
      jawOpen: map(bs.jawOpen || 0, 0.04, 0.6),
      mouthSmile: map(avg('mouthSmileLeft', 'mouthSmileRight'), 0.05, 0.7),
      mouthPucker: map(bs.mouthPucker || 0, 0.08, 0.7),
      mouthWide: map(Math.max(avg('mouthStretchLeft', 'mouthStretchRight'), avg('mouthUpperUpLeft', 'mouthUpperUpRight') * 0.8), 0.04, 0.45),
      // mirrored: your left eye is the reflection's right eye (blinks stay within 0..1: a lid can't close twice)
      eyeBlinkLeft: Math.min(1, map(bs.eyeBlinkRight || 0, 0.15, 0.7)),
      eyeBlinkRight: Math.min(1, map(bs.eyeBlinkLeft || 0, 0.15, 0.7)),
      eyeLookUp: map(avg('eyeLookUpLeft', 'eyeLookUpRight'), 0.05, 0.5),
      eyeLookDown: map(avg('eyeLookDownLeft', 'eyeLookDownRight'), 0.1, 0.6),
      eyeLookLeft: map(avg('eyeLookInLeft', 'eyeLookOutRight'), 0.05, 0.6),
      eyeLookRight: map(avg('eyeLookOutLeft', 'eyeLookInRight'), 0.05, 0.6),
      browUp: map(avg('browOuterUpLeft', 'browOuterUpRight'), 0.05, 0.55),
      browDown: map(avg('browDownLeft', 'browDownRight'), 0.05, 0.5),
      browInnerUp: map(bs.browInnerUp || 0, 0.08, 0.6),
    };
    const inf = sk.mesh.morphTargetInfluences, dict = sk.mesh.morphTargetDictionary;
    for (const [k, v] of Object.entries(target)) {
      if (dict[k] === undefined) continue;
      morphs[k] = (morphs[k] ?? v) + (v - (morphs[k] ?? v)) * 0.7; // (inputs are already filtered)
      inf[dict[k]] = morphs[k];
    }
  }
}
