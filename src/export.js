import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

// Export the baked SkinnedCharacter as binary glTF 2.0 that any engine can load as-is, plus:
// - VRMC_vrm 1.0 (meta + humanoid bone map by node index) for VRM-aware tools
// - extras.character (root + Root node) and animations[i].extras.animation with everything the
//   creator knows: landmarks, sockets, colliders, hinges, masks, clip roles and foot contacts
// - a validation report; export is refused when it has errors.
// The PS2 shader can't travel between engines: materials are PBR (or unlit) with the grade and
// outfit tint baked into the textures.

const VRM_REQUIRED = ['hips', 'spine', 'head', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
  'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand'];

// canvases: render-target texture -> canvas holding its pixels (face atlas, baked body atlas)
export async function exportGLB(sk, canvases, { name = 'character', materials = 'lit' } = {}) {
  const baked = new Map();
  for (const [tex, canvas] of canvases) {
    if (!tex || !canvas) continue;
    const t = new THREE.CanvasTexture(canvas);
    t.magFilter = t.minFilter = THREE.NearestFilter;
    baked.set(tex, t);
  }
  const originals = sk.mesh.material;
  sk.mesh.material = originals.map((m) => exportMaterial(m, baked, materials));

  // node transforms = T-pose bind, which retargeters read as the rest pose. Save/restore the live
  // pose: the mixer skips unchanged values, so a static clip would not rewrite it on its own.
  const live = sk.skeleton.bones.map((b) => [b.position.clone(), b.quaternion.clone()]);
  sk.skeleton.pose();
  let report;
  const exporter = new GLTFExporter();
  exporter.register((writer) => ({
    afterParse() { report = annotate(writer, sk, name); },
  }));
  try {
    const glb = await exporter.parseAsync(sk.content, { binary: true, animations: sk.clips, onlyVisible: true });
    return { glb, report };
  } finally {
    sk.mesh.material.forEach((m) => m.dispose());
    sk.mesh.material = originals;
    sk.skeleton.bones.forEach((b, i) => { b.position.copy(live[i][0]); b.quaternion.copy(live[i][1]); });
  }
}

function exportMaterial(m, baked, kind) {
  const u = m.uniforms;
  let map = u.map.value;
  const color = u.color.value.clone();
  if (map?.isRenderTargetTexture) map = baked.get(map) || null;
  else if (map?.isDataTexture) map = null;
  else if (map && (u.hueShift.value !== 0 || u.satMul.value !== 1 || !color.equals(new THREE.Color(1, 1, 1)))) {
    map = tinted(map, u.hueShift.value, u.satMul.value, color);
  }
  const opts = { name: m.name, map, color: map ? 0xffffff : color, alphaTest: u.alphaTest.value, side: m.side };
  if (kind === 'unlit') return new THREE.MeshBasicMaterial(opts);
  const prop = m.name === 'prop';
  return new THREE.MeshStandardMaterial({ ...opts, roughness: prop ? 0.45 : 1, metalness: prop ? 0.8 : 0 });
}

// Runs inside the exporter once nodes/meshes/animations exist: node indices are known here.
function annotate(writer, sk, name) {
  const json = writer.json, nodeMap = writer.nodeMap;
  const nodeOf = (n) => nodeMap.get(sk.content.getObjectByName(n));
  const meta = structuredClone(sk.meta);

  for (const h of Object.values(meta.humanoid)) h.node = nodeOf(h.bone);
  for (const h of Object.values(meta.hinges)) h.node = nodeOf(h.bone);
  for (const c of Object.values(meta.colliders.bones)) c.node = nodeOf(c.bone);
  for (const [n, e] of Object.entries(meta.nodes)) { e.node = nodeOf(n); e.parentNode = nodeOf(e.bone); }
  meta.root.node = nodeOf('Root');
  meta.masks = Object.fromEntries(Object.entries(meta.masks).map(([k, roles]) => [k, {
    roles, nodes: roles.map((r) => meta.humanoid[r]?.node).filter((n) => n !== undefined),
  }]));
  meta.materials = Object.fromEntries((json.materials || []).map((m, i) => [m.name, i]));
  meta.mesh = { node: nodeOf('mesh_Character'), primitivesByMaterial: true };

  // per-clip metadata where engines keep it, and again under extras.character.animations
  (json.animations || []).forEach((a) => {
    const cm = meta.animations[a.name];
    if (cm) a.extras = { animation: cm };
  });

  writer.extensionsUsed.VRMC_vrm = true;
  json.extensions = json.extensions || {};
  json.extensions.VRMC_vrm = {
    specVersion: '1.0',
    meta: {
      name, version: '1', authors: ['Dreamare Character Engine'],
      licenseUrl: 'https://vrm.dev/licenses/1.0/',
      // conservative VRM defaults; edit if you publish the character
      avatarPermission: 'onlyAuthor', commercialUsage: 'personalNonProfit', creditNotation: 'required',
      allowRedistribution: false, modification: 'prohibited',
    },
    humanoid: { humanBones: Object.fromEntries(Object.entries(meta.humanoid).map(([role, h]) => [role, { node: h.node }])) },
  };

  const report = validate(json, sk, meta);
  meta.validation = { errors: report.errors.length, warnings: report.warnings.length };
  json.extras = { ...(json.extras || {}), character: meta };
  json.nodes[meta.root.node].extras = { character: meta };
  return report;
}

