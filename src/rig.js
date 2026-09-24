import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MOTIONS, OUTFITS } from './body.js';
import { ps2Material } from './head.js';
import { sculptBody, regionSpec, REGION_NAMES } from './sculpt.js';
import { unwrap, BodyBaker } from './bodybake.js';

// Bakes the driver rig (BodyRig joints + segment meshes) into an engine-agnostic character:
// one SkinnedMesh + one skeleton (Root -> Hips -> ...), Mixamo-style names, VRM 1.0 humanoid roles,
// VRM T-pose bind, meters, +Y up, facing +Z, soles at y = 0, rigid skinning (1 bone per vertex),
// plus everything the creator already knows as metadata (landmarks, sockets, colliders, hinges,
// clip roles/contacts, bounds). export.js turns this.meta into glTF extras + VRMC_vrm.

export const METERS = 0.16; // one head unit (face width) in meters
const ACCESSORY = new Set(['hat', 'hair', 'prop']); // material slots that are not body volume
const PROXY = new Set(['top', 'bottom', 'shoes', 'skin']); // driver segment meshes (segmented style only)
const FINGER = /Hand(Thumb|Index|Middle|Ring|Pinky)/;
const DENSITY = 1000; // kg/m^3, bodies are roughly water

const lerp = (a, b, t) => a.clone().lerp(b, t);
const SIDES = [['Left', 'left', 'B', 1], ['Right', 'right', 'A', -1]]; // character's left is +X

// [bone, parent, driver joint, VRM humanoid role, position fn (virtual bones only)]
function boneDefs() {
  const d = [
    ['Root', null, null, null, () => new THREE.Vector3()],
    ['Hips', 'Root', 'pelvis', 'hips'],
    ['Spine', 'Hips', 'waist', 'spine'],
    ['Spine1', 'Spine', 'waist', 'chest', (P) => lerp(P.Spine, P.Neck, 0.33)],
    ['Spine2', 'Spine1', 'waist', 'upperChest', (P) => lerp(P.Spine, P.Neck, 0.66)],
    ['Neck', 'Spine2', 'neck', 'neck'],
    ['Head', 'Neck', 'head', 'head'],
  ];
  for (const [L, l, s] of SIDES) {
    // index finger sits on the thumb side: finger0 for B (+x), finger3 for A (-x)
    const fingers = s === 'B' ? ['Index', 'Middle', 'Ring', 'Pinky'] : ['Pinky', 'Ring', 'Middle', 'Index'];
    const vrm = { Index: 'Index', Middle: 'Middle', Ring: 'Ring', Pinky: 'Little' };
    d.push(
      [`${L}Shoulder`, 'Spine2', 'waist', `${l}Shoulder`, (P) => new THREE.Vector3(P[`${L}Arm`].x * 0.3, P[`${L}Arm`].y, P[`${L}Arm`].z)],
      [`${L}Arm`, `${L}Shoulder`, `shoulder${s}`, `${l}UpperArm`],
      [`${L}ForeArm`, `${L}Arm`, `elbow${s}`, `${l}LowerArm`],
      [`${L}Hand`, `${L}ForeArm`, `wrist${s}`, `${l}Hand`],
      [`${L}HandThumb1`, `${L}Hand`, `thumb${s}`, `${l}ThumbMetacarpal`],
      ...fingers.map((f, i) => [`${L}Hand${f}1`, `${L}Hand`, `finger${s}${i}`, `${l}${vrm[f]}Proximal`]),
    );
  }
  for (const [L, l, s] of SIDES) {
    d.push(
      [`${L}UpLeg`, 'Hips', `hip${s}`, `${l}UpperLeg`],
      [`${L}Leg`, `${L}UpLeg`, `knee${s}`, `${l}LowerLeg`],
      [`${L}Foot`, `${L}Leg`, `ankle${s}`, `${l}Foot`],
      [`${L}ToeBase`, `${L}Foot`, `ankle${s}`, `${l}Toes`, (P, ctx) => ctx.foot[l].toe],
    );
  }
  return d;
}

