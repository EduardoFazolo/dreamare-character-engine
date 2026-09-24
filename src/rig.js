import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MOTIONS } from './body.js';

// Bakes the driver rig (BodyRig joints + segment meshes) into an engine-friendly asset:
// one skeleton with Mixamo-style humanoid bone names, T-pose bind, meters, +Y up, facing +Z,
// rigid skinning (1 bone per vertex), and animation clips as bone quaternion tracks.

export const METERS = 0.16; // one head unit (face width) in meters

// [bone, parent, driver joint, position]
// position: undefined = the joint's own origin; otherwise f(pos) computing it from other bones
const lerp = (a, b, t) => a.clone().lerp(b, t);
const SIDES = [['Left', 'B'], ['Right', 'A']];
function boneDefs() {
  const d = [
    ['Hips', null, 'pelvis'],
    ['Spine', 'Hips', 'waist'],
    ['Spine1', 'Spine', 'waist', (P) => lerp(P.Spine, P.Neck, 0.33)],
    ['Spine2', 'Spine1', 'waist', (P) => lerp(P.Spine, P.Neck, 0.66)],
    ['Neck', 'Spine2', 'neck'],
    ['Head', 'Neck', 'head'],
  ];
  for (const [L, s] of SIDES) {
    // index finger sits on the thumb side: finger0 for B (+x), finger3 for A (-x)
    const fingers = s === 'B' ? ['Index', 'Middle', 'Ring', 'Pinky'] : ['Pinky', 'Ring', 'Middle', 'Index'];
    d.push(
      [`${L}Shoulder`, 'Spine2', 'waist', (P) => new THREE.Vector3(P[`${L}Arm`].x * 0.3, P[`${L}Arm`].y, P[`${L}Arm`].z)],
      [`${L}Arm`, `${L}Shoulder`, `shoulder${s}`],
      [`${L}ForeArm`, `${L}Arm`, `elbow${s}`],
      [`${L}Hand`, `${L}ForeArm`, `wrist${s}`],
      [`${L}HandThumb1`, `${L}Hand`, `thumb${s}`],
      ...fingers.map((f, i) => [`${L}Hand${f}1`, `${L}Hand`, `finger${s}${i}`]),
    );
  }
  for (const [L, s] of SIDES) {
    d.push(
      [`${L}UpLeg`, 'Hips', `hip${s}`],
      [`${L}Leg`, `${L}UpLeg`, `knee${s}`],
      [`${L}Foot`, `${L}Leg`, `ankle${s}`],
      [`${L}ToeBase`, `${L}Foot`, `ankle${s}`, (P) => P[`${L}Foot`].clone().add(new THREE.Vector3(0, -0.2, 0.55))],
    );
  }
  return d;
}

// which bone a bone should "point" at (its +Y axis), or a fixed model-space direction
const AIM = {
  Hips: 'Spine', Spine: 'Spine1', Spine1: 'Spine2', Spine2: 'Neck', Neck: 'Head', Head: [0, 1, 0],
  LeftShoulder: 'LeftArm', LeftArm: 'LeftForeArm', LeftForeArm: 'LeftHand', LeftHand: 'LeftHandMiddle1',
  RightShoulder: 'RightArm', RightArm: 'RightForeArm', RightForeArm: 'RightHand', RightHand: 'RightHandMiddle1',
  LeftUpLeg: 'LeftLeg', LeftLeg: 'LeftFoot', LeftFoot: 'LeftToeBase', LeftToeBase: [0, 0, 1],
  RightUpLeg: 'RightLeg', RightLeg: 'RightFoot', RightFoot: 'RightToeBase', RightToeBase: [0, 0, 1],
};

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _v = new THREE.Vector3(), _s = new THREE.Vector3();

export class SkinnedCharacter {
  constructor() {
    this.group = new THREE.Group(); // display container, scaled back to head units
    this.content = new THREE.Scene(); // what gets exported (meters); a Scene so its children export as root nodes
    this.group.add(this.content);
    this.group.scale.setScalar(1 / METERS);
    this.mixer = null;
    this.clips = [];
  }