function validate(json, sk, meta) {
  const errors = [], warnings = [], passed = [];
  const check = (ok, code, msg, level = 'error') => {
    if (ok) passed.push(code);
    else (level === 'error' ? errors : warnings).push({ code, message: msg });
  };
  const nodes = json.nodes || [];

  // skeleton semantics
  const missing = VRM_REQUIRED.filter((r) => meta.humanoid[r]?.node === undefined);
  check(!missing.length, 'HUMANOID_REQUIRED', `missing humanoid roles: ${missing.join(', ')}`);
  check(['leftToes', 'rightToes'].every((r) => meta.humanoid[r]?.node !== undefined), 'HUMANOID_TOES', 'toes roles missing');
  const names = nodes.map((n) => n.name);
  const dup = names.filter((n, i) => n && names.indexOf(n) !== i);
  check(!dup.length, 'UNIQUE_NODE_NAMES', `duplicate node names: ${[...new Set(dup)].join(', ')}`);
  check((json.skins || []).length === 1, 'ONE_SKIN', `expected 1 skin, found ${(json.skins || []).length}`);

  // clean space
  const roots = json.scenes?.[json.scene || 0]?.nodes || [];
  const dirty = roots.filter((i) => {
    const n = nodes[i];
    const t = n.translation || [0, 0, 0], r = n.rotation || [0, 0, 0, 1], s = n.scale || [1, 1, 1];
    return n.matrix || t.some((x) => Math.abs(x) > 1e-6) || Math.abs(r[3]) < 1 - 1e-6 || s.some((x) => Math.abs(x - 1) > 1e-6);
  });
  check(!dirty.length, 'IDENTITY_ROOTS', `root nodes with transforms: ${dirty.map((i) => nodes[i].name).join(', ')}`);
  const nonUniform = nodes.filter((n) => n.scale && !(n.scale[0] > 0 && n.scale.every((x) => Math.abs(x - n.scale[0]) < 1e-6)));
  check(!nonUniform.length, 'POSITIVE_UNIFORM_SCALE', `non-uniform/negative scale: ${nonUniform.map((n) => n.name).join(', ')}`);
  check(Math.abs(meta.bounds.rest.min[1]) < 0.002, 'SOLES_AT_ZERO', `lowest point at y=${meta.bounds.rest.min[1]}`);
  const f = meta.landmarks.feet;
  check(['left', 'right'].every((s) => f[s].toeTip[2] > f[s].heel[2]), 'FACING_PLUS_Z', 'toes do not point to +Z');
  check(['left', 'right'].every((s) => Math.abs(f[s].toeTip[0] - f[s].heel[0]) < 0.01), 'FEET_PARALLEL_Z', 'feet are not parallel to Z');

  // VRM T-pose: arms along X
  // model-space bone positions (the display container is scaled/yawed; the file is not)
  sk.content.updateMatrixWorld(true);
  const toModel = sk.content.matrixWorld.clone().invert();
  const bp = (n) => new THREE.Vector3().setFromMatrixPosition(sk.bones[n].matrixWorld).applyMatrix4(toModel);
  for (const [L, sx] of [['Left', 1], ['Right', -1]]) {
    const dir = bp(`${L}Hand`).sub(bp(`${L}Arm`)).normalize();
    check(dir.x * sx > 0.995, `TPOSE_${L.toUpperCase()}_ARM`, `${L} arm is not along ${sx > 0 ? '+' : '-'}X (dir ${dir.toArray().map((v) => v.toFixed(3))})`);
  }

  // skin weights
  const w = sk.mesh.geometry.attributes.skinWeight;
  let badSum = 0, over4 = 0;
  for (let i = 0; i < w.count; i++) {
    const v = [w.getX(i), w.getY(i), w.getZ(i), w.getW(i)];
    if (Math.abs(v.reduce((a, b) => a + b, 0) - 1) > 1e-4) badSum++;
    if (v.filter((x) => x > 0).length > 4) over4++;
  }
  check(!badSum, 'WEIGHTS_SUM_TO_1', `${badSum} vertices whose weights do not sum to 1`);
  check(!over4, 'MAX_4_INFLUENCES', `${over4} vertices with more than 4 influences`);

  // clips
  const sets = sk.clips.map((c) => c.tracks.map((t) => t.name).sort().join('|'));
  check(sets.every((s) => s === sets[0]), 'CLIPS_SAME_BONE_SET', 'clips animate different bone sets');
  for (const c of sk.clips) {
    const cm = meta.animations[c.name];
    const d = sk.clipData[c.name];
    if (cm.loop) {
      let gap = 0;
      for (const q of Object.values(d.quats)) for (let k = 0; k < 4; k++) gap = Math.max(gap, Math.abs(q[k] - q[(d.frames - 1) * 4 + k]));
      for (let k = 0; k < 3; k++) gap = Math.max(gap, Math.abs(d.hips[k] - d.hips[(d.frames - 1) * 3 + k]));
      check(gap < 1e-3, `LOOP_CLEAN_${c.name}`, `${c.name}: first and last frame differ by ${gap.toFixed(4)}`);
    }
    let dx = 0, dz = 0;
    for (let f = 0; f < d.frames; f++) { dx = Math.max(dx, Math.abs(d.hips[f * 3] - d.hips[0])); dz = Math.max(dz, Math.abs(d.hips[f * 3 + 2] - d.hips[2])); }
    check(!cm.inPlace || Math.max(dx, dz) < 0.01, `IN_PLACE_${c.name}`, `${c.name} declared in-place but hips move ${Math.max(dx, dz).toFixed(3)} m`);
  }

  // landmarks and symmetry (warnings)
  for (const [n, e] of Object.entries(meta.nodes)) {
    const d = new THREE.Vector3(...e.position).distanceTo(bp(e.bone));
    check(d < 0.6, `LANDMARK_REACH_${n}`, `${n} is ${d.toFixed(2)} m from its bone ${e.bone}`, 'warning');
  }
  const L = meta.landmarks;
  const asym = (a, b) => Math.abs(a - b) / Math.max(1e-6, (a + b) / 2);
  check(asym(L.legLength.left, L.legLength.right) < 0.02, 'SYMMETRY_LEGS', `leg lengths ${L.legLength.left} / ${L.legLength.right}`, 'warning');
  check(asym(f.left.length, f.right.length) < 0.02, 'SYMMETRY_FEET', `foot lengths ${f.left.length} / ${f.right.length}`, 'warning');

  return { ok: errors.length === 0, errors, warnings, passed, generatedAt: new Date().toISOString() };
}

function tinted(tex, hueDeg, sat, color) {
  const img = tex.image;
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height);
  const a = (hueDeg * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
  for (let i = 0; i < d.data.length; i += 4) {
    const r = d.data[i] / 255, gg = d.data[i + 1] / 255, b = d.data[i + 2] / 255;
    const y = 0.299 * r + 0.587 * gg + 0.114 * b;
    let I = 0.596 * r - 0.274 * gg - 0.322 * b, Q = 0.211 * r - 0.523 * gg + 0.312 * b;
    [I, Q] = [(I * ca - Q * sa) * sat, (I * sa + Q * ca) * sat];
    d.data[i] = 255 * Math.min(1, Math.max(0, (y + 0.956 * I + 0.621 * Q) * color.r));
    d.data[i + 1] = 255 * Math.min(1, Math.max(0, (y - 0.272 * I - 0.647 * Q) * color.g));
    d.data[i + 2] = 255 * Math.min(1, Math.max(0, (y - 1.106 * I + 1.703 * Q) * color.b));
  }
  g.putImageData(d, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = t.minFilter = THREE.NearestFilter;
  return t;
}