// which bone a bone's +Y axis points at, or a fixed model-space direction
const AIM = {
  Root: [0, 1, 0], Hips: 'Spine', Spine: 'Spine1', Spine1: 'Spine2', Spine2: 'Neck', Neck: 'Head', Head: [0, 1, 0],
  LeftShoulder: 'LeftArm', LeftArm: 'LeftForeArm', LeftForeArm: 'LeftHand', LeftHand: 'LeftHandMiddle1',
  RightShoulder: 'RightArm', RightArm: 'RightForeArm', RightForeArm: 'RightHand', RightHand: 'RightHandMiddle1',
  LeftUpLeg: 'LeftLeg', LeftLeg: 'LeftFoot', LeftFoot: 'LeftToeBase', LeftToeBase: [0, 0, 1],
  RightUpLeg: 'RightLeg', RightLeg: 'RightFoot', RightFoot: 'RightToeBase', RightToeBase: [0, 0, 1],
};

// hinge joints: driver axis (joint-local X) and which rotation sign bends the joint
const HINGES = { LeftForeArm: -1, RightForeArm: -1, LeftLeg: 1, RightLeg: 1 };
const HINGE_LIMIT = [0, 2.6]; // radians about the declared axis

export const MASKS = {
  head: ['neck', 'head'],
  leftArm: ['leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'leftThumbMetacarpal', 'leftIndexProximal', 'leftMiddleProximal', 'leftRingProximal', 'leftLittleProximal'],
  rightArm: ['rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand', 'rightThumbMetacarpal', 'rightIndexProximal', 'rightMiddleProximal', 'rightRingProximal', 'rightLittleProximal'],
  leftLeg: ['leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes'],
  rightLeg: ['rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes'],
};
MASKS.upperBody = ['spine', 'chest', 'upperChest', ...MASKS.head, ...MASKS.leftArm, ...MASKS.rightArm];
MASKS.lowerBody = ['hips', ...MASKS.leftLeg, ...MASKS.rightLeg];

const CLIP_ROLE = { pose: 'pose', idle: 'idle', walk: 'walk' };

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _v = new THREE.Vector3(), _s = new THREE.Vector3();
const arr = (v, k = 1) => [v.x * k, v.y * k, v.z * k].map((x) => +x.toFixed(4));
const r4 = (x) => +x.toFixed(4);

export class SkinnedCharacter {
  constructor(renderer) {
    this.bodyBaker = new BodyBaker(renderer);
    this.regionMats = Object.fromEntries(REGION_NAMES.map((n) => { const m = ps2Material(); m.name = n; return [n, m]; }));
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
    const saved = Object.fromEntries(Object.entries(j).map(([k, o]) => [k, o.quaternion.clone()]));
    const savedY = body.parts.position.y, savedYaw = body.root.rotation.y;
    body.root.rotation.y = 0;

    // ---- bind pose (VRM T-pose), soles on y = 0 ----
    body.tPose();
    body.snap();
    const rootInv = new THREE.Matrix4().copy(body.root.matrixWorld).invert();
    const model = (o) => new THREE.Matrix4().multiplyMatrices(rootInv, o.matrixWorld);

    // every visible driver mesh in model space (head units), tagged with its joint + material slot
    const items = [];
    body.parts.traverse((o) => {
      if (!o.isMesh || !visibleUnder(o, body.parts)) return;
      let n = o.parent;
      while (n && !n.userData.joint) n = n.parent;
      if (!n) return;
      const g = o.geometry.clone();
      for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
      if (!g.attributes.normal) g.computeVertexNormals();
      if (!g.index) g.setIndex([...Array(g.attributes.position.count).keys()]);
      g.applyMatrix4(model(o));
      items.push({ g, joint: n.userData.joint, mat: o.material, local: o.geometry, meshMatrix: o.matrix.clone() });
    });

    // feet (from the shoe/foot boxes) -> toe bone position + foot landmarks
    const ctx = { foot: {} };
    for (const [L, l, s] of SIDES) {
      const box = new THREE.Box3();
      for (const it of items) if (it.joint === `ankle${s}`) box.expandByObject(new THREE.Mesh(it.g));
      const len = box.max.z - box.min.z, cx = (box.min.x + box.max.x) / 2;
      const ankle = new THREE.Vector3().setFromMatrixPosition(model(j[`ankle${s}`]));
      const ballZ = box.min.z + len * 0.72;
      ctx.foot[l] = {
        box, len, ankle,
        heel: new THREE.Vector3(cx, box.min.y, box.min.z),
        toeTip: new THREE.Vector3(cx, box.min.y, box.max.z),
        ball: new THREE.Vector3(cx, box.min.y, ballZ),
        toe: new THREE.Vector3(cx, box.min.y + (ankle.y - box.min.y) * 0.3, ballZ),
      };
    }

    const P = {}, JQ = {};
    for (const [name, , joint, , posFn] of defs) {
      if (!joint) { JQ[name] = new THREE.Quaternion(); continue; }
      model(j[joint]).decompose(_v, _q, _s);
      JQ[name] = _q.clone();
      if (!posFn) P[name] = _v.clone();
    }
    for (const [name, , , , posFn] of defs) if (posFn) P[name] = posFn(P, ctx);

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
    if (AIM.Root) BQ.Root = new THREE.Quaternion(); // root node: identity transform at the ground origin
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
    this.role = Object.fromEntries(defs.filter((d) => d[3]).map((d) => [d[3], d[0]])); // role -> bone name

    // ---- one mesh, one skin: rigid weights, grouped by material into primitives ----
    const jointToBone = {};
    for (const [name, , joint, , posFn] of defs) if (joint && !posFn) jointToBone[joint] = name;
    const index = Object.fromEntries(list.map((b, i) => [b.name, i]));
    const byMat = new Map(), boneVerts = {};
    const sculpted = p.bodyStyle !== 'segmented';
    for (const it of items) {
      const bone = jointToBone[it.joint];
      if (!bone || (sculpted && PROXY.has(it.mat.name))) continue;
      const g = it.g.clone().scale(METERS, METERS, METERS);
      const n = g.attributes.position.count;
      const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) { si[i * 4] = index[bone]; sw[i * 4] = 1; }
      g.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
      g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
      if (!byMat.has(it.mat)) byMat.set(it.mat, []);
      byMat.get(it.mat).push(g);
      if (!ACCESSORY.has(it.mat.name)) {
        const vs = (boneVerts[bone] ||= []);
        for (let i = 0; i < n; i++) vs.push(new THREE.Vector3().fromBufferAttribute(g.attributes.position, i));
      }
    }
    const bodyBoxes = [];
    if (sculpted) this.sculpt(body, p, model, P, BQ, ctx, index, byMat, boneVerts, bodyBoxes);
    const mats = [...byMat.keys()];
    const perMat = mats.map((m) => { const g = mergeGeometries(byMat.get(m)); byMat.get(m).forEach((x) => x.dispose()); return g; });
    const geo = mergeGeometries(perMat, true);
    perMat.forEach((g) => g.dispose());

    this.group.scale.setScalar(1);
    this.content.add(bones.Root);
    this.group.updateMatrixWorld(true);
    const skeleton = new THREE.Skeleton(list);
    const mesh = new THREE.SkinnedMesh(geo, mats);
    mesh.name = 'mesh_Character';
    mesh.frustumCulled = false;
    this.content.add(mesh);
    mesh.bind(skeleton, new THREE.Matrix4());
    this.mesh = mesh;
    this.skeleton = skeleton;

    // ---- creator-known metadata ----
    const renderItems = sculpted ? items.filter((it) => !PROXY.has(it.mat.name)) : items;
    this.meta = this.measure(body, p, ctx, renderItems, boneVerts, model, BQ, bodyBoxes);
    this.meta.skinning = sculpted ? { influences: 4, rigid: false, note: 'body smooth-skinned; head/accessories rigid' } : { influences: 1, rigid: true };
    this.meta.bodyStyle = sculpted ? 'sculpted' : 'segmented';

    // ---- clips (driver back in its own pose; T-pose only existed for the bind) ----
    for (const [k, q] of Object.entries(saved)) j[k].quaternion.copy(q);
    const footLocal = {};
    for (const [, l, s] of SIDES) {
      const inv = model(j[`ankle${s}`]).invert();
      footLocal[l] = items.filter((it) => it.joint === `ankle${s}`).flatMap((it) => {
        const pos = it.g.attributes.position, out = [];
        for (let i = 0; i < pos.count; i++) out.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(inv));
        return out;
      });
    }
    this.clipMeta = {};
    this.clips = Object.entries(MOTIONS).map(([name, m]) => this.bakeClip(body, p, name, m, rootInv, footLocal));
    this.meta.animations = this.clipMeta;
    this.meta.bounds.maxPose = this.animatedBounds();

    // restore the driver
    for (const [k, q] of Object.entries(saved)) j[k].quaternion.copy(q);
    body.parts.position.y = savedY;
    body.root.rotation.y = savedYaw;
    body.root.updateMatrixWorld(true);
    this.group.scale.setScalar(1 / METERS);
    this.mixer = new THREE.AnimationMixer(this.content);
  }

  // Everything below is measured once here so games never have to guess it.
  // Sculpted body: SDF mesh -> distance-based skin weights (<= 4 bones) -> unwrap -> baked atlas,
  // one primitive per clothing region, all sharing that atlas.
  sculpt(body, p, model, P, BQ, ctx, index, byMat, boneVerts, bodyBoxes) {
    const t0 = performance.now();
    const outfit = OUTFITS[p.outfit] || OUTFITS.suit;
    const R = regionSpec(body, p, model, outfit);
    const parts = sculptBody(body, p, model, R, outfit);
    const segs = {};
    for (const [name, , joint] of this.defs) {
      if (!joint) continue;
      const a = P[name].clone();
      const aim = AIM[name];
      let b;
      if (typeof aim === 'string') b = P[aim].clone();
      else if (Array.isArray(aim)) b = a.clone().addScaledVector(new THREE.Vector3(...aim), name === 'Head' ? 1 : 0.3);
      else b = a.clone().addScaledVector(new THREE.Vector3(0, 1, 0).applyQuaternion(BQ[name]), 0.35 * p.fingerLen * p.handSize);
      segs[name] = [a, b];
    }
    for (const part of parts) skinWeights(part, segs, index);
    const segByIndex = Object.fromEntries(Object.entries(segs).map(([n, s]) => [index[n], s]));
    const { geo, groups, charts } = unwrap(parts, segByIndex, R, p.bodyRes);
    const inputs = ['top', 'bottom', 'shoes', 'skin'].map((slot) => {
      const u = body.mats[slot].uniforms;
      return { map: u.map.value, hue: u.hueShift.value, sat: u.satMul.value, bright: u.color.value.r };
    });
    this.bodyTexture = this.bodyBaker.bake(geo, R, inputs, p.bodyRes, p.bodyGrime);
    this.bodyCanvas = this.bodyBaker.toCanvas(this.bodyCanvas);
    geo.deleteAttribute('ao');
    geo.deleteAttribute('layer'); // bake-only attributes
    geo.scale(METERS, METERS, METERS);
    for (const gr of groups) {
      const sub = subset(geo, gr.start, gr.count);
      const mat = this.regionMats[gr.name];
      mat.uniforms.map.value = this.bodyTexture;
      if (!byMat.has(mat)) byMat.set(mat, []);
      byMat.get(mat).push(sub);
    }
    const names = Object.fromEntries(Object.entries(index).map(([n, i]) => [i, n]));
    const pos = geo.attributes.position, si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
    const box = new THREE.Box3();
    for (let i = 0; i < pos.count; i++) {
      let best = 0;
      for (let k = 1; k < 4; k++) if (sw.getComponent(i, k) > sw.getComponent(i, best)) best = k;
      const v = new THREE.Vector3().fromBufferAttribute(pos, i);
      (boneVerts[names[si.getComponent(i, best)]] ||= []).push(v);
      box.expandByPoint(v);
    }
    bodyBoxes.push(box);
    geo.dispose();
    this.stats = { tris: groups.reduce((s, g) => s + g.count / 3, 0), charts, ms: Math.round(performance.now() - t0) };
  }

  measure(body, p, ctx, items, boneVerts, model, BQ, bodyBoxes = []) {
    const bones = this.bones, R = this.role;
    const pos = (name) => new THREE.Vector3().setFromMatrixPosition(bones[name].matrixWorld);
    const all = new THREE.Box3(), bodyBox = new THREE.Box3();
    for (const b of bodyBoxes) { all.union(b); bodyBox.union(b); }
    for (const it of items) {
      const b = new THREE.Box3().setFromBufferAttribute(it.g.attributes.position);
      b.min.multiplyScalar(METERS); b.max.multiplyScalar(METERS);
      all.union(b);
      if (!ACCESSORY.has(it.mat.name)) bodyBox.union(b);
    }

    // sockets / landmark empties: named nodes parented to the bone that carries them
    const empties = {};
    const empty = (name, bone, at, yAxis) => {
      const o = new THREE.Object3D();
      o.name = name;
      const inv = bones[bone].matrixWorld.clone().invert();
      o.position.copy(at).applyMatrix4(inv);
      if (yAxis) {
        const localDir = yAxis.clone().transformDirection(inv);
        o.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), localDir);
      }
      bones[bone].add(o);
      empties[name] = { bone, position: arr(at) };
      return o;
    };

    const feet = {}, grips = {}, eyes = {}, legLength = {};
    const face = items.find((it) => it.mat.name === 'face');
    const eyeIdx = { left: [263, 362, 386, 374], right: [33, 133, 159, 145] }; // MediaPipe; subject's left = +X
    for (const [L, l, s, sx] of SIDES) {
      const f = ctx.foot[l];
      const m = (v) => v.clone().multiplyScalar(METERS);
      feet[l] = {
        heel: arr(f.heel, METERS), toeTip: arr(f.toeTip, METERS), ball: arr(f.ball, METERS),
        length: r4(f.len * METERS), width: r4((f.box.max.x - f.box.min.x) * METERS),
        ankleHeight: r4(f.ankle.y * METERS), soleHeight: r4((f.ankle.y - f.box.min.y) * METERS),
      };
      empty(`lm_${l}Heel`, `${L}Foot`, m(f.heel));
      empty(`lm_${l}ToeTip`, `${L}Foot`, m(f.toeTip));
      empty(`lm_${l}Ball`, `${L}Foot`, m(f.ball));
      legLength[l] = r4(pos(`${L}UpLeg`).distanceTo(pos(`${L}Foot`)));

      // grip: palm center; axis across the palm (what a handle would run along)
      const wrist = model(body.j[`wrist${s}`]);
      const palm = new THREE.Vector3(0, -0.21 * p.handSize, 0.05 * p.handSize).applyMatrix4(wrist).multiplyScalar(METERS);
      const axis = new THREE.Vector3(1, 0, 0).transformDirection(wrist);
      grips[l] = { position: arr(palm), axis: arr(axis) };
      empty(`socket_${l}Grip`, `${L}Hand`, palm, axis);

      if (face) {
        const e = new THREE.Vector3();
        for (const i of eyeIdx[l]) e.add(new THREE.Vector3().fromBufferAttribute(face.g.attributes.position, i));
        e.multiplyScalar(METERS / eyeIdx[l].length);
        eyes[l] = arr(e);
        empty(`lm_${l}Eye`, 'Head', e);
      }
      const hipVerts = boneVerts.Hips || [];
      const hipX = hipVerts.reduce((mx, v) => Math.max(mx, sx * v.x), 0);
      empty(`socket_${l}Hip`, 'Hips', new THREE.Vector3(sx * hipX, pos('Hips').y, 0));
    }
    const headTop = new THREE.Vector3(0, (face ? new THREE.Box3().setFromBufferAttribute(face.g.attributes.position).max.y : all.max.y / METERS) * METERS, pos('Head').z);
    empty('socket_headTop', 'Head', headTop);
    const chestVerts = boneVerts.Spine || [];
    const backZ = chestVerts.reduce((mn, v) => Math.min(mn, v.z), 0);
    empty('socket_back', 'Spine2', new THREE.Vector3(0, pos('Spine2').y, backZ));

    // per-bone capsules (bone-local, along bone +Y) with mass from volume
    const colliders = {};
    let totalMass = 0;
    const com = new THREE.Vector3();
    for (const [bone, vs] of Object.entries(boneVerts)) {
      const inv = bones[bone].matrixWorld.clone().invert();
      const lv = vs.map((v) => v.clone().applyMatrix4(inv));
      const b = new THREE.Box3().setFromPoints(lv);
      const cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2;
      const radius = Math.max(...lv.map((v) => Math.hypot(v.x - cx, v.z - cz)));
      const height = Math.max(b.max.y - b.min.y, 2 * radius);
      const center = new THREE.Vector3(cx, (b.min.y + b.max.y) / 2, cz);
      const cyl = height - 2 * radius;
      const mass = DENSITY * (Math.PI * radius * radius * cyl + (4 / 3) * Math.PI * radius ** 3);
      const role = this.defs.find((d) => d[0] === bone)[3];
      colliders[role] = { bone, radius: r4(radius), height: r4(height), center: arr(center), axis: 'y', mass: +mass.toFixed(2) };
      totalMass += mass;
      com.add(center.clone().applyMatrix4(bones[bone].matrixWorld).multiplyScalar(mass));
    }
    com.divideScalar(totalMass || 1);
    empty('lm_centerOfMass', 'Hips', com);

    // controller capsule around torso + legs + head (arms are out in the T-pose)
    const core = ['Hips', 'Spine', 'Neck', 'Head', 'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RightUpLeg', 'RightLeg', 'RightFoot']
      .flatMap((b) => boneVerts[b] || []);
    const cz = core.reduce((s, v) => s + v.z, 0) / (core.length || 1);
    const ctrlR = Math.max(...core.map((v) => Math.hypot(v.x, v.z - cz)));
    const bodyHeight = bodyBox.max.y;

    // hinges: bone-local axis whose positive rotation bends the joint
    const hinges = {};
    for (const [bone, sign] of Object.entries(HINGES)) {
      const axis = new THREE.Vector3(sign, 0, 0).applyQuaternion(this.offset[bone].clone().invert());
      const role = this.defs.find((d) => d[0] === bone)[3];
      hinges[role] = { bone, axis: arr(axis), limits: HINGE_LIMIT };
    }

    return {
      schema: 'dream-face-lab.character/1',
      units: 'meters', up: [0, 1, 0], forward: [0, 0, 1], left: [1, 0, 0],
      bindPose: 'T', bindPoseSpec: 'VRM 1.0 T-pose',
      skinning: { influences: 1, rigid: true },
      root: { bone: 'Root', position: [0, 0, 0], note: 'ground point between the feet' },
      humanoid: Object.fromEntries(Object.entries(R).map(([role, bone]) => [role, { bone }])),
      hinges,
      landmarks: {
        height: r4(all.max.y), bodyHeight: r4(bodyHeight),
        eyeHeight: eyes.left ? r4((eyes.left[1] + eyes.right[1]) / 2) : null,
        shoulderHeight: r4(pos('LeftArm').y),
        hipWidth: r4(pos('LeftUpLeg').distanceTo(pos('RightUpLeg'))),
        legLength, feet, eyes, grips,
        centerOfMass: arr(com),
      },
      nodes: empties, // landmark/socket empties: name -> parent bone + model-space position
      colliders: {
        bones: colliders,
        controller: { height: r4(bodyHeight), radius: r4(ctrlR), center: [0, r4(bodyHeight / 2), r4(cz)] },
        totalMass: +totalMass.toFixed(2), density: DENSITY,
      },
      bounds: { rest: { min: arr(all.min), max: arr(all.max) } },
      masks: MASKS,
      animations: {}, // filled once the clips are baked
    };
  }

  bakeClip(body, p, name, motion, rootInv, footLocal) {
    const frames = Math.max(2, Math.round(motion.duration * motion.fps) + 1);
    const times = new Float32Array(frames);
    const tracked = this.defs.filter(([, , joint]) => joint); // Root is static
    const quats = Object.fromEntries(tracked.map(([n]) => [n, new Float32Array(frames * 4)]));
    const hips = new Float32Array(frames * 3);
    const world = { Root: new THREE.Quaternion() };
    const foot = { left: [], right: [] };
    motion.fn(body, p, 0);
    body.snap();
    const baseSnap = body.parts.position.y;
    for (let f = 0; f < frames; f++) {
      const t = (f / (frames - 1)) * motion.duration;
      times[f] = t;
      motion.fn(body, p, t);
      if (motion.snapEachFrame) body.snap();
      else { body.parts.position.y = baseSnap; body.root.updateMatrixWorld(true); }
      for (const [n, parent, joint] of tracked) {
        _m.multiplyMatrices(rootInv, body.j[joint].matrixWorld).decompose(_v, _q, _s);
        world[n] = _q.clone().multiply(this.offset[n]);
        const local = world[parent].clone().invert().multiply(world[n]);
        local.toArray(quats[n], f * 4);
        if (n === 'Hips') _v.multiplyScalar(METERS).toArray(hips, f * 3);
      }
      for (const [, l, s] of SIDES) {
        const mw = _m.multiplyMatrices(rootInv, body.j[`ankle${s}`].matrixWorld);
        let minY = Infinity;
        for (const v of footLocal[l]) minY = Math.min(minY, _v.copy(v).applyMatrix4(mw).y);
        foot[l].push({ t, y: minY * METERS, z: new THREE.Vector3().setFromMatrixPosition(mw).z * METERS });
      }
    }
    const tracks = [new THREE.VectorKeyframeTrack('Hips.position', times, hips)];
    for (const [n] of tracked) tracks.push(new THREE.QuaternionKeyframeTrack(`${n}.quaternion`, times, quats[n]));
    const clipName = name[0].toUpperCase() + name.slice(1);
    const clip = new THREE.AnimationClip(clipName, motion.duration, tracks);

    // foot contacts (sole within 1.2 cm of the ground) and in-place ground speed while planted
    const contacts = {}, events = [];
    let speedSum = 0, speedN = 0;
    for (const l of ['left', 'right']) {
      const s = foot[l], on = s.map((x) => x.y < 0.012);
      const iv = [];
      for (let f = 0; f < frames; f++) {
        if (on[f] && (f === 0 || !on[f - 1])) iv.push([f, f]);
        if (on[f]) iv[iv.length - 1][1] = f;
      }
      for (const [a, b] of iv) {
        if (b > a && s[b].t > s[a].t) { speedSum += (s[a].z - s[b].z) / (s[b].t - s[a].t); speedN++; }
      }
      // an interval running through the loop point is reported once, with down > up
      if (motion.loop !== false && iv.length > 1 && iv[0][0] === 0 && iv[iv.length - 1][1] === frames - 1) {
        const last = iv.pop();
        iv[0] = [last[0], iv[0][1]];
      }
      contacts[l] = iv.map(([a, b]) => [r4(s[a].t), r4(s[b].t)]);
      for (const [d, u] of contacts[l]) {
        if (!(d === 0 && u === r4(motion.duration))) events.push({ time: d, name: 'footDown', side: l }, { time: u, name: 'footUp', side: l });
      }
    }
    events.sort((a, b) => a.time - b.time);
    const speed = speedN ? r4(Math.max(0, speedSum / speedN)) : 0;
    const loop = motion.loop !== false;
    this.clipMeta[clipName] = {
      role: CLIP_ROLE[name] || name, loop, duration: motion.duration, fps: motion.fps, frames,
      rootMotion: false, inPlace: true, inPlaceSpeed: speed, // play so ground moves at this m/s
      footContacts: contacts, events,
      boneSet: 'all humanoid bones (Root static)',
    };
    this.clipData = this.clipData || {};
    this.clipData[clipName] = { quats, hips, frames };
    return clip;
  }

  // bounding box of the skinned mesh over every frame of every clip (engines cull with bind bounds)
  animatedBounds() {
    const box = new THREE.Box3(), b = new THREE.Box3();
    const mixer = new THREE.AnimationMixer(this.content);
    for (const clip of this.clips) {
      const action = mixer.clipAction(clip).play();
      const frames = this.clipMeta[clip.name].frames;
      for (let f = 0; f < frames; f++) {
        mixer.setTime((f / (frames - 1)) * clip.duration * 0.9999);
        this.content.updateMatrixWorld(true);
        this.mesh.computeBoundingBox();
        box.union(b.copy(this.mesh.boundingBox));
      }
      action.stop();
    }
    mixer.stopAllAction();
    mixer.uncacheRoot(this.content);
    this.skeleton.pose();
    this.mesh.geometry.computeBoundingBox();
    this.mesh.boundingBox = null;
    return { min: arr(box.min), max: arr(box.max) };
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
    if (this.mixer) this.mixer.uncacheRoot(this.content);
    this.mesh?.geometry.dispose();
    this.content.clear();
    this.mesh = null;
  }
}