  // body: BodyRig (already built + posed for the current params), p: params
  bake(body, p) {
    this.dispose();
    const defs = boneDefs();
    const j = body.j;
    const saved = Object.fromEntries(Object.entries(j).map(([k, o]) => [k, o.rotation.clone()]));
    const savedY = body.parts.position.y, savedYaw = body.root.rotation.y;
    body.root.rotation.y = 0;

    // ---- bind pose (T-pose) ----
    body.tPose();
    body.snap();
    const rootInv = new THREE.Matrix4().copy(body.root.matrixWorld).invert();
    const jointModel = (name) => _m.multiplyMatrices(rootInv, j[name].matrixWorld);
    const P = {}, JQ = {};
    for (const [name, , joint, posFn] of defs) {
      jointModel(joint).decompose(_v, _q, _s);
      JQ[name] = _q.clone();
      if (!posFn) P[name] = _v.clone();
    }
    for (const [name, , , posFn] of defs) if (posFn) P[name] = posFn(P);

    const BQ = {};
    for (const [name] of defs) {
      const aim = AIM[name];
      let y;
      if (Array.isArray(aim)) y = new THREE.Vector3(...aim);
      else if (aim) y = P[aim].clone().sub(P[name]);
      else y = new THREE.Vector3(0, 1, 0).applyQuaternion(JQ[name]).negate(); // fingers: along the segment
      y.normalize();
      const ref = Math.abs(y.z) > 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
      const x = new THREE.Vector3().crossVectors(y, ref).normalize();
      const z = new THREE.Vector3().crossVectors(x, y).normalize();
      BQ[name] = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
    }
    this.offset = {};
    for (const [name] of defs) this.offset[name] = JQ[name].clone().invert().multiply(BQ[name]);

    const bones = {}, list = [];
    for (const [name, parent] of defs) {
      const b = new THREE.Bone();
      b.name = name;
      if (parent) {
        const pq = BQ[parent].clone().invert();
        b.position.copy(P[name]).sub(P[parent]).applyQuaternion(pq).multiplyScalar(METERS);
        b.quaternion.copy(pq).multiply(BQ[name]);
        bones[parent].add(b);
      } else {
        b.position.copy(P[name]).multiplyScalar(METERS);
        b.quaternion.copy(BQ[name]);
      }
      bones[name] = b;
      list.push(b);
    }
    this.defs = defs;
    this.bones = bones;

    // ---- geometry: every visible driver mesh, in model space, skinned 100% to its joint's bone ----
    const jointToBone = {};
    for (const [name, , joint, posFn] of defs) if (!posFn) jointToBone[joint] = name;
    const index = Object.fromEntries(list.map((b, i) => [b.name, i]));
    const byMat = new Map();
    body.parts.traverse((o) => {
      if (!o.isMesh || !visibleUnder(o, body.parts)) return;
      let n = o.parent;
      while (n && !n.userData.joint) n = n.parent;
      const bone = jointToBone[n?.userData.joint];
      if (bone === undefined) return;
      const g = o.geometry.clone();
      for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
      if (!g.attributes.normal) g.computeVertexNormals();
      if (!g.index) g.setIndex([...Array(g.attributes.position.count).keys()]);
      g.applyMatrix4(_m.multiplyMatrices(rootInv, o.matrixWorld));
      g.scale(METERS, METERS, METERS);
      const n4 = g.attributes.position.count;
      const si = new Uint16Array(n4 * 4), sw = new Float32Array(n4 * 4);
      for (let i = 0; i < n4; i++) { si[i * 4] = index[bone]; sw[i * 4] = 1; }
      g.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
      g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
      if (!byMat.has(o.material)) byMat.set(o.material, []);
      byMat.get(o.material).push(g);
    });

    this.group.scale.setScalar(1);
    this.content.add(bones.Hips);
    this.group.updateMatrixWorld(true);
    const skeleton = new THREE.Skeleton(list);
    this.meshes = [];
    for (const [mat, geos] of byMat) {
      const geo = mergeGeometries(geos);
      geos.forEach((g) => g.dispose());
      const m = new THREE.SkinnedMesh(geo, mat);
      m.name = mat.name || 'part';
      m.frustumCulled = false;
      this.content.add(m);
      m.bind(skeleton, new THREE.Matrix4());
      this.meshes.push(m);
    }
    this.skeleton = skeleton;
    this.group.scale.setScalar(1 / METERS);

    // ---- clips ----
    this.clips = Object.entries(MOTIONS).map(([name, m]) => this.bakeClip(body, p, name, m, rootInv));

    // restore the driver
    for (const [k, e] of Object.entries(saved)) j[k].rotation.copy(e);
    body.parts.position.y = savedY;
    body.root.rotation.y = savedYaw;
    body.root.updateMatrixWorld(true);

    this.mixer = new THREE.AnimationMixer(this.content);
  }

  bakeClip(body, p, name, motion, rootInv) {
    const frames = Math.max(2, Math.round(motion.duration * motion.fps) + 1);
    const times = new Float32Array(frames);
    const quats = Object.fromEntries(this.defs.map(([n]) => [n, new Float32Array(frames * 4)]));
    const hips = new Float32Array(frames * 3);
    const world = {};
    motion.fn(body, p, 0);
    body.snap();
    const baseSnap = body.parts.position.y;
    for (let f = 0; f < frames; f++) {
      const t = (f / (frames - 1)) * motion.duration;
      times[f] = t;
      motion.fn(body, p, t);
      if (motion.snapEachFrame) body.snap();
      else { body.parts.position.y = baseSnap; body.root.updateMatrixWorld(true); }
      for (const [n, parent, joint] of this.defs) {
        _m.multiplyMatrices(rootInv, body.j[joint].matrixWorld).decompose(_v, _q, _s);
        world[n] = _q.clone().multiply(this.offset[n]);
        const local = parent ? world[parent].clone().invert().multiply(world[n]) : world[n];
        local.toArray(quats[n], f * 4);
        if (!parent) _v.multiplyScalar(METERS).toArray(hips, f * 3);
      }
    }
    const tracks = [new THREE.VectorKeyframeTrack('Hips.position', times, hips)];
    for (const [n] of this.defs) tracks.push(new THREE.QuaternionKeyframeTrack(`${n}.quaternion`, times, quats[n]));
    const clip = new THREE.AnimationClip(name[0].toUpperCase() + name.slice(1), motion.duration, tracks);
    return clip;
  }

  play(name) {
    if (!this.mixer) return;
    this.mixer.stopAllAction();
    const clip = this.clips.find((c) => c.name.toLowerCase() === name) || this.clips[0];
    this.mixer.clipAction(clip).play();
  }

  update(dt) { this.mixer?.update(dt); }

  dispose() {
    this.mixer?.stopAllAction();
    for (const m of this.meshes || []) m.geometry.dispose();
    this.content.clear();
    this.meshes = [];
  }
}

function visibleUnder(o, stop) {
  for (let n = o; n && n !== stop; n = n.parent) if (!n.visible) return false;
  return true;
}