// smooth skinning: inverse-distance to each bone's axis segment, top 4, no cross-body leakage
function skinWeights(part, segs, index) {
  const n = part.positions.length / 3;
  const side = part.kind === 'handLeft' ? 'Left' : part.kind === 'handRight' ? 'Right' : null;
  const cands = Object.entries(segs).filter(([name]) => (side
    ? name.startsWith(side) && (name === `${side}ForeArm` || name === `${side}Hand` || FINGER.test(name))
    : !FINGER.test(name)));
  const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  const p = new THREE.Vector3(), ab = new THREE.Vector3(), ap = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    p.fromArray(part.positions, i * 3);
    const ws = [];
    for (const [name, [a, b]] of cands) {
      if (!side && ((name.startsWith('Left') && p.x < -0.05) || (name.startsWith('Right') && p.x > 0.05))) continue;
      ab.subVectors(b, a); ap.subVectors(p, a);
      const t = Math.max(0, Math.min(1, ap.dot(ab) / ab.lengthSq()));
      const d2 = ap.addScaledVector(ab, -t).lengthSq();
      ws.push([index[name], 1 / (d2 + 4e-4) ** 2]);
    }
    ws.sort((x, y) => y[1] - x[1]);
    let top = ws.slice(0, 4), sum = top.reduce((s, w) => s + w[1], 0);
    top = top.filter((w) => w[1] / sum >= 0.03);
    sum = top.reduce((s, w) => s + w[1], 0);
    top.forEach(([b, w], k) => { si[i * 4 + k] = b; sw[i * 4 + k] = w / sum; });
  }
  part.skinIndex = si;
  part.skinWeight = sw;
}

// compact copy of an index range (one clothing region) with only the vertices it uses
function subset(geo, start, count) {
  const idx = geo.index.array.subarray(start, start + count), map = new Map(), out = new THREE.BufferGeometry();
  const src = Object.entries(geo.attributes), dst = Object.fromEntries(src.map(([k, a]) => [k, []]));
  const newIdx = [];
  for (const v of idx) {
    if (!map.has(v)) {
      map.set(v, map.size);
      for (const [k, a] of src) for (let c = 0; c < a.itemSize; c++) dst[k].push(a.array[v * a.itemSize + c]);
    }
    newIdx.push(map.get(v));
  }
  for (const [k, a] of src) out.setAttribute(k, new THREE.BufferAttribute(new a.array.constructor(dst[k]), a.itemSize));
  out.setIndex(newIdx);
  return out;
}

function visibleUnder(o, stop) {
  for (let n = o; n && n !== stop; n = n.parent) if (!n.visible) return false;
  return true;
}
