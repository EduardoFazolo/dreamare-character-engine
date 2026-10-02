// Scene editor: the current scene = a terrain (the Scenarios generator's inputs, rebuilt here) + characters
// (GLBs sent from the Characters tab) placed on it. Autosaves the working copy; save / save-as / load past
// scenes; export the whole scene as GLB, or as a scene file with the characters inside.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { ps2Material, PS2 } from '../head.js';
import { generatePlace } from '../scenario/kinds.js';
import { createStage, bakeForExport } from '../scenario/stage.js';
import { VILLAGE } from '../scenario/biomes.js';
import { menubar } from '../menubar.js';
import { makeRig, curlFingers, detect, retarget, applyPose, snapshot, lerpPose, breathe, HANDLES, handlePos, dragHandle, dragStart, toRoot, toWorld, sitPose, hipsAt, compilePose, PRESETS } from './pose.js';
import { PROPS, CATEGORIES, buildProp } from '../scenario/props.js';
import { loadPhotos, applyLook, syncLook, sourceRig } from '../scenario/photolook.js';
import { createMist, createClouds } from '../scenario/mist.js';
import { loadFilm, buildGraph, schedule, mouths, shotAt, kf } from './film.js';
import { humanLife } from './life.js';
import { applyHand, HAND_PRESETS } from './hands.js';
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { assetList, importedList, importFile, loadVoice, playVoice, setListener, audioCtx, rawBytes, voiceStream, outputBus } from './voice.js';
import { align, segments as speechSegments, loadCaptions, saveCaptions, cueAt } from './captions.js';
import { AMBIENCES, startBed, stopBed, setVolume as bedVolume, playing as bedPlaying, stopAll as stopBeds } from './ambience.js';
import { currentScene, setCurrentScene, emptyScene, onSceneChange, get, put, del, all, uid, newActor, listScenes, removeScene, freeSceneId, openScene, writtenText, sceneFiles, saveCharacterFile } from '../store.js';

const $ = (s) => document.querySelector(s);
// Player mode (editor.html?player): the Slides tab's live view of a scene. Same scene, same breathing and
// atmosphere, but read-only (never writes a scene, the library or which scene is open), no panels, no audio,
// the camera straight from a shot, vertical 9:16. Driven by the parent page through window.__player.
const PLAYER = new URLSearchParams(location.search).has('player');
if (PLAYER) document.body.classList.add('player');
const status = (t) => ($('#status').textContent = t);
const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'scene';
const TERRAIN_DEFAULTS = { seed: 1998, biome: VILLAGE, neighbors: [], seaAngle: undefined, density: 1, time: 0.3, skyHue: 0, haze: 0.62, wrongness: 0.2, res: 240, sat: 0.7, vhs: 0.6, affine: 0.5, name: 'The default village' };

const canvas = $('#view');
const stage = createStage(canvas), { scene, camera } = stage;
stage.setRes(240);

let rec = null;          // the current scene record
let world = null;        // generated terrain
let terrainKey = '';     // what the terrain was built from (rebuild only when it changes)
const chars = new Map(); // charId -> Promise<{ gltf, name, thumb }>
const actors = new Map(); // actorId -> { root, mixer, action, clips, data }
let selected = null;

// ---------------- persistence ----------------
let saveT = 0;
const autosave = () => { if (PLAYER || document.visibilityState === 'hidden') return; clearTimeout(saveT); saveT = setTimeout(() => { saveT = 0; setCurrentScene(rec); }, 250); };
// leaving the tab: write a pending change now instead of waiting for the debounce
addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && saveT) { clearTimeout(saveT); saveT = 0; setCurrentScene(rec); } });
addEventListener('pagehide', () => { if (saveT) { clearTimeout(saveT); saveT = 0; setCurrentScene(rec); } });

// ---------------- terrain ----------------
function terrainParams() { return { ...TERRAIN_DEFAULTS, ...(rec.terrain || {}), biome: structuredClone(rec.terrain?.biome || VILLAGE), directives: resolvedDirectives }; }
// ---------------- directives: the scene's composition rules (scenes/README.md) ----------------
// converge / clearing / sightline reshape the land (gen.js), so their targets are resolved to ground points
// first (targets are the scene's own props / actors, placed relative to the spawn); ring expands into props.
let resolvedDirectives = [];
const xz = (ref) => { const v = resolvePoint(ref); return v ? [+v.x.toFixed(2), +v.z.toFixed(2)] : null; };
function resolveDirectives() {
  return (rec.directives || []).map((d) => {
    if (d.kind === 'converge') { const at = xz(d.toward); return at && { kind: 'converge', at, count: d.count ?? 4, surface: d.surface ?? 'stone' }; }
    if (d.kind === 'causeways') { const at = xz(d.toward); return at && { kind: 'causeways', at, count: d.count ?? 6, heights: d.heights || [5, 32] }; }
    if (d.kind === 'clearing') { const at = xz(d.around); return at && { kind: 'clearing', at, radius: d.radius ?? 5 }; }
    if (d.kind === 'sightline') { const from = xz(d.from || 'spawn'), to = xz(d.to); return from && to && { kind: 'sightline', from, to }; }
    return null;
  }).filter(Boolean);
}
// ring { prop, around, radius, count, face: 'in' | 'out' | 'along', jitter }: that many of a prop, evenly round the
// target (a seeded jitter so it isn't a clock face). Generated each load: they're not in rec.props.
function ringProps() {
  const out = [];
  (rec.directives || []).forEach((d, n) => {
    if (d.kind !== 'ring' || !PROPS[d.prop]) return;
    const c = resolvePoint(d.around); if (!c) return;
    let s = (n + 1) * 9301 + (d.count || 6) * 49297; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const count = Math.max(1, Math.min(48, d.count ?? 6)), R = d.radius ?? 10, J = d.jitter ?? 0.35, a0 = rnd() * Math.PI * 2;
    for (let k = 0; k < count; k++) {
      const a = a0 + (k / count) * Math.PI * 2 + (rnd() - 0.5) * J * (Math.PI * 2 / count), rr = R * (1 + (rnd() - 0.5) * J * 0.5);
      const x = c.x + Math.cos(a) * rr, z = c.z + Math.sin(a) * rr, toC = Math.atan2(c.x - x, c.z - z);
      const rotY = d.face === 'out' ? toC + Math.PI : d.face === 'along' ? toC + Math.PI / 2 : toC;
      out.push({ id: `${d.id || `ring${n}`}#${k}`, kind: d.prop, x, z, rotY: rotY + (rnd() - 0.5) * 0.4, scale: (d.scale ?? 1) * (0.85 + rnd() * 0.3), generated: true });
    }
  });
  return out.concat(world ? travellers().lamps : []);
}
// travellers { characters: [names], toward, count (16), pose ("kneel" | "sit" | "crouch"), lanterns: "out" | "none",
// between: [near, far] metres from the target (12, 70) }: people along the converging roads, at the roadside,
// all facing the thing, heads bowed, their lanterns gone out beside them. Generated each load (not in rec.actors);
// cached until the directive, the roads or the target move.
let travCache = { key: null, actors: [], lamps: [] };
function travellers() {
  const ds = (rec?.directives || []).filter((d) => d.kind === 'travellers' && d.characters?.length);
  if (!ds.length || !world?.roads?.length) return { actors: [], lamps: [] };
  const targets = ds.map((d) => resolvePoint(d.toward));
  const key = JSON.stringify([ds, world.roads.length, world.roads[0]?.[0], targets.map((t) => t && t.toArray().map((v) => Math.round(v)))]);
  if (travCache.key === key) return travCache;
  const out = { key, actors: [], lamps: [] };
  ds.forEach((d, n) => {
    const c = targets[n]; if (!c) return;
    let s = (n + 7) * 7919 + (d.count || 16) * 104729; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const [near, far] = d.between || [12, 70], count = Math.max(1, Math.min(60, d.count ?? 16));
    // candidate spots: every ~6 m along every road, within the distance band
    const spots = [];
    for (const road of world.roads) for (let i = 1; i < road.length - 1; i += 3) {
      const [x, z] = road[i], dist = Math.hypot(x - c.x, z - c.z); if (dist < near || dist > far) continue;
      const [ax, az] = road[i - 1], [bx, bz] = road[i + 1], l = Math.hypot(bx - ax, bz - az) || 1;
      spots.push([x, z, -(bz - az) / l, (bx - ax) / l]);
    }
    for (let k = 0; k < count && spots.length; k++) {
      const [x0, z0, nx, nz] = spots.splice(Math.floor(rnd() * spots.length), 1)[0], side = rnd() < 0.5 ? -1 : 1, off = 1.8 + rnd() * 0.8;
      const x = x0 + nx * side * off, z = z0 + nz * side * off, rotY = Math.atan2(c.x - x, c.z - z) + (rnd() - 0.5) * 0.25, fx = Math.sin(rotY), fz = Math.cos(rotY);
      const gy = world.floor(x, z), id = `${d.id || `trav${n}`}#${k}`;
      out.actors.push({ id, generated: true, character: d.characters[Math.floor(rnd() * d.characters.length)], x, z, rotY, scale: 0.9 + rnd() * 0.15,
        pose: { preset: d.pose || 'kneel', look: [x + fx * 1.1, gy, z + fz * 1.1], alive: { blink: true, sway: 0.25 } } });
      if ((d.lanterns ?? 'out') === 'out') out.lamps.push({ id: `${id}-lamp`, kind: 'lanternOut', x: x + Math.cos(rotY) * 0.55, z: z - Math.sin(rotY) * 0.55, rotY: rnd() * 6.28, generated: true });
    }
  });
  travCache = out;
  return out;
}
// after the scene's own props are placed: resolve the directives, rebuild the land if they changed it, then
// place the rings (and re-seat everything on the reshaped ground)
function applySceneDirectives() {
  const next = resolveDirectives(), changed = JSON.stringify(next) !== JSON.stringify(resolvedDirectives);
  resolvedDirectives = next;
  if (changed) buildTerrain(false);
  syncProps();
  return changed;
}
function buildTerrain(force) {
  const p = terrainParams(), key = JSON.stringify(p);
  if (!force && key === terrainKey) return false;
  terrainKey = key;
  if (world) { scene.remove(world.group); world.group.traverse((m) => m.geometry?.dispose()); }
  world = generatePlace(p);
  world.name = p.name;
  scene.add(world.group);
  applyFrame(p);
  if (look()) applyLook(world.group, look());
  return true;
}
// looks (terrain.look): drawn (none), 'photo' (PS2 horror: photographed surfaces) or 'source' (Source-engine
// realism: lit photo materials, shadows, a sharper frame); a switch under Mood (photolook.js). The photos load
// once, before the first scene (the end of this file).
const look = () => rec?.terrain?.look || undefined;
const rig = sourceRig(scene, stage.renderer);
function applyFrame(p = terrainParams()) { // (the Source look renders sharper, with the tape wear nearly off)
  const src = look() === 'source', res = src ? Math.max(p.res, 640) : p.res;
  if (PLAYER) stage.setRes(res, true, P.outW); else stage.setRes(res); stage.vhs = src ? Math.min(p.vhs, 0.15) : p.vhs; stage.sat = src ? Math.max(p.sat, 0.85) : p.sat; stage.punch = p.punch || 0;
}
function refreshLook() { applyLook(world?.group, look()); for (const pr of props.values()) applyLook(pr.built.group, look()); for (const o of actors.values()) applyLook(o.root, look()); applyFrame(); }
// moving mist (mist.js): as thick as the scene's fog, or terrain.mist (0..1) to set it outright
const mist = createMist(scene);
const mistAmount = () => { const tr = rec?.terrain; if (tr?.mist != null) return tr.mist; const h = terrainParams().haze; return Math.max(0, Math.min(1, (h - 0.2) / 0.5)); };
const clouds = createClouds(scene); // (terrain.clouds 0..1: banks drifting across the sky and the moon)
const mistStep = (t) => { mist.update(t, camera, P.mist ?? mistAmount(), world?.floor?.bind(world)); clouds.update(t, camera, rec?.terrain?.clouds || 0); };
const collectLights = () => [...props.values()].flatMap((pr) => pr.built.lights || []); // (the lamps' real light, in the Source look)

// ---------------- characters ----------------
const loader = new GLTFLoader();
function loadChar(id) {
  if (!chars.has(id)) chars.set(id, (async () => {
    const c = await get('characters', id);
    if (!c) return null;
    const gltf = await loader.parseAsync(c.glb.slice(0), '');
    return { gltf, name: c.name, thumb: c.thumb };
  })());
  return chars.get(id);
}
// the exported GLB carries unlit materials; in the scene the characters get the PS2 shader back
function ps2ify(root) {
  root.traverse((m) => {
    if (!m.isMesh) return;
    const conv = (src) => { const n = ps2Material({ map: src.map || null, alphaTest: src.alphaTest || 0, side: src.side }); n.name = src.name; n.userData.orig = src; if (!src.map && src.color) n.uniforms.color.value.copy(src.color); return n; };
    m.material = Array.isArray(m.material) ? m.material.map(conv) : conv(m.material);
    m.frustumCulled = false; // skinned bounds are the bind pose; poses reach outside it
  });
}
async function spawnActor(a) {
  if (!a.charId) return null; // (a character nobody has: skipped, not a crash)
  const c = await loadChar(a.charId);
  if (!c) return null;
  const root = SkeletonUtils.clone(c.gltf.scene);
  ps2ify(root);
  // only: 'head' shows the head alone (face, mouth, eyes, hair), the body hidden: a face on something else, like an egg in a cup
  if (a.only === 'head' || a.only === 'face') root.traverse((m) => { if (m.isMesh && ['top', 'bottom', 'shoes', 'skin', ...(a.only === 'face' ? ['hair', 'hairStrands', 'hat', 'animalEar'] : [])].includes(m.material?.name)) m.visible = false; }); // (face: the hair and hat hidden too, only the face and its skull: a face in a flower)
  if (a.shade) root.traverse((m) => { if (m.isMesh && m.material) m.material.userData.shade = +a.shade; }); // (shade 0..1: the figure sunk in gloom in the lit looks, only the glossy eyes catching the light)
  if (a.glowFace) root.traverse((m) => { if (m.isMesh && ['face', 'scalp', 'mouth', 'eye', 'mask'].includes(m.material?.name)) { m.material.userData.faceGlow = +a.glowFace; m.material.userData.glowColor = a.glowColor; } }); // (glowFace: the face lights itself (0..1), as a sun with a face does, in glowColor [r, g, b] 0..1 if given; the lit looks only)
  if (a.glowEyes) root.traverse((m) => { if (m.isMesh && m.material?.name === 'eye') m.material.userData.eyeGlow = a.glowEyes === true ? 0.5 : +a.glowEyes; }); // (glowEyes: a faint light of the eyes' own (0..1), so they read in a dark socket; in the lit looks they stay shaded, glossy spheres)
  if (look()) applyLook(root, look());
  const mixer = new THREE.AnimationMixer(root), clips = c.gltf.animations;
  const o = { root, mixer, clips, data: a, action: null, rig: makeRig(root), tween: null };
  root.userData.actorId = a.id;
  scene.add(root);
  actors.set(a.id, o);
  if (a.pose?.bones) o.mixer.stopAllAction(); else if (!a.pose) setAnim(o, a.anim);
  place(o);
  return o;
}
// a still pose (from a photo, the library or the handles) replaces the clip; it arrives smoothly
function setPose(o, pose, { tween = true } = {}) {
  const from = rawPose(o) || snapshot(o.rig); // from wherever the body is now (the clip's current frame)
  o.compiled = null;
  o.mixer.stopAllAction(); o.action = null;
  o.data.pose = pose; o.data.breathe ??= true;
  o.tween = tween ? { from, t: 0 } : null;
  autosave();
}
function clearPose(o) { o.data.pose = null; o.compiled = null; o.lookCamera = false; o.tween = null; setAnim(o, o.data.anim === 'Custom' ? 'Idle' : o.data.anim); autosave(); }
function setAnim(o, name) {
  const clip = o.clips.find((c) => c.name === name) || o.clips.find((c) => c.name === 'Idle') || o.clips.find((c) => c.name === 'Pose') || o.clips[0];
  o.action?.stop();
  if (clip) { o.action = o.mixer.clipAction(clip); o.action.play(); o.data.anim = clip.name; }
}
function place(o) {
  const a = o.data, st = a.seat && props.get(a.seat.prop)?.built.seats[a.seat.idx];
  if (st) { // sitting: hang the character under the seat anchor, hips on it (it rocks / swings with the prop)
    if (o.root.parent !== st) st.add(o.root);
    if (!o.sitOffset) { const rp = rawPose(o); if (rp) applyPose(o.rig, rp); o.root.position.set(0, 0, 0); o.root.scale.setScalar(1); o.sitOffset = hipsAt(o.rig); }
    const turn = a.seatRot || 0; // turned on the seat, around the hips
    o.root.rotation.set(0, turn, 0); o.root.scale.setScalar(a.scale);
    o.root.position.copy(o.sitOffset).applyAxisAngle(new THREE.Vector3(0, 1, 0), turn).multiplyScalar(-a.scale);
    return;
  }
  if (o.root.parent !== scene) scene.add(o.root);
  if (a.inside && props.get(a.inside)) { o.root.scale.setScalar(a.scale); placeInside(o); return; }
  o.root.position.set(a.x, (a.float ? Math.max(world.floor(a.x, a.z), -1.6) : world.floor(a.x, a.z)) + (a.y || 0), a.z); // (float: from the water's surface, e.g. walking a plank walk over it)
  o.root.rotation.set(0, a.rotY, 0);
  o.root.scale.setScalar(a.scale);
}
// Things that follow other things each frame, after everyone is posed:
//   a prop with "hold": { "actor", "hand": "right" | "left", "offset": [x, y, z] } hangs from that hand
//   an actor with "inside": "<prop id>" (and "offset") sits in that prop (a tiny person in a lantern), wherever it goes
const _hv = new THREE.Vector3();
function followers() {
  for (const pr of props.values()) {
    const h = pr.data.hold; if (!h) continue;
    const o = actors.get(h.actor) || [...actors.values()].find((x) => x.data.name === h.actor); if (!o) continue;
    o.root.updateWorldMatrix(true, true);
    const side = h.hand === 'left' ? 'Left' : 'Right', B = o.rig.bones, g = pr.built.group;
    if (h.by === 'pinch' && B[`${side}HandIndex3`] && B[`${side}HandThumb3`]) {
      // held at the pinch: the point between the thumb's and the index finger's tips (each tip = its last joint
      // carried on by that segment's length again); the ring's top sits there, the lantern hangs below
      const tip = (f) => { const a = B[`${side}Hand${f}2`].getWorldPosition(new THREE.Vector3()), b = B[`${side}Hand${f}3`].getWorldPosition(new THREE.Vector3()); return b.addScaledVector(b.clone().sub(a), 0.55); }; // (the pad of the fingertip, not past it)
      _hv.copy(tip('Index')).add(tip('Thumb')).multiplyScalar(0.5);
      const a = B[`${side}HandIndex1`].getWorldPosition(new THREE.Vector3()), b = B[`${side}HandPinky1`].getWorldPosition(new THREE.Vector3());
      g.position.set(_hv.x, _hv.y - (h.ring ?? 0.47), _hv.z);
      g.rotation.set(0, Math.atan2(b.x - a.x, b.z - a.z), 0);
    } else if (h.by === 'fingers' && B[`${side}HandMiddle2`]) {
      // carried by a ring hooked over the curled fingers: it hangs from the middle finger joints (ring = how far its
      // ring's inside top is above its base), turned so the ring threads along the fingers
      const a = B[`${side}HandIndex2`].getWorldPosition(new THREE.Vector3()), b = B[`${side}HandPinky2`].getWorldPosition(new THREE.Vector3());
      _hv.copy(a).add(b).multiplyScalar(0.5);
      g.position.set(_hv.x, _hv.y - (h.ring ?? 0.47), _hv.z);
      g.rotation.set(0, Math.atan2(b.x - a.x, b.z - a.z), 0); // (the ring's plane across the fingers: the fingers pass through it)
    } else {
      B[`${side}Hand`].getWorldPosition(_hv);
      const off = h.offset || [0, -0.62, 0];
      g.position.set(_hv.x + off[0], _hv.y + off[1], _hv.z + off[2]);
    }
  }
  for (const o of actors.values()) if (o.data.inside) placeInside(o);
}
function placeInside(o) {
  const pr = props.get(o.data.inside); if (!pr) return;
  if (!pr.occupied) { pr.occupied = true; pr.built.group.traverse((m) => { if (m.name === 'wick flame') m.visible = false; }); } // (their flame is out: they're what's in there)
  const g = pr.built.group; g.updateWorldMatrix(true, false);
  o.root.position.copy(g.localToWorld(_hv.set(...(o.data.offset || [0, 0.08, 0])))); // (offset in the prop's own frame)
  o.root.rotation.y = o.data.face === 'camera' ? Math.atan2(camera.position.x - o.root.position.x, camera.position.z - o.root.position.z) : o.data.rotY || 0;
}
// leaning in: the spine bends toward the camera (pose.lean 0..1), after the pose and breathing
function leanIn(o) {
  const k = o.data.pose?.lean; if (!k || o.data.pose?.bow) return; // (a bow already curls toward the camera: leaning too pulls it straight)
  o.root.updateWorldMatrix(true, true);
  for (const b of ['Spine1', 'Spine2', 'Neck']) turnToward(o.rig.bones[b], camera.position, k * 0.45, 0.7);
}
// sent characters arrive with offsets relative to the spawn's view: turn them into world spots facing you
function settle(a) {
  if (!a.rel) return false;
  const y = world.homeYaw, fx = -Math.sin(y), fz = -Math.cos(y), rx = Math.cos(y), rz = -Math.sin(y);
  const x = rx * a.x + fx * -a.z, z = rz * a.x + fz * -a.z;
  a.x = x; a.z = z; a.rotY = Math.atan2(-x, -z); a.rel = false;
  return true;
}

// ---------------- references in scene files ----------------
// Scene files may say where things are by reference instead of raw numbers (so they can be written by hand):
//   point: [x, y, z] | [x, z] (on the ground) | "spawn" | "camera" | "<actor or prop id / name>" | { at: <point>, offset: [x, y, z] }
//   place: { from: "spawn" | "<id>", right: m, forward: m }   (relative to that thing's own facing)
//   face:  "spawn" | "camera" | "<id>" | [x, z]
//   character: "<name in the library>"  (instead of charId)
let library = []; // [{ id, name }]
function findEntity(ref) {
  if (typeof ref !== 'string') return null;
  const r = ref.toLowerCase(), pr = [...props.values()].find((p) => p.data.id === ref || (p.data.name || '').toLowerCase() === r);
  if (pr) return { kind: 'prop', pr };
  const o = [...actors.values()].find((x) => x.data.id === ref || x.data.name.toLowerCase() === r || x.data.name.split(' ')[0].toLowerCase() === r);
  return o ? { kind: 'actor', o } : null;
}
function spawnFrame() { const y = world.homeYaw; return { pos: new THREE.Vector3(0, world.floor(0, 0), 0), fwd: new THREE.Vector3(-Math.sin(y), 0, -Math.cos(y)) }; }
function resolvePoint(ref) {
  if (ref == null) return null;
  if (Array.isArray(ref)) return ref.length === 2 ? new THREE.Vector3(ref[0], world.floor(ref[0], ref[1]), ref[1]) : new THREE.Vector3(...ref);
  if (typeof ref === 'object' && ref.at != null) { const p = resolvePoint(ref.at); return p && p.add(new THREE.Vector3(...(ref.offset || [0, 0, 0]))); }
  if (typeof ref === 'object' && ref.rel != null) { // { rel: actor/prop id, right, forward, up }: in that thing's own frame (up from its ground)
    const e = findEntity(ref.rel); if (!e) return null;
    const d = e.kind === 'actor' ? e.o.data : e.pr.data, r = (e.kind === 'actor' ? e.o.baseRotY ?? d.rotY : d.rotY) || 0, fx = Math.sin(r), fz = Math.cos(r), x = d.x + fx * (ref.forward || 0) - fz * (ref.right || 0), z = d.z + fz * (ref.forward || 0) + fx * (ref.right || 0);
    return new THREE.Vector3(x, world.floor(d.x, d.z) + (ref.up || 0), z);
  }
  if (typeof ref === 'object' && ref.behind != null) { // { behind: A, toward: B, back: m, up: m, side: m }: over A's shoulder, looking at B
    const a = resolvePoint(ref.behind), b = resolvePoint(ref.toward); if (!a || !b) return null;
    const d = a.clone().sub(b); d.y = 0; d.normalize();
    return a.addScaledVector(d, ref.back ?? 2).add(new THREE.Vector3(-d.z, 0, d.x).multiplyScalar(ref.side ?? 0)).add(new THREE.Vector3(0, ref.up ?? 0.5, 0));
  }
  if (ref === 'spawn') return spawnFrame().pos.add(new THREE.Vector3(0, 1.6, 0));
  if (ref === 'camera') return camera.position.clone();
  const e = findEntity(ref);
  if (e?.kind === 'actor') { e.o.root.updateWorldMatrix(true, true); return e.o.rig.bones.Head.getWorldPosition(new THREE.Vector3()); }
  if (e?.kind === 'prop') { const g = e.pr.built.group; const b = new THREE.Box3().setFromObject(g); return new THREE.Vector3(g.position.x, (b.min.y + b.max.y) / 2, g.position.z); }
  return null;
}
function resolvePlace(d) { // fills d.x / d.z from d.place (kept in the file, so the scene stays readable)
  const pl = d.place; if (!pl) return;
  let pos, fwd;
  if (!pl.from || pl.from === 'spawn') ({ pos, fwd } = spawnFrame());
  else { const e = findEntity(pl.from); if (!e) return; const obj = e.kind === 'prop' ? e.pr.built.group : e.o.root, r = e.kind === 'prop' ? e.pr.data.rotY : e.o.data.rotY; pos = obj.getWorldPosition(new THREE.Vector3()); fwd = new THREE.Vector3(Math.sin(r || 0), 0, Math.cos(r || 0)); }
  const right = new THREE.Vector3(-fwd.z, 0, fwd.x).multiplyScalar(pl.from && pl.from !== 'spawn' ? -1 : 1); // a thing's own right hand; the spawn's is the viewer's right
  const p = pos.clone().addScaledVector(fwd, pl.forward || 0).addScaledVector(right, pl.right || 0);
  d.x = p.x; d.z = p.z;
}
function resolveFace(d) { if (d.face == null) return; const t = d.face === 'camera' ? camera.position : resolvePoint(d.face); if (t) d.rotY = Math.atan2(t.x - d.x, t.z - d.z); }
function resolveCharacter(a) {
  if (a.charId && moved[a.charId]) a.charId = moved[a.charId]; // (a character moved from this browser into a file)
  if (a.charId && !library.some((l) => l.id === a.charId) && (a.character || a.name)) a.charId = null; // (an id this browser doesn't have: find it by name)
  if (!a.charId && (a.character || a.name)) { const want = String(a.character || a.name).toLowerCase(), c = library.find((l) => l.id.startsWith('file:') && l.name.toLowerCase() === want) || library.find((l) => l.name.toLowerCase() === want); if (c) { a.charId = c.id; if (!a.name) a.name = c.name; } } a.name ||= a.character || 'someone'; }
// the character library, written to library/characters.json so scenes can be written by hand (names -> ids)
// Characters made in the Characters tab before they were saved as files live only in this browser: each is written
// out as a file once (public/characters), then scenes find it there, in any browser
const moved = {}; // old browser id -> 'file:<slug>'
async function moveToFiles(recs) {
  if (PLAYER || !(await sceneFiles())) return;
  for (const c of recs) {
    if (c.id.startsWith('file:') || !c.glb) continue;
    if (c.movedTo) { moved[c.id] = c.movedTo; continue; }
    const f = await saveCharacterFile({ name: c.name, glb: c.glb, thumb: c.thumb, params: c.params });
    if (f?.id) { moved[c.id] = f.id; await put('characters', c.id, { ...c, movedTo: f.id }); }
  }
}
async function refreshLibrary() {
  const recs = await all('characters');
  await moveToFiles(recs);
  for (const c of recs) if (c.movedTo) moved[c.id] = c.movedTo;
  library = recs.filter((c) => !moved[c.id]).map((c) => ({ id: c.id, name: c.name, created: c.created }));
  await characterFiles();
  if (!PLAYER && await sceneFiles()) fetch('/__library/characters', { method: 'PUT', body: JSON.stringify({ note: 'written by the scene editor: characters you can put in scenes (by name or id)', characters: library }, null, 2) }).catch(() => {});
}

// Character files: public/characters/<slug>.glb (index.json lists them), characters made outside this browser,
// e.g. written by Claude for a scene. Each is copied into this browser's library once (id "file:<slug>"), so
// scenes name them like any other character ("character": "Old Pim Holwub").
async function characterFiles() {
  let list = [];
  try { list = await (await fetch('/characters/index.json')).json(); } catch { return; }
  let added = false;
  for (const c of list) {
    const id = `file:${c.file.replace(/\.glb$/, '')}`, have = library.some((l) => l.id === id);
    if (have && (await get('characters', id))?.version === c.version) continue; // (a new version of the file replaces the copy)
    try {
      const glb = await (await fetch(`/characters/${c.file}`)).arrayBuffer();
      await put('characters', id, { id, name: c.name, glb, thumb: c.thumb ? `/characters/${c.thumb}` : null, version: c.version, created: Date.now() });
      if (!have) library.push({ id, name: c.name, created: Date.now() });
      chars.delete(id); for (const [aid, o] of actors) if (o.data.charId === id) { o.root.removeFromParent(); actors.delete(aid); } // (re-spawned from the new file)
      added = true;
    } catch (e) { console.warn('character file', c.file, e); }
  }
}

// ---------------- props ----------------
const props = new Map(); // propId -> { data, built }
let selectedProp = null, picking = null; // picking: { propId } while choosing who sits
function placeProp(pr) {
  const d = pr.data, g = pr.built.group;
  const ground = d.indoor ? world.floor(d.x, d.z) : d.float ? Math.max(world.height(d.x, d.z), -1.6) : world.height(d.x, d.z) - 0.02; // (float: sits on the water, -1.6 = the scenario sea level; indoor: on a room's floor, not the roof over it)
  g.position.set(d.x, ground + (d.y || 0), d.z); g.rotation.set(0, d.rotY || 0, 0); g.scale.setScalar(d.scale || 1); // (y: lifted off the ground, e.g. a lantern held up)
}
function syncProps() {
  rec.props ||= [];
  const list = [...rec.props, ...(world ? ringProps() : [])];
  const want = new Set(list.map((p) => p.id));
  for (const [id, pr] of props) if (!want.has(id)) { scene.remove(pr.built.group); props.delete(id); }
  for (const d of list) {
    let pr = props.get(d.id); const key = `${d.kind}|${d.engraving || ''}|${d.engravingTurn || 0}`; // (what the build reads: a change rebuilds it)
    if (pr && pr.key !== key) { scene.remove(pr.built.group); props.delete(d.id); pr = null; }
    let fresh = false;
    if (!pr) { const built = buildProp(d.kind, d.id, d); if (!built) continue; built.group.userData.propId = d.id; pr = { data: d, built, key }; props.set(d.id, pr); scene.add(built.group); fresh = true; }
    if (d.open != null && pr.built.open != null) pr.built.open = d.open; // (a door: "open": 0 keeps it shut)
    pr.data = d; resolvePlace(d); resolveFace(d); placeProp(pr);
    if (fresh && look()) applyLook(pr.built.group, look()); // (after placing: its world scale sets the photo's size)
  }
  if (selectedProp && !props.has(selectedProp)) selectedProp = null;
}
function spawnProp(kind, p) {
  const d = { id: uid(), kind, x: p.x, z: p.z, rotY: Math.atan2(camera.position.x - p.x, camera.position.z - p.z), scale: 1 }; // facing you
  rec.props ||= []; rec.props.push(d); syncProps(); selectProp(d.id); autosave(); renderPanel();
  status(`${PROPS[kind].label} placed${props.get(d.id).built.seats.length ? ' · "Seat a character" sits someone in it' : ''}`);
}
function removeProp(id) {
  for (const o of actors.values()) if (o.data.seat?.prop === id) standUp(o, true);
  rec.props = rec.props.filter((p) => p.id !== id); syncProps(); selectProp(null); autosave(); renderPanel();
}
function pickProp() {
  const hits = ray.intersectObjects([...props.values()].map((p) => p.built.group), true);
  for (const h of hits) { let o = h.object; while (o && o.userData.propId == null) o = o.parent; if (o && !props.get(o.userData.propId)?.data.generated) return o.userData.propId; } // (ring props belong to their directive)
  return null;
}
function freeSeat(propId) {
  const pr = props.get(propId); if (!pr) return -1;
  const used = new Set(rec.actors.filter((a) => a.seat?.prop === propId).map((a) => a.seat.idx));
  for (let i = 0; i < pr.built.seats.length; i++) if (!used.has(i)) return i;
  return -1;
}
function seatActor(o, propId) {
  const idx = freeSeat(propId); if (idx < 0) { status('no free seat there'); return; }
  const pose = sitPose(o.rig);
  o.data.seat = { prop: propId, idx }; o.sitOffset = null;
  setPose(o, pose, { tween: false });
  place(o); autosave(); renderPanel();
  status(`${o.data.name} sits in the ${PROPS[props.get(propId).data.kind].label.toLowerCase()}`);
}
function standUp(o, quiet) {
  const st = o.data.seat && props.get(o.data.seat.prop)?.built.seats[o.data.seat.idx];
  if (st) { const w = st.getWorldPosition(new THREE.Vector3()), f = new THREE.Vector3(0, 0, 0.7).applyQuaternion(st.getWorldQuaternion(new THREE.Quaternion())); o.data.x = w.x + f.x; o.data.z = w.z + f.z; } // step off, in front of the seat
  o.data.seat = null; o.sitOffset = null; clearPose(o); place(o);
  if (!quiet) { autosave(); renderPanel(); }
}

async function syncActors() {
  for (const a of rec.actors) { resolveCharacter(a); if (!a.seat) { resolvePlace(a); a.x ??= 0; a.z ??= 0; a.rotY ??= 0; a.scale ??= 1; resolveFace(a); } }
  let moved = false;
  for (const a of rec.actors) moved = settle(a) || moved;
  if (moved) autosave();
  const list = [...rec.actors, ...(world ? travellers().actors : [])];
  for (const a of list) if (a.generated) resolveCharacter(a);
  const want = new Set(list.map((a) => a.id));
  for (const [id, o] of actors) if (!want.has(id)) { o.root.removeFromParent(); actors.delete(id); }
  for (const a of list) {
    const o = actors.get(a.id);
    if (o) { o.data = a; place(o); } else await spawnActor(a);
  }
  if (selected && !actors.has(selected)) selected = null;
  compileDirected();
  updateRing();
}
// directed poses ({ preset, look, leftHand… } in the file) compile to bones once everyone is placed
function compileDirected() { for (const o of actors.values()) compileOne(o); }
function compileOne(o) {
  {
    const spec = o.data.pose;
    if (o.data.approach || spec?.clip) { o.compiled = null; o.lookCamera = spec?.look === 'camera'; return; } // (walking toward you, or pose.clip: the clip plays (idle, walk), the look / face / life / twitch ride on it)
    if (!spec || spec.bones || !(spec.preset || spec.look || spec.leftHand || spec.rightHand)) { o.compiled = null; o.lookCamera = false; return; }
    const camHands = ['leftHand', 'rightHand'].filter((k) => spec[k] === 'camera');
    const key = JSON.stringify([spec, o.data.x, o.data.z, o.data.rotY, o.data.seat, camHands.length ? camera.position.toArray().map((v) => Math.round(v * 3)) : 0]);
    o.lookCamera = spec.look === 'camera';
    if (o.compiledKey === key && o.compiled) return;
    o.mixer.stopAllAction(); o.action = null; place(o); o.root.updateWorldMatrix(true, true);
    const T = (k) => {
      if (spec[k] == null) return null;
      if (spec[k] === 'camera') { // a hand held out toward you: at full reach, from the shoulder, straight at the camera
        if (k === 'look') return null;
        const side = k === 'leftHand' ? 'Left' : 'Right', B = o.rig.bones, sh = B[`${side}Arm`].getWorldPosition(new THREE.Vector3());
        const reach = sh.distanceTo(B[`${side}ForeArm`].getWorldPosition(new THREE.Vector3())) + B[`${side}ForeArm`].getWorldPosition(new THREE.Vector3()).distanceTo(B[`${side}Hand`].getWorldPosition(new THREE.Vector3()));
        // (level-ish and a little low: offering, not waving; the camera is usually at or above the shoulder)
        const dir = camera.position.clone().sub(sh); dir.y = Math.min(dir.y, 0) - Math.hypot(dir.x, dir.z) * 0.25; dir.normalize();
        return sh.clone().addScaledVector(dir, reach * 0.9).toArray();
      }
      return resolvePoint(spec[k])?.toArray() || null;
    };
    const preset = spec.preset || (o.data.seat ? 'sit' : 'stand');
    if (spec.bow) { applyPose(o.rig, compilePose(o.rig, { preset, hipsDown: spec.hipsDown, bow: spec.bow })); o.root.updateWorldMatrix(true, true); } // (reach from where the bowed shoulder is)
    // bowed over, a free hand hangs straight down from its shoulder (left to the body it swung round behind the back)
    const hang = (k) => { if (!spec.bow || spec[k] != null) return T(k); const side = k === 'leftHand' ? 'Left' : 'Right', B = o.rig.bones, sh = B[`${side}Arm`].getWorldPosition(new THREE.Vector3()), fa = B[`${side}ForeArm`].getWorldPosition(new THREE.Vector3()), hd = B[`${side}Hand`].getWorldPosition(new THREE.Vector3()); return sh.clone().add(new THREE.Vector3(0, -(sh.distanceTo(fa) + fa.distanceTo(hd)) * 0.97, 0)).toArray(); };
    o.compiled = compilePose(o.rig, { preset, bow: spec.bow, hipsDown: spec.hipsDown, look: T('look'), leftHand: hang('leftHand'), rightHand: hang('rightHand'), leftElbow: T('leftElbow'), rightElbow: T('rightElbow'), leftGrip: spec.leftGrip, rightGrip: spec.rightGrip, leftAim: T('leftAim'), rightAim: T('rightAim'), leftPalmDown: spec.leftPalmDown, rightPalmDown: spec.rightPalmDown, leftFoot: T('leftFoot'), rightFoot: T('rightFoot') });
    o.compiledKey = key; o.data.breathe ??= true; o.sitOffset = null; place(o);
  }
}
const rawPose = (o) => o.compiled || (o.data.pose?.bones ? o.data.pose : null);
// hands held out to the camera follow it (re-aimed when it has moved ~30 cm; the IK is cheap)
// holdCamera: the character holds the camera in both hands, as if it were an object (pose.holdCamera: true or
// { spread, low, ahead, squeeze }): the hands at the sides of the frame, just in front of the lens, fingers
// clawed round it, the grip tightening and trembling; as the camera comes in, the elbows fold. Per frame, after
// the pose and life, before the look: wherever the camera goes, the hands are on it.
function holdCam(t) {
  for (const o of actors.values()) {
    const hc = o.data.pose?.holdCamera; if (!hc || !o.root.visible) continue;
    const c = typeof hc === "object" ? hc : {}, spread = c.spread ?? 0.085, low = c.low ?? 0.05, ahead = c.ahead ?? 0.2, sq = c.squeeze ?? 1; // (metres in the camera frame: at 20 cm ahead, the frame edge is ~7 cm out: the hands sit on it)
    const ctx = dragStart(o.rig); ctx.poles = { LeftHand: new THREE.Vector3(0.8, -1, -0.3), RightHand: new THREE.Vector3(-0.8, -1, -0.3) }; // (elbows down and out: the arms come up from below, never across the face)
    for (const [name, sx] of [['LeftHand', 1], ['RightHand', -1]]) {
      // steady, no tremble (that read as jiggling): the grip only tightens slowly
      const off = new THREE.Vector3(-sx * spread, -low, -ahead);
      dragHandle(o.rig, name, toRoot(o.rig, off.applyQuaternion(camera.quaternion).add(camera.position)), ctx);
      // the hand turned so its fingers point at the lens (wrapping round it), not bent back at the wrist
      const side = name.startsWith('Left') ? 'Left' : 'Right', hand = o.rig.bones[name], mid = o.rig.bones[`${side}HandMiddle1`];
      if (mid) {
        o.rig.root.updateMatrixWorld(true);
        const H = hand.getWorldPosition(new THREE.Vector3()), d = mid.getWorldPosition(new THREE.Vector3()).sub(H).normalize();
        const want = camera.position.clone().addScaledVector(new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion), -0.06).sub(H).normalize();
        const q = new THREE.Quaternion().setFromUnitVectors(d, want).multiply(hand.getWorldQuaternion(new THREE.Quaternion()));
        hand.quaternion.copy(hand.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(q)); hand.updateMatrixWorld(true);
      }
      const g = 0.8 + 0.2 * sq * Math.min(1, (t % 1000) * 0 + 1);
      curlFingers(o.rig, side, { Index: [0.6 * g, 1.1 * g, 0.8 * g], Middle: [0.7 * g, 1.1 * g, 0.8 * g], Ring: [0.8 * g, 1.1 * g, 0.8 * g], Pinky: [0.9 * g, 1.0 * g, 0.7 * g], Thumb: [0.4 * g, 0.6 * g, 0.4 * g] });
    }
    o.rig.root.updateMatrixWorld(true);
  }
}
// Hands (hands.js presets, editable in hands/*.json):
//   pose.hands = { left / right: "fist" | "point" | ... }: a hand shape, nothing reached for
//   pose.grip = { leftHand / rightHand: { at, toward, palm, preset, around, elbow } }: a hand holding on to
//     something. The wrist goes to `at` (two-bone IK, the elbow bending toward `elbow`, a direction [x, y, z],
//     default out and down, so arms never lock straight), the hand turns so its fingers point at `toward` and
//     its palm faces `palm` (a grip needs both), then the preset shapes the fingers ("grab" curls each round
//     `around`, the held shape: { ring | rail | sphere | plane }, stopping where it touches)
//   a "rub" preset (either hand) brings both hands together in front of the chest, palms rubbing
// Applied every frame after the pose and life, like holdCamera.
function orientHand(o, side, toward, palm) {
  const hand = o.rig.bones[`${side}Hand`], mid = o.rig.bones[`${side}HandMiddle1`]; if (!mid || !toward) return;
  o.rig.root.updateMatrixWorld(true);
  const H = hand.getWorldPosition(new THREE.Vector3()), d = mid.getWorldPosition(new THREE.Vector3()).sub(H).normalize(), want = toward.clone().sub(H).normalize();
  let q = new THREE.Quaternion().setFromUnitVectors(d, want);
  const ix = o.rig.bones[`${side}HandIndex1`], pk = o.rig.bones[`${side}HandPinky1`];
  if (palm && ix && pk) { // rolled about the fingers so the palm faces `palm`
    const across = ix.getWorldPosition(new THREE.Vector3()).sub(pk.getWorldPosition(new THREE.Vector3())).applyQuaternion(q);
    const palmNow = new THREE.Vector3().crossVectors(want, across).multiplyScalar(side === 'Left' ? 1 : -1).projectOnPlane(want).normalize(); // (measured: the side the fingers fold to)
    const palmWant = palm.clone().projectOnPlane(want).normalize();
    const roll = Math.atan2(new THREE.Vector3().crossVectors(palmNow, palmWant).dot(want), palmNow.dot(palmWant));
    q = new THREE.Quaternion().setFromAxisAngle(want, roll).multiply(q);
  }
  q.multiply(hand.getWorldQuaternion(new THREE.Quaternion()));
  hand.quaternion.copy(hand.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(q)); hand.updateMatrixWorld(true);
}
const presetOf = (n) => (n && HAND_PRESETS[n]) || null;
function gripHands(t = 0) {
  for (const o of actors.values()) {
    const sp = o.data.pose, gp = sp?.grip, hs = sp?.hands; if ((!gp && !hs) || !o.root.visible) continue;
    const spec = { LeftHand: gp?.leftHand, RightHand: gp?.rightHand };
    const rub = [gp?.leftHand?.preset, gp?.rightHand?.preset, hs?.left, hs?.right].map(presetOf).find((p) => p?.rub);
    if (rub) { // both hands together in front of the chest, palms rubbing, a slow back and forth
      o.root.updateMatrixWorld(true);
      const rq = o.root.getWorldQuaternion(new THREE.Quaternion()), fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(rq), left = new THREE.Vector3(1, 0, 0).applyQuaternion(rq), up = new THREE.Vector3(0, 1, 0);
      const k = o.data.scale || 1, chest = o.rig.bones.Spine2.getWorldPosition(new THREE.Vector3()), base = chest.addScaledVector(fwd, 0.32 * k).addScaledVector(up, -0.12 * k), sl = Math.sin(t * 7) * 0.035 * k;
      for (const [name, sx] of [['LeftHand', 1], ['RightHand', -1]]) {
        const at = base.clone().addScaledVector(left, sx * 0.03 * k).addScaledVector(up, sx * sl);
        spec[name] = { at: at.toArray(), toward: at.clone().addScaledVector(fwd, 0.2).addScaledVector(up, 0.15).toArray(), palm: left.clone().multiplyScalar(-sx).toArray(), preset: Object.keys(HAND_PRESETS).find((n) => HAND_PRESETS[n] === rub), elbow: [sx * 0.7, -1, -0.3] };
      }
    }
    const ctx = dragStart(o.rig); ctx.poles = {};
    for (const name of ['LeftHand', 'RightHand']) { const g = spec[name]; if (g) ctx.poles[name] = new THREE.Vector3(...(g.elbow || [name === 'LeftHand' ? 0.7 : -0.7, -1, -0.2])); }
    for (const name of ['LeftHand', 'RightHand']) {
      const side = name.startsWith('Left') ? 'Left' : 'Right', g = spec[name];
      if (g) {
        const at = resolvePoint(g.at); if (!at) continue;
        dragHandle(o.rig, name, toRoot(o.rig, at.clone()), ctx);
        orientHand(o, side, g.toward ? resolvePoint(g.toward) : null, g.palm ? new THREE.Vector3(...g.palm) : null);
        if (g.preset) applyHand(o.rig, side, g.preset, { around: g.around });
        else { const c = g.curl ?? 0.9; curlFingers(o.rig, side, { Index: [0.7 * c, 1.1 * c, 0.8 * c], Middle: [0.75 * c, 1.15 * c, 0.8 * c], Ring: [0.8 * c, 1.15 * c, 0.8 * c], Pinky: [0.85 * c, 1.05 * c, 0.7 * c], Thumb: [0.5 * c, 0.6 * c, 0.4 * c] }); }
      } else if (hs?.[side.toLowerCase()]) applyHand(o.rig, side, hs[side.toLowerCase()]);
    }
    o.rig.root.updateMatrixWorld(true);
  }
}
// follow (a prop's "follow": an actor id): the prop sits at that actor's face, every frame (a sun's rays round its
// face, wherever the head is put or turns). The face's middle is measured once on its mesh, kept in the head bone's
// frame, so it moves with the head
function followFace(pr) {
  const id = pr.data.follow; if (!id) return;
  const o = actors.get(id); if (!o) return;
  const head = o.rig.bones.Head; if (!head) return;
  if (!o.faceOffset) {
    let face = null; o.root.traverse((m) => { if (m.isSkinnedMesh && (m.userData.drawnMaterial || m.material)?.name === 'face') face = m; });
    if (!face) return;
    o.root.updateMatrixWorld(true);
    const bb = new THREE.Box3(), v = new THREE.Vector3();
    for (const i of new Set(face.geometry.index.array)) { face.getVertexPosition(i, v); bb.expandByPoint(v.applyMatrix4(face.matrixWorld)); }
    o.faceOffset = head.worldToLocal(bb.getCenter(new THREE.Vector3()));
  }
  o.root.updateMatrixWorld(true);
  const w = head.localToWorld(o.faceOffset.clone());
  pr.built.group.parent?.worldToLocal(w); pr.built.group.position.copy(w);
}
// onProp (an actor's "onProp": { prop, anchor, offset }): its face held at that prop anchor every frame (a person's
// face on a rocking horse's head, at a pinwheel's hub, on a tea-party chair), after the heads have turned
function faceOnProp(o) {
  const op = o.data.onProp; if (!op) return;
  const pr = props.get(op.prop), a = pr?.built.anchors?.[op.anchor]; if (!a) return;
  const head = o.rig.bones.Head; if (!head) return;
  if (!o.faceOffset) {
    let face = null; o.root.traverse((m) => { if (m.isSkinnedMesh && (m.userData.drawnMaterial || m.material)?.name === 'face') face = m; });
    if (!face) return;
    o.root.updateMatrixWorld(true);
    const bb = new THREE.Box3(), v = new THREE.Vector3();
    for (const i of new Set(face.geometry.index.array)) { face.getVertexPosition(i, v); bb.expandByPoint(v.applyMatrix4(face.matrixWorld)); }
    o.faceOffset = head.worldToLocal(bb.getCenter(new THREE.Vector3()));
  }
  o.root.updateMatrixWorld(true); a.updateWorldMatrix(true, false);
  const want = a.localToWorld(new THREE.Vector3(...(op.offset || [0, 0, 0]))), now = head.localToWorld(o.faceOffset.clone());
  o.root.position.add(want.sub(now)); o.root.updateMatrixWorld(true);
}
function reachCamera() {
  for (const o of actors.values()) {
    const sp = o.data.pose; if (!sp || (sp.leftHand !== 'camera' && sp.rightHand !== 'camera' && sp.turn !== 'camera')) continue;
    const k = JSON.stringify(camera.position.toArray().map((v) => Math.round(v * 3)));
    if (o.camKey !== k) {
      o.camKey = k;
      if (sp.turn === 'camera' && !o.data.seat) o.baseRotY ??= o.data.rotY; // (shots placed relative to him use where he stood, or camera and body chase each other round)
      if (sp.turn === 'camera' && !o.data.seat) o.data.rotY = Math.atan2(camera.position.x - o.data.x, camera.position.z - o.data.z) + (sp.turnOffset || 0); // (the body turns to you, turnOffset radians off it: the curl reads in silhouette)
      compileOne(o);
    }
  }
}

// ---------------- load / reload ----------------
let loadedId = null;
async function load(fresh = true) {
  rec = await currentScene();
  if (rec.id !== loadedId) { resolvedDirectives = []; loadedId = rec.id; for (const o of actors.values()) o.root.removeFromParent(); actors.clear(); selected = null; } // (a new scene: fresh actors; reusing them by id carried the last scene's pose, frozen, into this one)
  rec.actors ||= []; rec.props ||= []; rec.shots ||= []; rec.ambience ||= {};
  if (fresh || !library.length) await refreshLibrary();
  renderPoses();
  let rebuilt = buildTerrain(false);
  syncProps();
  await syncActors();
  if (applySceneDirectives()) rebuilt = true;
  await syncActors(); // (re-seated on the reshaped land; travellers placed along its roads)
  if (fresh || rebuilt) { resetCamera(); stage.drawCard(rec.name || world.name); }
  if (fresh) { stopBeds(); ambienceArmed = false; }
  syncAmbience();
  renderPanel();
}
if (!PLAYER) onSceneChange(() => load(false)); // e.g. a character was sent from another tab
// the scene file changed on disk (edited by hand / by Claude): reload it, unless this tab has unsaved edits
import.meta.hot?.on('scenes:changed', async ({ file }) => {
  if (PLAYER) { if (rec && file === `${rec.id}.json`) P.reload(); return; } // (the live view follows edits to its scene)
  if (!rec || file !== `${rec.id}.json` || saveT) { if (file !== `${rec?.id}.json`) renderScenes(); return; }
  const disk = await fetch(`/__scenes/${rec.id}`).then((r) => (r.ok ? r.text() : null)).catch(() => null);
  if (!disk) return;
  let text; try { text = JSON.stringify(JSON.parse(disk), null, 2) + '\n'; } catch { status(`scenes/${rec.id}.json has an error: fix it and save`); return; }
  if (text === writtenText(rec.id)) return; // our own save coming back
  await load(false); status(`scenes/${rec.id}.json changed on disk: reloaded`);
});

// ---------------- camera ----------------
// Fly: WASD / arrows move level (gliding over the terrain at your height), Space up, C down, Shift fast, Alt slow,
// 1-5 speed presets. Look: hold the right button (the mouse is locked, so it never hits the screen edge).
// Wheel zooms toward the cursor · drag empty ground orbits around the point you grabbed · middle-drag (or
// Shift+drag) pans · double-click flies to a spot or a character · F frames the selection · Home resets · H help.
const SPEEDS = [1.5, 4, 8, 16, 40];
const EYE = 0.85; // default travel height above the ground: low, about a child's (or a crouching person's) eye level
const cam = { pos: new THREE.Vector3(), yaw: 0, pitch: -0.25, speed: 8, vel: new THREE.Vector3(), agl: EYE, tween: null };
let walking = false; const me = { x: 0, z: 0, y: 0, yaw: 0, pitch: 0, phase: 0 }; const keys = new Set();
const fwd = (out = new THREE.Vector3()) => out.set(-Math.sin(cam.yaw) * Math.cos(cam.pitch), Math.sin(cam.pitch), -Math.cos(cam.yaw) * Math.cos(cam.pitch));
const right = (out = new THREE.Vector3()) => out.set(Math.cos(cam.yaw), 0, -Math.sin(cam.yaw));
const groundAt = (p) => world.height(p.x, p.z);
const syncAgl = () => { cam.agl = Math.max(0.4, cam.pos.y - groundAt(cam.pos)); };
function lookAtPoint(p, from = cam.pos) { const d = p.clone().sub(from); return { yaw: Math.atan2(-d.x, -d.z), pitch: Math.atan2(d.y, Math.hypot(d.x, d.z)) }; }
function aimAt(p) { const a = lookAtPoint(p); cam.yaw = a.yaw; cam.pitch = a.pitch; }
// smooth flight to a new viewpoint (framing, double-click, reset); any movement key takes over
function flyTo(pos, look, dur = 0.6) {
  const a = lookAtPoint(look, pos);
  let dy = a.yaw - cam.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy)); // turn the short way round
  cam.tween = { p0: cam.pos.clone(), p1: pos, y0: cam.yaw, y1: cam.yaw + dy, q0: cam.pitch, q1: a.pitch, t: 0, dur };
  cam.vel.set(0, 0, 0);
}
function resetCamera(instant = true) {
  const y = world.homeYaw, fx = -Math.sin(y), fz = -Math.cos(y);
  const pos = new THREE.Vector3(-fx * 4, world.floor(-fx * 4, -fz * 4) + EYE, -fz * 4); // behind the spawn, at eye height
  const look = new THREE.Vector3(fx * 7, world.floor(fx * 7, fz * 7) + 0.8, fz * 7); // where sent characters stand
  cam.agl = EYE;
  if (instant) { cam.pos.copy(pos); aimAt(look); cam.tween = null; } else flyTo(pos, look);
  me.x = 0; me.z = 0; me.y = world.floor(0, 0); me.yaw = y; me.pitch = 0.02;
}
let rmb = false;
function placeCamera(dt) {
  if (walking) {
    const f = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
    const s = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
    const crouch = !!me.crouched; // C toggles: crouched to half your height, moving at half speed
    const sp = (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 4.6 : 2.1) * (crouch ? 0.5 : 1), fx = -Math.sin(me.yaw), fz = -Math.cos(me.yaw);
    if (f || s) {
      const l = Math.hypot(f, s), dx = ((fx * f - fz * s) / l) * sp * dt, dz = ((fz * f + fx * s) / l) * sp * dt;
      if (world.walkable(me.x + dx, me.z)) me.x += dx;
      if (world.walkable(me.x, me.z + dz)) me.z += dz;
      for (const [cx, cz, cr] of world.solids) { const ox = me.x - cx, oz = me.z - cz, d = Math.hypot(ox, oz), R = cr + 0.3; if (d < R && d > 1e-6) { me.x = cx + (ox / d) * R; me.z = cz + (oz / d) * R; } }
      me.phase += dt * sp * 2.6;
    }
    me.y += (world.floor(me.x, me.z) - me.y) * Math.min(1, dt * 12);
    me.eyeH = (me.eyeH ?? 1.62) + ((crouch ? 0.81 : 1.62) - (me.eyeH ?? 1.62)) * Math.min(1, dt * 10);
    const eye = me.y + me.eyeH + Math.sin(me.phase) * 0.035 * (f || s ? 1 : 0) * (crouch ? 0.5 : 1);
    camera.position.set(me.x, eye, me.z);
    camera.lookAt(me.x + fx * Math.cos(me.pitch), eye + Math.sin(me.pitch), me.z + fz * Math.cos(me.pitch));
    return;
  }
  const k = (c) => (keys.has(c) ? 1 : 0);
  const f = k('KeyW') + k('ArrowUp') - k('KeyS') - k('ArrowDown'), s = k('KeyD') + k('ArrowRight') - k('KeyA') - k('ArrowLeft');
  const u = k('Space') - k('KeyC') + (rmb || !selected ? k('KeyE') - k('KeyQ') : 0); // Space up, C down; Q/E turn a selected character unless you're looking
  // (fly: no crouch; C is "down", see u)
  const crouch = crouchOn ? 1 : 0;
  if (crouch !== cam.crouched) { cam.crouched = crouch; cam.easeH = true; }
  if ((f || s || u) && cam.tween) cam.tween = null;
  if (cam.tween) { // flying to a viewpoint
    const T = cam.tween; T.t = Math.min(1, T.t + dt / T.dur); const e = T.t * T.t * (3 - 2 * T.t);
    cam.pos.lerpVectors(T.p0, T.p1, e); cam.yaw = T.y0 + (T.y1 - T.y0) * e; cam.pitch = T.q0 + (T.q1 - T.q0) * e;
    if (T.t >= 1) cam.tween = null;
  } else {
    // level movement with a little inertia: velocity eases toward what the keys ask for
    const boost = (k('ShiftLeft') || k('ShiftRight') ? 3 : 1) * (k('AltLeft') || k('AltRight') ? 0.3 : 1), sp = cam.speed * boost;
    const fh = new THREE.Vector3(-Math.sin(cam.yaw), 0, -Math.cos(cam.yaw));
    const want = fh.multiplyScalar(f).addScaledVector(right(), s); if (want.lengthSq() > 1) want.normalize();
    want.multiplyScalar(sp); want.y = u * sp * 0.8;
    cam.vel.lerp(want, 1 - Math.exp(-dt * (want.lengthSq() ? 9 : 6)));
    if (cam.vel.lengthSq() < 1e-6) cam.vel.set(0, 0, 0);
    cam.pos.addScaledVector(cam.vel, dt);
    // walking-flight: WASD glides over the terrain at the travel height (eye level unless Space / C changed it);
    // after orbiting or zooming somewhere else, the first steps ease you back down (or up) to it
    if (u) { syncAgl(); if (crouch) cam.agl *= 2; } // raising while crouched keeps the crouch a half of it
    else if (f || s || cam.easeH) {
      const target = groundAt(cam.pos) + cam.agl * (crouch ? 0.5 : 1);
      cam.pos.y += (target - cam.pos.y) * Math.min(1, dt * (cam.easeH && !f && !s ? 8 : 4));
      if (Math.abs(target - cam.pos.y) < 0.005) cam.easeH = false;
    }
  }
  const minY = groundAt(cam.pos) + 0.4; if (cam.pos.y < minY) cam.pos.y = minY; // never under the ground
  camera.position.copy(cam.pos);
  camera.lookAt(cam.pos.clone().add(fwd()));
  hud();
}
// the point the camera is looking at: ground under the screen centre (or 12 m ahead)
function pivotPoint() {
  ray.setFromCamera(new THREE.Vector2(0, 0), camera);
  const t = world.group.getObjectByName('terrain'), h = t && ray.intersectObject(t, false)[0];
  return h && h.distance < 200 ? h.point : cam.pos.clone().addScaledVector(fwd(), 12);
}
// frame a character: fly to a spot a few metres off, a little above, looking at its chest
function frameActor(id) {
  const o = actors.get(id); if (!o) return;
  const p = o.rig.bones.Hips.getWorldPosition(new THREE.Vector3()); p.y += 0.25 * o.data.scale; // chest-ish, sitting or standing
  const d = Math.max(3.5, 4 * o.data.scale), dir = new THREE.Vector3(-Math.sin(cam.yaw), 0, -Math.cos(cam.yaw));
  const to = p.clone().addScaledVector(dir, -d); to.y = Math.max(p.y + d * 0.3, groundAt(to) + 0.6);
  flyTo(to, p);
}
// the Camera section of the panel: speed + the controls (H folds the list)
let hudOpen = true, hudTxt = '';
let sens = 1; try { sens = +localStorage.getItem('dreamare.editor.sens') || 1; } catch { /* no storage: default */ }
function hud() {
  const el = $('#camHud'); if (!el) return;
  const txt = `<p class="meta"><b>speed ${cam.speed.toFixed(1)} m/s</b> · keys 1-5 set it<br><b>height ${(cam.agl * (cam.crouched ? 0.5 : 1)).toFixed(2)} m</b>${cam.crouched ? ' (crouching)' : ''} · Space up · C: crouch on / off · Home resets</p>` + (hudOpen
    ? '<table class="keys"><tr><td>drag</td><td>turn</td></tr><tr><td>W A S D</td><td>move</td></tr><tr><td>Space</td><td>up</td></tr><tr><td>C</td><td>crouch on / off (half height)</td></tr><tr><td>wheel</td><td>forward / back</td></tr><tr><td>Shift / Alt</td><td>fast / slow</td></tr><tr><td>click</td><td>select a character</td></tr><tr><td>drag selected</td><td>move it · Q / E turn it</td></tr><tr><td>Alt + drag</td><td>orbit</td></tr><tr><td>middle / Shift + drag</td><td>pan</td></tr><tr><td>double-click</td><td>fly there</td></tr><tr><td>F · Home</td><td>frame selected · reset view</td></tr><tr><td>H</td><td>hide this list</td></tr></table>'
    : '<p class="meta">H shows the controls</p>');
  if (txt !== hudTxt) { el.querySelector('.hudtext') ? (el.querySelector('.hudtext').innerHTML = txt) : (el.innerHTML = `<div class="row"><span>mouse sensitivity</span><input type="range" min="0.2" max="3" step="0.05"><output></output></div><div class="hudtext">${txt}</div>`); hudTxt = txt; bindSens(el); }
}
function bindSens(el) {
  const input = el.querySelector('input[type=range]'); if (!input || input.dataset.bound) return;
  input.dataset.bound = 1; input.value = sens; el.querySelector('output').textContent = sens.toFixed(2);
  input.oninput = () => { sens = +input.value; el.querySelector('output').textContent = sens.toFixed(2); try { localStorage.setItem('dreamare.editor.sens', sens); } catch { /* ignore */ } };
}

// ---------------- picking and dragging ----------------
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
function setRay(e) { const r = canvas.getBoundingClientRect(); ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); ray.setFromCamera(ndc, camera); }
// characters: nearest to the ray along a 1.8 m standing segment (skinned meshes don't raycast their pose well)
function pickActor() {
  let best = null, bd = 0.7;
  const P = new THREE.Vector3(), Q = new THREE.Vector3();
  for (const [id, o] of actors) {
    if (o.data.generated) continue; // (travellers belong to their directive)
    // the body as it really stands (or sits): feet-level under the hips up to the head, in world space
    o.root.updateWorldMatrix(true, true); // the whole chain: seat -> rocking part -> prop above, bones below (all current)
    const s = o.data.scale, hips = o.rig.bones.Hips.getWorldPosition(new THREE.Vector3()), head = o.rig.bones.Head.getWorldPosition(new THREE.Vector3());
    const base = hips.clone().lerp(head, -0.9); base.y = Math.min(base.y, o.root.getWorldPosition(new THREE.Vector3()).y + 0.05);
    // three can return a tiny negative squared distance when the ray passes (almost) exactly through the
    // segment; its square root is NaN and would fail every comparison: a dead-centre click missing
    const d = Math.sqrt(Math.max(0, ray.ray.distanceSqToSegment(base, head.clone().add(new THREE.Vector3(0, 0.15 * s, 0)), P, Q)));
    if (d < bd * s) { bd = d / s; best = id; }
  }
  return best;
}
function groundPoint() { const t = world.group.getObjectByName('terrain'); const h = t && ray.intersectObject(t, false)[0]; return h ? h.point : null; }

let drag = null; // { kind: 'orbit' | 'pan' | 'look' | 'move', x, y, moved, pivot }
// what's under the cursor: terrain hit, or a point at the pivot distance along the ray
function cursorPoint() { const p = groundPoint(); return p && p.distanceTo(cam.pos) < 250 ? p : null; }
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  if (walking) { if (document.pointerLockElement !== canvas) canvas.requestPointerLock?.(); return; }
  canvas.setPointerCapture(e.pointerId);
  document.activeElement?.blur?.();
  setRay(e);
  cam.tween = null;
  // one rule: dragging turns the camera. Clicking (no drag) selects. Only an already-selected character can be
  // dragged along the ground, and pose handles only exist while editing a pose. Alt orbits, middle / Shift pans.
  if (e.button === 1 || (e.button === 0 && e.shiftKey)) { e.preventDefault(); drag = { kind: 'pan', x: e.clientX, y: e.clientY, moved: false, pivot: cursorPoint() || pivotPoint() }; return; }
  if (e.button === 0 && e.altKey) {
    const sel = selected && actors.get(selected);
    drag = { kind: 'orbit', x: e.clientX, y: e.clientY, moved: false, pivot: sel ? sel.root.position.clone().add(new THREE.Vector3(0, 1, 0)) : pivotPoint() };
    return;
  }
  if (e.button === 0) { const h = pickHandle(); if (h) { startHandleDrag(h, e); return; } }
  const hit = e.button === 0 ? pickActor() : null, phit = e.button === 0 && !hit ? pickProp() : null;
  if (e.button === 2) rmb = true;
  const isLocked = (hit && actors.get(hit)?.data.locked) || (phit && props.get(phit)?.data.locked); // (locked: it can't be dragged, turned or deleted by accident)
  const grab = !isLocked && ((hit && hit === selected) || (phit && phit === selectedProp));
  if (isLocked && ((hit && hit === selected) || (phit && phit === selectedProp))) status('locked: unlock it in the panel to move it');
  drag = { kind: grab ? 'move' : 'look', x: e.clientX, y: e.clientY, moved: false, hit, phit, button: e.button };
});
canvas.addEventListener('pointermove', (e) => {
  if (walking && document.pointerLockElement === canvas) { me.yaw -= e.movementX * 0.0025; me.pitch = Math.max(-1.2, Math.min(1.2, me.pitch - e.movementY * 0.0022)); return; }
  if (hdrag) { moveHandleDrag(e); return; }
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (!drag.moved && Math.hypot(e.clientX - (drag.x0 ??= drag.x), e.clientY - (drag.y0 ??= drag.y)) < 4) return; // a click, not a drag (yet)
  drag.moved = true; drag.x = e.clientX; drag.y = e.clientY;
  if (drag.kind === 'look') { const k = 0.0015 * sens; cam.yaw -= dx * k; cam.pitch = Math.max(-1.45, Math.min(1.45, cam.pitch - dy * k)); cam.tween = null; }
  else if (drag.kind === 'orbit') { // swing the camera around the pivot, keep looking at it
    const P = drag.pivot, off = cam.pos.clone().sub(P), r = Math.max(0.5, off.length());
    const yaw = Math.atan2(off.x, off.z) - dx * 0.0025 * sens, pitch = Math.max(-0.1, Math.min(1.5, Math.asin(Math.max(-1, Math.min(1, off.y / r))) + dy * 0.002 * sens));
    cam.pos.set(P.x + Math.sin(yaw) * Math.cos(pitch) * r, P.y + Math.sin(pitch) * r, P.z + Math.cos(yaw) * Math.cos(pitch) * r);
    aimAt(P);
  } else if (drag.kind === 'pan') { // grab the world: it moves with the mouse at the grabbed point's distance
    const kk = cam.pos.distanceTo(drag.pivot) * 0.0015, up = new THREE.Vector3().crossVectors(right(), fwd()).normalize();
    cam.pos.addScaledVector(right(), -dx * kk).addScaledVector(up, dy * kk);
  } else if (drag.kind === 'move' && (selected || selectedProp)) {
    setRay(e); const p = groundPoint();
    if (p && selectedProp) { const pr = props.get(selectedProp); delete pr.data.place; pr.data.x = p.x; pr.data.z = p.z; placeProp(pr); updateRing(); }
    else if (p) { const o = actors.get(selected); if (o.data.seat) standUp(o, true); delete o.data.place; delete o.data.face; o.data.x = p.x; o.data.z = p.z; place(o); updateRing(); }
  }
});
const endLook = () => { rmb = false; };
canvas.addEventListener('pointerup', (e) => {
  if (e.button === 2) endLook();
  if (hdrag) { hdrag = null; autosave(); renderActorBox(); return; } // refresh: the character now has a custom pose
  if (drag && !drag.moved && drag.button === 0 && (drag.kind === 'look' || drag.kind === 'move')) { // a click selects (or deselects on empty ground)
    if (picking) { if (drag.hit) { seatActor(actors.get(drag.hit), picking.propId); endPicking(); } else { endPicking(); status('cancelled'); } }
    else if (drag.phit) selectProp(drag.phit);
    else select(drag.hit || null);
  }
  if (drag && !drag.moved && drag.button === 2) openMenu(e); // right click (not a drag): the context menu
  if (drag?.kind === 'move' && drag.moved) { autosave(); renderActorBox(); }
  drag = null;
});
addEventListener('mouseup', (e) => { if (e.button === 2 && rmb) endLook(); }); // released outside the canvas / under pointer lock
// wheel: zoom toward what's under the cursor, in steps that scale with the distance (never through it)
canvas.addEventListener('wheel', (e) => {
  e.preventDefault(); if (walking) return;
  if (rmb) { cam.speed = Math.max(0.5, Math.min(80, cam.speed * Math.exp(-e.deltaY * 0.002))); return; }
  // straight forward / back along the view, a fixed step that follows the fly speed (predictable, no jumps)
  cam.tween = null;
  const step = Math.min(12, Math.max(0.3, cam.speed * 0.3)) * Math.sign(-e.deltaY) * Math.min(2, Math.max(0.5, Math.abs(e.deltaY) / 100));
  cam.pos.addScaledVector(fwd(), step);
}, { passive: false });
// double-click: a character -> frame it; the ground -> fly over to look at that spot
canvas.addEventListener('dblclick', (e) => {
  if (walking) return;
  setRay(e);
  const hit = pickActor(); if (hit) { select(hit); frameActor(hit); return; }
  const P = cursorPoint(); if (!P) return;
  const dir = P.clone().sub(cam.pos); dir.y = 0; dir.normalize();
  const to = P.clone().addScaledVector(dir, -9); to.y = Math.max(P.y + 3.5, groundAt(to) + 1);
  flyTo(to, P.clone().add(new THREE.Vector3(0, 0.8, 0)));
});
let crouchOn = false;
const FLY = /^(Key[WASDQEC]|Space|Arrow(Up|Down|Left|Right)|Shift(Left|Right)|Alt(Left|Right))$/;
addEventListener('keydown', (e) => {
  if (e.target.closest?.('input[type=text], input:not([type]), select, textarea')) return; // typing a name
  if (e.target.tagName === 'BUTTON' || e.target.type === 'checkbox' || e.target.type === 'range') e.target.blur(); // keys fly the camera, they don't press panel controls
  if (e.code === 'KeyC' && !e.repeat && walking) me.crouched = !me.crouched; // walk mode: C toggles a crouch (in free fly, holding C goes down, like Space goes up)
  if (FLY.test(e.code)) { keys.add(e.code); if (e.code.startsWith('Arrow') || e.code === 'Space' || e.code.startsWith('Alt')) e.preventDefault(); }
  if (walking) return;
  if (/^Digit[1-5]$/.test(e.code)) { cam.speed = SPEEDS[+e.code.slice(5) - 1]; }
  if (e.code === 'KeyH') { hudOpen = !hudOpen; }
  if (e.code === 'Home') { resetCamera(false); }
  if (e.code === 'Escape') { closeMenu(); if (picking) { endPicking(); status('cancelled'); } }
  if (e.code === 'KeyP') { $('#playScene').click(); return; } // play / stop the scene
  if (e.code === 'KeyK' && !e.repeat) { takeShot(); return; } // snapshot for slides
  if (e.code === 'KeyF' && selected) frameActor(selected);
  const pr = selectedProp && props.get(selectedProp);
  if (pr) {
    if (pr.data.locked) return; // (locked: no turning or deleting from the keyboard)
    if ((e.code === 'KeyQ' || e.code === 'KeyE') && !rmb) { pr.data.rotY += (e.code === 'KeyQ' ? 1 : -1) * (Math.PI / 12); placeProp(pr); autosave(); renderActorBox(); }
    if (e.code === 'Delete' || e.code === 'Backspace') { removeProp(selectedProp); e.preventDefault(); }
    return;
  }
  const o = selected && actors.get(selected); if (!o || o.data.locked) return;
  if ((e.code === 'KeyQ' || e.code === 'KeyE') && !rmb) { const k = o.data.seat ? 'seatRot' : 'rotY'; o.data[k] = (o.data[k] || 0) + (e.code === 'KeyQ' ? 1 : -1) * (Math.PI / 12); place(o); autosave(); renderActorBox(); }
  if (e.code === 'Delete' || e.code === 'Backspace') { removeActor(selected); e.preventDefault(); }
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => { keys.clear(); endLook(); });

// ---------------- pose handles: drag hands, feet, head, chest, hips (IK does the rest) ----------------
let editPose = false, hdrag = null;
const HANDLE_COL = { LeftHand: 0x7fd6ff, RightHand: 0x7fd6ff, LeftFoot: 0x9dff9d, RightFoot: 0x9dff9d, Head: 0xffe07f, Spine2: 0xff9f7f, Hips: 0xff7fd0 };
const handles = new THREE.Group(); handles.visible = false; scene.add(handles); // (hidden until a pose is edited: the player never shows them)
for (const n of Object.keys(HANDLES)) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(n === 'Hips' || n === 'Spine2' ? 0.075 : 0.06, 10, 6), new THREE.MeshBasicMaterial({ color: HANDLE_COL[n], depthTest: false, transparent: true, opacity: 0.9, fog: false }));
  m.name = n; m.renderOrder = 10; handles.add(m);
}
function updateHandles() {
  const o = editPose && selected && actors.get(selected);
  handles.visible = !!o && !walking;
  if (!handles.visible) return;
  o.root.updateMatrixWorld(true);
  for (const m of handles.children) { m.position.copy(toWorld(o.rig, handlePos(o.rig, m.name))); m.scale.setScalar(Math.max(0.6, camera.position.distanceTo(m.position) * 0.12)); }
}
function pickHandle() {
  if (!handles.visible) return null;
  const hits = ray.intersectObjects(handles.children, false);
  return hits[0]?.object.name || null;
}
function startHandleDrag(name, e) {
  const o = actors.get(selected);
  if (o.compiled) { o.data.pose = structuredClone(o.compiled); o.compiled = null; } // editing a directed pose by hand: it becomes a plain pose
  if (!o.data.pose?.bones) setPose(o, snapshot(o.rig), { tween: false }); // editing an animated character: start from its current frame
  applyPose(o.rig, o.data.pose); // clean pose (no breath) under the drag
  const P = toWorld(o.rig, handlePos(o.rig, name));
  hdrag = { o, name, plane: new THREE.Plane().setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()).negate(), P), ctx: { ...dragStart(o.rig), handle0: handlePos(o.rig, name) } };
  status(`dragging ${name.replace('Spine2', 'chest')}`);
}
function moveHandleDrag(e) {
  setRay(e);
  const hit = ray.ray.intersectPlane(hdrag.plane, new THREE.Vector3()); if (!hit) return;
  const { o, name, ctx } = hdrag;
  applyPose(o.rig, o.data.pose);
  dragHandle(o.rig, name, toRoot(o.rig, hit), ctx);
  o.data.pose = snapshot(o.rig); o.tween = null;
}

// selection ring on the ground
const ring = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.7, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xe0b04a, transparent: true, opacity: 0.85, depthWrite: false, fog: false }));
ring.visible = false; scene.add(ring);
let ringWanted = false;
function updateRing() {
  const o = selected && actors.get(selected), pr = selectedProp && props.get(selectedProp);
  ring.visible = ringWanted = !!(o || pr);
  if (o) { const w = o.root.getWorldPosition(new THREE.Vector3()); ring.position.set(w.x, world.height(w.x, w.z) + 0.06, w.z); ring.scale.setScalar(o.data.scale); }
  if (pr) { const g = pr.built.group.position; ring.position.set(g.x, g.y + 0.08, g.z); ring.scale.setScalar(Math.max(0.8, pr.built.radius * 1.4) * (pr.data.scale || 1)); }
}
function select(id) { selected = id; if (id) selectedProp = null; updateRing(); renderActorList(); renderActorBox(); }
function selectProp(id) { selectedProp = id; if (id) selected = null; updateRing(); renderActorList(); renderActorBox(); }
function startPicking(propId) { picking = { propId }; canvas.style.cursor = 'copy'; status('pick a character: click one in the scene or in the list (Esc cancels)'); renderActorList(); }
function endPicking() { picking = null; canvas.style.cursor = ''; renderActorList(); }

function removeActor(id) { stopVoice(id); rec.actors = rec.actors.filter((a) => a.id !== id); const o = actors.get(id); if (o) o.root.removeFromParent(); actors.delete(id); if (selected === id) selected = null; updateRing(); autosave(); renderPanel(); }
async function addActor(charId) {
  const c = await loadChar(charId); if (!c) return;
  const a = newActor(charId, c.name, rec.actors.length); settle(a);
  rec.actors.push(a); await spawnActor(a); select(a.id); autosave(); renderPanel();
}

// ---------------- look at me: head and neck turn to the camera, the eyes finish the job ----------------
// Runs after the clip / pose / breathing each frame, on top of them. The turn eases in and out, stays within a
// human range (75° total, neck a third), and whatever angle is left goes to the eye-look morphs, so the eyes
// meet the lens even past the head's limit. Blinks from the clip are untouched.
const EYES = ['eyeLookLeft', 'eyeLookRight', 'eyeLookUp', 'eyeLookDown'];
const _lq = new THREE.Quaternion(), _lv = new THREE.Vector3(), _lf = new THREE.Vector3();
function eyeMeshes(o) { if (!o.eyes) { o.eyes = []; o.root.traverse((m) => { if (m.morphTargetDictionary && EYES.every((k) => k in m.morphTargetDictionary)) o.eyes.push(m); }); } return o.eyes; }
function turnToward(bone, target, amount, maxAngle) { // rotate a bone (world-space delta) so its +Z heads toward target
  const q = bone.getWorldQuaternion(new THREE.Quaternion()), fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  const want = target.clone().sub(bone.getWorldPosition(new THREE.Vector3())).normalize();
  const full = new THREE.Quaternion().setFromUnitVectors(fwd, want), ang = 2 * Math.acos(Math.min(1, Math.abs(full.w)));
  const k = ang > 1e-4 ? Math.min(1, (maxAngle / ang)) * amount : 0;
  const delta = new THREE.Quaternion().slerp(full, k);
  const parentQ = bone.parent.getWorldQuaternion(new THREE.Quaternion());
  bone.quaternion.copy(parentQ.clone().invert().multiply(delta).multiply(q)).normalize();
  bone.updateMatrixWorld(true);
}
// the point between the eyes, as rendered (the eye landmarks ride the head bone)
function eyeMid(o) {
  if (o.eyeLm === undefined) { const L = o.root.getObjectByName('lm_leftEye'), R = o.root.getObjectByName('lm_rightEye'); o.eyeLm = L && R ? [L, R] : null; }
  if (!o.eyeLm) return null;
  return o.eyeLm[0].getWorldPosition(new THREE.Vector3()).add(o.eyeLm[1].getWorldPosition(new THREE.Vector3())).multiplyScalar(0.5);
}
// (the original look, restored: it worked; every later change to it made it worse)
function updateLook(o, dt) {
  const a = o.data; o.lookW = THREE.MathUtils.clamp((o.lookW || 0) + (a.lookAtMe || o.lookCamera ? dt : -dt) / 0.35, 0, 1);
  if (o.lookW <= 0) { if (o.eyesTouched) { for (const m of eyeMeshes(o)) { for (const k of EYES) m.morphTargetInfluences[m.morphTargetDictionary[k]] = 0; const A = m.userData.eyeAim; if (A) { m.geometry.attributes.position.array.set(A.rest); m.geometry.attributes.position.needsUpdate = true; if (A.restN) { m.geometry.attributes.normal.array.set(A.restN); m.geometry.attributes.normal.needsUpdate = true; } } } o.eyesTouched = false; } return; }
  const w = o.lookW * o.lookW * (3 - 2 * o.lookW), neck = o.rig.bones.Neck, head = o.rig.bones.Head;
  o.root.updateWorldMatrix(true, true);
  const eye = camera.position;
  if (a.pose?.bow) { // bowed into a hook: the neck keeps its curl, the head alone cranes round to face you, crown up
    // (the normal limits can't reach past the hook, and a shortest-arc turn rolled the head onto its side)
    for (let k = 0; k < 2; k++) {
      const hp = head.getWorldPosition(new THREE.Vector3()), E = eyeMid(o) || hp;
      const m = new THREE.Matrix4().lookAt(eye.clone().sub(E).add(hp), hp, new THREE.Vector3(0, 1, 0)); // (aimed from the eyes)
      const cur = head.getWorldQuaternion(new THREE.Quaternion()).slerp(new THREE.Quaternion().setFromRotationMatrix(m), w);
      head.quaternion.copy(head.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(cur)).normalize(); head.updateMatrixWorld(true);
    }
  } else {
    // aimed as if from the eyes (the target shifted by the head pivot's offset from them): from the pivot, low in
    // the neck, a camera close to the face is well above it, the head tipped back and the eyes couldn't look down enough
    const em = eyeMid(o), tgt = em ? eye.clone().add(head.getWorldPosition(new THREE.Vector3()).sub(em)) : eye;
    turnToward(neck, tgt, w * 0.35, 0.45); // neck: a third of the turn, up to ~26°
    turnToward(head, tgt, w, 1.0); // head: the rest, up to ~57° more
  }
  // strain (pose.alive.strain 0..1): the head holding the stare with effort: a fine tremor (6-11 Hz, smooth) and a
  // slow strained drift, the neck fighting it; the eyes (aimed after this) stay locked on you
  const st = a.pose?.alive?.strain;
  if (st) {
    const T = P.curT ?? performance.now() / 1000, n = (f, k) => Math.sin(T * f + k) * 0.55 + Math.sin(T * f * 1.37 + k * 2.3) * 0.3 + Math.sin(T * f * 2.11 + k * 4.1) * 0.15;
    const ax = (bone, x, y, z) => { bone.rotateX(x); bone.rotateY(y); bone.rotateZ(z); bone.updateMatrixWorld(true); };
    ax(head, n(41, 1) * 0.018 * st + n(1.3, 7) * 0.05 * st, n(53, 2) * 0.016 * st + n(0.9, 8) * 0.06 * st, n(47, 3) * 0.02 * st + n(1.1, 9) * 0.07 * st); // (tremor + strained drift)
    ax(neck, n(37, 4) * 0.008 * st, n(1.7, 5) * 0.02 * st, n(43, 6) * 0.01 * st);
  }
  // eyes: what's left, measured in the head's own frame (+Z forward, +X the character's left, +Y up)
  head.getWorldQuaternion(_lq);
  _lv.copy(eye).sub(eyeMid(o) || head.getWorldPosition(_lf)).applyQuaternion(_lq.invert()).normalize(); // (from between the eyes, not the head's pivot low in the neck: up close that aimed the pupils past the camera)
  // the look morphs turn the eyeballs 0.40 rad sideways and 0.32 rad up / down at full weight (faceanim.js)
  const yaw = Math.atan2(_lv.x, _lv.z), pitch = Math.atan2(_lv.y, Math.hypot(_lv.x, _lv.z));
  const look = { eyeLookLeft: Math.max(0, yaw) / 0.4, eyeLookRight: Math.max(0, -yaw) / 0.4, eyeLookUp: Math.max(0, pitch) / 0.32, eyeLookDown: Math.max(0, -pitch) / 0.32 };
  if (aimEyes(o, eye, w)) { for (const m of eyeMeshes(o)) for (const k of EYES) m.morphTargetInfluences[m.morphTargetDictionary[k]] = 0; o.eyesTouched = true; return; }
  for (const m of eyeMeshes(o)) for (const k of EYES) m.morphTargetInfluences[m.morphTargetDictionary[k]] = Math.min(1, look[k]) * w;
  o.eyesTouched = true;
}
// Each eyeball turned on its own centre to point exactly at the target (the eyes converge on it). The look morphs
// turn both balls together, parallel: up close (30 cm) each eye missed the lens by 8-14 degrees and the stare read
// as looking past you. The balls are spheres built facing the mesh's +Z (faceanim.js eyeball), rigid on the head
// bone; so the target is taken into the mesh's bind space and each ball's vertices (and normals) are rotated about
// its centre there. Returns false when the eye mesh isn't one it understands (then the morphs do it).
const _ab = new THREE.Matrix4(), _av = new THREE.Vector3(), _aq = new THREE.Quaternion(), _az = new THREE.Vector3(0, 0, 1);
function aimEyes(o, target, w) {
  let m = o.eyeBall; if (m === undefined) { m = null; o.root.traverse((x) => { if (x.isSkinnedMesh && (x.userData.drawnMaterial || x.material)?.name === 'eye') m = x; }); o.eyeBall = m; } // (the eyeball mesh itself: the look morphs live on more meshes than it)
  if (!m) return false;
  const g = m.geometry, pa = g.attributes.position, na = g.attributes.normal, uv = g.attributes.uv, sw = g.attributes.skinWeight, si = g.attributes.skinIndex;
  if (!m.userData.eyeAim) { // once: the two balls (by texture half), their centres, the rest positions, the bone they ride
    // (the exported mesh shares one vertex list across every part: the eye's own vertices are the ones its triangles use)
    const own = g.index ? [...new Set(g.index.array)] : [...Array(pa.count).keys()];
    const balls = [[0, 0.5], [0.5, 1]].map(([lo, hi]) => own.filter((i) => { const u = uv.getX(i); return u >= lo && u < hi; }));
    if (balls.some((b) => b.length < 8)) return false;
    const rest = pa.array.slice(), restN = na ? na.array.slice() : null;
    const info = balls.map((ids) => { // apex: the frontmost point; radius from the widest ring around it (the cap spans 110 degrees)
      let ap = ids[0]; for (const i of ids) if (pa.getZ(i) > pa.getZ(ap)) ap = i;
      let rr = 0; for (const i of ids) rr = Math.max(rr, Math.hypot(pa.getX(i) - pa.getX(ap), pa.getY(i) - pa.getY(ap)));
      const R = rr / Math.sin((110 * Math.PI) / 180) || rr;
      return { ids, c: new THREE.Vector3(pa.getX(ap), pa.getY(ap), pa.getZ(ap) - R) };
    });
    m.userData.eyeAim = { info, rest, restN, bone: m.skeleton.bones[si.getX(0)], boneIdx: si.getX(0), rigid: sw.getX(0) > 0.99 };
  }
  const A = m.userData.eyeAim; if (!A.rigid) return false;
  // world -> the mesh's bind space, through the bone it rides (skinned = bindMatrixInverse * boneMatrix * bindMatrix * v)
  m.updateMatrixWorld(true); A.bone.updateMatrixWorld(true);
  _ab.copy(m.matrixWorld).multiply(m.bindMatrixInverse).multiply(A.bone.matrixWorld).multiply(m.skeleton.boneInverses[A.boneIdx]).multiply(m.bindMatrix).invert();
  const tb = _av.copy(target).applyMatrix4(_ab);
  for (const { ids, c } of A.info) {
    const dir = tb.clone().sub(c).normalize();
    _aq.setFromUnitVectors(_az, dir); const ang = 2 * Math.acos(Math.min(1, Math.abs(_aq.w)));
    if (ang > 0.6) _aq.slerp(new THREE.Quaternion(), 1 - 0.6 / ang); // (an eye turns ~35 degrees at most)
    const q = new THREE.Quaternion().slerp(_aq, w), v = new THREE.Vector3();
    for (const i of ids) {
      v.set(A.rest[i * 3] - c.x, A.rest[i * 3 + 1] - c.y, A.rest[i * 3 + 2] - c.z).applyQuaternion(q).add(c); pa.setXYZ(i, v.x, v.y, v.z);
      if (A.restN) { v.set(A.restN[i * 3], A.restN[i * 3 + 1], A.restN[i * 3 + 2]).applyQuaternion(q); na.setXYZ(i, v.x, v.y, v.z); }
    }
  }
  pa.needsUpdate = true; if (na) na.needsUpdate = true;
  return true;
}

// ---------------- a face that's alive: a held expression, blinking, muttering, a slow head tilt ----------------
// pose.face: { mouthSmile, browInnerUp, browUp, browDown, mouthPucker, mouthWide, jawOpen, eyeBlinkLeft, … } (0..1)
// pose.alive: { blink: true, mutter: 0..1 (lips moving on their own), sway: 0..1 (the head drifting, tilting), chant: s (mouthing a slow phrase on a loop), wheeze: 0..1 (unhealthy breathing) }
// Driven by time alone, so a snapped frame is exactly the moment it was snapped.
const LIFE = ['jawOpen', 'mouthSmile', 'mouthPucker', 'mouthWide', 'eyeBlinkLeft', 'eyeBlinkRight', 'browUp', 'browDown', 'browInnerUp', 'mouthClose', 'mouthFunnel'];
function lifeMeshes(o) { if (!o.lifeM) { o.lifeM = []; o.root.traverse((m) => { if (m.morphTargetDictionary && 'mouthSmile' in m.morphTargetDictionary) o.lifeM.push(m); }); } return o.lifeM; }
function faceLife(o, t) {
  const spec = o.data.pose, face = spec?.face, alive = spec?.alive;
  if (!face && !alive) { if (o.lifeOn) { for (const m of lifeMeshes(o)) for (const k of LIFE) if (k in m.morphTargetDictionary) m.morphTargetInfluences[m.morphTargetDictionary[k]] = 0; o.lifeOn = false; } return; }
  o.lifeOn = true;
  const ph = (o.data.id.charCodeAt(0) % 11) * 1.7, w = { ...face };
  if (alive?.blink !== false) { // a blink every 3-6 s (irregular, from a hash of the beat), ~0.16 s long
    const beat = 4.2, n = Math.floor((t + ph) / beat), at = n * beat + 1.5 * (((Math.sin(n * 12.9898) * 43758.5453) % 1 + 1) % 1), d = t + ph - at;
    const b = d > 0 && d < 0.16 ? Math.sin((d / 0.16) * Math.PI) : 0;
    w.eyeBlinkLeft = Math.max(w.eyeBlinkLeft || 0, b); w.eyeBlinkRight = Math.max(w.eyeBlinkRight || 0, b);
  }
  if (alive?.mutter && !speaking.has(o.data.id)) { // lips working over words nobody hears
    const m = alive.mutter, on = 0.5 + 0.5 * Math.sin(t * 0.7 + ph); // comes and goes
    w.jawOpen = (w.jawOpen || 0) + m * on * 0.22 * Math.max(0, Math.sin(t * 7.3 + ph) * Math.sin(t * 3.1));
    w.mouthPucker = (w.mouthPucker || 0) + m * on * 0.35 * Math.max(0, Math.sin(t * 5.2 + 1 + ph));
  }
  if (alive?.chant) { // mouthing a phrase on a loop, slow: "re-meeee-mber the duuunes" (alive.chant: seconds per phrase)
    const P = +alive.chant || 4, u = (((t + ph) % P) + P) % P / P;
    const K = [[0, 0.1, 0, 0], [0.06, 0.45, 0.1, 0], [0.12, 0.3, 0.75, 0], [0.5, 0.35, 0.8, 0], [0.56, 0.05, 0, 0.3], [0.62, 0.05, 0, 0.2], [0.66, 0.35, 0.2, 0], [0.72, 0.4, 0, 0.9], [0.9, 0.55, 0, 0.8], [0.95, 0.1, 0, 0], [1, 0.1, 0, 0]]; // [at, jaw, wide, pucker]
    let i = 0; while (K[i + 1][0] < u) i++;
    const [a0, ...A] = K[i], [a1, ...B] = K[i + 1], f = (u - a0) / (a1 - a0 || 1), e = f * f * (3 - 2 * f), mix = (j) => A[j] + (B[j] - A[j]) * e;
    w.jawOpen = Math.max(w.jawOpen || 0, mix(0)); w.mouthWide = Math.max(w.mouthWide || 0, mix(1)); w.mouthPucker = Math.max(w.mouthPucker || 0, mix(2));
  }
  if (o.filmMouth) for (const k of ['jawOpen', 'mouthWide', 'mouthPucker', 'mouthClose', 'mouthFunnel']) w[k] = Math.max(w[k] || 0, o.filmMouth[k] || 0); // (a film's voice: the mouth follows the sound)
  if (alive?.life != null) { const lf = humanLife(o, t, +alive.life, curlFingers); if (lf.still > 0.5) w.eyeBlinkLeft = w.eyeBlinkRight = 0; } // (stopped: not even a blink)
  if (alive?.wheeze) { const g = sickBreath(o, t, +alive.wheeze, ph); if (g.gasp) w.jawOpen = Math.max(w.jawOpen || 0, (w.jawOpen || 0) + g.gasp * 0.25); }
  for (const m of lifeMeshes(o)) for (const k of LIFE) if (k in m.morphTargetDictionary) m.morphTargetInfluences[m.morphTargetDictionary[k]] = Math.min(1, w[k] || 0);
  if (alive?.sway) { const hd = o.rig.bones.Head, a = alive.sway; hd.rotateZ(Math.sin(t * 0.31 + ph) * 0.12 * a); hd.rotateX(Math.sin(t * 0.23 + ph * 2) * 0.05 * a); hd.rotateY(Math.sin(t * 0.17 + ph) * 0.06 * a); }
}

// approach: { speed: m/s (0.12), stop: m (1.5), backwards: true (its back to you, walking backwards) }: walks toward the camera from where it was put, in a slowed
// walk (the clip slowed to the pace), and stops that far from you. Time counts from when the shot was shown
// (the player) so a slide starts it from its spot every time.
function approach(o, t, ahead = 0) {
  const ap = o.data.approach; if (!ap || o.data.x == null) return;
  o.approachT0 ??= t; const T = Math.max(0, t - (PLAYER ? P.showT ?? t : o.approachT0)), speed = ap.speed ?? 0.12, stop = ap.stop ?? 1.5;
  const dx = camera.position.x - o.data.x, dz = camera.position.z - o.data.z, D = Math.hypot(dx, dz) || 1, room = Math.max(0, D - stop), d = Math.min(room, speed * T + ahead);
  o.root.position.x = o.data.x + (dx / D) * d; o.root.position.z = o.data.z + (dz / D) * d; o.root.rotation.y = Math.atan2(dx, dz) + (ap.backwards ? Math.PI : 0);
  if (o.action) o.action.timeScale = (d < room ? speed / 0.67 : 0) * (ap.backwards ? -1 : 1); // (the walk clip covers 0.67 m/s; backwards: its back to you, the walk run in reverse)
}
// a playing clip's own pose, kept after the mixer applies it and put back before the next frame: what rides on
// top (the look, a twitch) is wiped each frame instead of piling up. (The mixer only writes a bone when its
// value changes, so resetting bones behind its back left them at rest wherever the clip held still: a
// slowed walk's arm snapped to the T-pose for six frames at a time.)
function clipBegin(o) { const c = o.clipPose; if (!c) return; c.bones.forEach((b, i) => { b.quaternion.fromArray(c.q, i * 4); b.scale.set(1, 1, 1); }); o.rig.bones.Hips.position.fromArray(c.hips); } // (and any stretch undone)
function clipEnd(o) {
  const c = (o.clipPose ||= { bones: Object.values(o.rig.bones), q: [], hips: [] });
  c.bones.forEach((b, i) => b.quaternion.toArray(c.q, i * 4)); o.rig.bones.Hips.position.toArray(c.hips);
}
// Twitching (pose.alive.twitch 0..1): something wearing a body and not quite knowing how. Subtle, like the
// possessed walk in Obsession: all the time, a wrong way of holding itself laid over the walk (arms held a
// little off the sides and hardly swinging, elbows soft, wrists cocked, fingers half-curled and splayed, knees
// bent, a slight hunch, the head low and tilted); and now and then, small and fast, it slips: the head jerks,
// a shoulder hitches, the fingers flex, the walk stalls for a split second, a knee gives and it catches
// itself, it takes the same step twice (a skipping loop), it stops dead for a second, a shiver runs down an arm. Seeded from the shot's start (the
// player): every showing plays the same. Joints stay inside what a body can do (the elbow and knee hinges).
const ease = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };
const AXR = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) }, _eq = new THREE.Quaternion(), _eq2 = new THREE.Quaternion(), _ea = new THREE.Vector3(), _hold = new THREE.Quaternion();
function rotRoot(o, bone, axis, angle) { // turn a bone about an axis in the character's own frame (+X its left, +Y up, +Z forward)
  if (!bone || !angle) return;
  o.root.getWorldQuaternion(_eq); bone.getWorldQuaternion(_eq2);
  bone.rotateOnAxis(_ea.copy(axis).applyQuaternion(_eq).applyQuaternion(_eq2.invert()).normalize(), angle); bone.updateMatrixWorld(true);
}
const HX = new THREE.Vector3(1, 0, 0), HXN = new THREE.Vector3(-1, 0, 0);
const hinge = (bone, axis, a) => { if (bone && a) { bone.rotateOnAxis(axis, Math.max(0, a)); bone.updateMatrixWorld(true); } }; // (elbows +X, knees -X: forward only)
const TWITCH_KINDS = ['head', 'shoulder', 'fingers', 'stall', 'knee', 'repeat', 'deadstop', 'shiver'];
function episodeState(o, t) {
  const amt = o.data.pose?.alive?.twitch; if (!amt) return null;
  const t0 = PLAYER ? P.showT ?? t : (o.approachT0 ??= t), rel = t - t0, sd = o.data.id.charCodeAt(0) * 7.7 + o.data.id.length;
  const h = (n, k) => { const x = Math.sin(n * 127.1 + k * 311.7 + sd) * 43758.5453; return x - Math.floor(x); };
  const S = 1.9 - 0.6 * amt, slips = [], kinds = o.data.pose?.alive?.twitchKinds || TWITCH_KINDS; let lost = 0;
  for (let n = 0; n * S <= rel; n++) {
    // dealt from a shuffled deck of the kinds (alive.twitchKinds, or all of them): every kind comes round before any
    // comes again, so a short shot still shows them all
    const K = kinds.length, c = Math.floor(n / K), deck = kinds.map((x, i) => [x, h(c * 13 + i, 40)]).sort((p, q) => p[1] - q[1]), type = deck[n % K][0], start = n * S + 0.3 + h(n, 2) * (S - 0.6);
    const tin = type === 'knee' ? 0.12 : type === 'shiver' ? 0 : 0.14 + h(n, 3) * 0.08; // (in over 4-7 frames: a jerk, not a pop)
    const hold = type === 'stall' ? 0.14 + h(n, 4) * 0.16 : type === 'deadstop' ? 0.9 + h(n, 4) * 0.5 : type === 'repeat' ? 0.45 + h(n, 4) * 0.3 : type === 'knee' ? 0.06 + h(n, 4) * 0.06 : type === 'shiver' ? 0.7 + h(n, 4) * 0.3 : 0.12 + h(n, 4) * 0.3;
    const tout = type === 'knee' ? 0.35 : type === 'shiver' ? 0 : 0.45 + h(n, 6) * 0.3, u = rel - start; // (and eased back slowly, as if nothing happened)
    if (u < 0) break;
    if (type === 'stall' || type === 'deadstop') { lost += Math.max(0, Math.min(u, hold)); continue; } // (the walk and the approach stop: a split second, or a whole dead second)
    if (type === 'repeat') { lost += hold; continue; } // (the clock jumps back: the last step plays again, then it walks on from there)
    if (u >= tin + hold + tout) continue;
    const k = u < tin ? ease(u / tin) : u < tin + hold ? 1 : 1 - ease((u - tin - hold) / tout);
    slips.push({ type, k: k * (0.6 + 0.4 * amt), side: h(n, 7) < 0.5 ? 1 : -1, a: h(n, 8), b: h(n, 9), u });
  }
  return { te: t - lost, ahead: 0, cur: { amt, slips, rel } };
}
function episode(o, ep) {
  if (!ep) return;
  const B = o.rig.bones, a = ep.amt, rig = o.rig;
  o.root.updateMatrixWorld(true);
  // the posture: the arms taken most of the way off the walk's swing to a held hang, a little out from the body
  for (const [side, L] of [['Left', 1], ['Right', -1]]) {
    const arm = B[`${side}Arm`]; if (!arm) continue;
    _hold.copy(arm.quaternion); arm.quaternion.copy(rig.rest[`${side}Arm`]); arm.updateMatrixWorld(true);
    rotRoot(o, arm, AXR.z, -L * (Math.PI / 2 - 0.26 * a)); rotRoot(o, arm, AXR.x, -0.12 * a); // (hanging, held off the side, a touch forward)
    arm.quaternion.copy(_hold.slerp(arm.quaternion, 0.8 * Math.min(1, a + 0.2))); arm.updateMatrixWorld(true);
    hinge(B[`${side}ForeArm`], HX, 0.45 * a); // soft elbows
    rotRoot(o, B[`${side}Hand`], AXR.x, 0.35 * a); // wrists cocked
    curlFingers(rig, side, { Index: [-0.15 * a, 0.5 * a, 0.4 * a], Middle: [0.2 * a, 0.6 * a, 0.45 * a], Ring: [0.35 * a, 0.7 * a, 0.5 * a], Pinky: [-0.1 * a, 0.6 * a, 0.5 * a] });
    hinge(B[`${side}Leg`], HXN, 0.18 * a); // knees a little bent
  }
  rotRoot(o, B.Spine1, AXR.x, 0.1 * a); rotRoot(o, B.Spine2, AXR.x, 0.06 * a); // a slight hunch
  rotRoot(o, B.Head, AXR.x, 0.1 * a); rotRoot(o, B.Head, AXR.z, 0.08 * a); // the head low, tilted
  // the slips: small and fast
  for (const s of ep.slips) {
    const k = s.k, L = s.side, side = L > 0 ? 'Left' : 'Right';
    if (s.type === 'head') { rotRoot(o, B.Head, AXR.z, -L * (0.18 + 0.14 * s.a) * k); rotRoot(o, B.Head, AXR.y, L * 0.12 * s.b * k); rotRoot(o, B.Neck, AXR.z, -L * 0.06 * k); }
    else if (s.type === 'shoulder') { rotRoot(o, B[`${side}Shoulder`], AXR.z, L * 0.16 * k); rotRoot(o, B.Head, AXR.z, L * 0.06 * k); }
    else if (s.type === 'knee') { // a knee gives, it catches itself a little too fast
      hinge(B[`${side}Leg`], HXN, 0.75 * k); rotRoot(o, B[`${side}UpLeg`], AXR.x, -0.35 * k); B.Hips.position.y -= 0.07 * k / (o.root.scale.y || 1);
      rotRoot(o, B.Spine1, AXR.z, L * 0.08 * k); rotRoot(o, B.Head, AXR.z, -L * 0.1 * k);
    } else if (s.type === 'shiver') { // a tremor rolling down one arm: shoulder, elbow, wrist, fingers, each a beat behind
      const wob = (d, f, amp) => { const x = s.u - d; return x > 0 && x < 0.45 ? Math.sin(x * f) * amp * Math.sin((x / 0.45) * Math.PI) : 0; };
      rotRoot(o, B[`${side}Shoulder`], AXR.z, L * wob(0, 48, 0.05)); rotRoot(o, B[`${side}Arm`], AXR.x, wob(0.07, 52, 0.07));
      hinge(B[`${side}ForeArm`], HX, 0.08 + wob(0.15, 56, 0.08)); rotRoot(o, B[`${side}Hand`], AXR.x, wob(0.23, 60, 0.12));
      const f = wob(0.3, 64, 0.35); curlFingers(rig, side, { Index: [f, f, f * 0.6], Middle: [-f * 0.5, f, f * 0.6], Ring: [f, f * 0.8, f * 0.5], Pinky: [-f, f * 0.7, f * 0.5] });
    } else if (s.type === 'fingers') curlFingers(rig, side, { Index: [0.9 * k, 0.8 * k, 0.5 * k], Middle: [-0.3 * k, 0.9 * k, 0.6 * k], Ring: [0.8 * k, 0.9 * k, 0.6 * k], Pinky: [-0.4 * k, 0.5 * k, 0.4 * k], Thumb: [0.3 * k, 0.4 * k, 0.2 * k] });
  }
  rig.root.updateMatrixWorld(true);
}

// Unhealthy breathing (pose.alive.wheeze 0..1): not a steady rhythm but breaths that go wrong, one type per
// breath, seeded (every showing the same): shallow and quick, a catch (the inhale stalls halfway, then a
// jerky gasp finishes it), a double sniff, a rattle (the exhale shivers out), or held too long at the top and
// collapsing out. The chest lifts, the shoulders hitch on the gasps, the neck takes the chest's motion back
// so the head stays where it was. Returns { gasp } for the jaw (0..1).
function sickBreath(o, t, amt, ph) {
  const S = 3.1, n = Math.floor((t + ph) / S), u = ((t + ph) - n * S) / S, B = o.rig.bones;
  const h = (k) => { const x = Math.sin(n * 91.7 + k * 47.3 + ph * 13.1) * 43758.5453; return x - Math.floor(x); };
  const type = ['shallow', 'catch', 'double', 'rattle', 'held', 'catch', 'shallow'][Math.floor(h(1) * 7)], depth = 0.55 + h(2) * 0.6;
  const sm = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };
  let f = 0, gasp = 0, shiver = 0; // f: how full, 0..1
  if (type === 'shallow') f = u < 0.3 ? sm(u / 0.3) * 0.55 : 0.55 * (1 - sm((u - 0.3) / 0.35));
  else if (type === 'catch') { if (u < 0.18) f = sm(u / 0.18) * 0.45; else if (u < 0.36) f = 0.45 + Math.sin((u - 0.18) * 90) * 0.015; else if (u < 0.42) { f = 0.45 + sm((u - 0.36) / 0.06) * 0.55; gasp = 1; } else f = 1 - sm((u - 0.42) / 0.4); }
  else if (type === 'double') { f = u < 0.08 ? sm(u / 0.08) * 0.4 : u < 0.16 ? 0.4 : u < 0.24 ? 0.4 + sm((u - 0.16) / 0.08) * 0.45 : 0.85 * (1 - sm((u - 0.24) / 0.5)); gasp = (u > 0.02 && u < 0.08) || (u > 0.16 && u < 0.24) ? 0.6 : 0; }
  else if (type === 'rattle') { f = u < 0.3 ? sm(u / 0.3) : 1 - sm((u - 0.3) / 0.6); shiver = u > 0.3 && u < 0.9 ? 1 : 0; }
  else { f = u < 0.2 ? sm(u / 0.2) : u < 0.75 ? 1 : 1 - sm((u - 0.75) / 0.12); gasp = u < 0.2 ? 0.5 : 0; } // held
  f *= depth * amt; if (shiver) f += Math.sin(t * 38) * 0.035 * amt;
  o.root.updateMatrixWorld(true);
  const headQ = B.Head.getWorldQuaternion(new THREE.Quaternion()); // (the head keeps its angle through all of it: the stare stays)
  const g = gasp * amt, lift = 0.2 * f + g * 0.06, sh = 0.3 * f + g * 0.2;
  // the ribcage heaves (Spine2 widening and deepening) while the belly sucks in (Spine flattening front to back):
  // paradoxical breathing, what a body in distress does; the bones above take the scale back so nothing else grows
  const rib = 1 + 0.07 * f + g * 0.03, bel = 1 - 0.06 * f;
  const sc = (bone, x, y, z) => { if (bone) { bone.scale.set(x, y, z); bone.updateMatrixWorld(true); } };
  sc(B.Spine, 1, 1, bel); sc(B.Spine1, 1, 1, 1 / bel);
  sc(B.Spine2, rib, 1, rib); sc(B.Neck, 1 / rib, 1, 1 / rib); sc(B.LeftShoulder, 1, 1 / rib, 1 / rib); sc(B.RightShoulder, 1, 1 / rib, 1 / rib);
  rotRoot(o, B.Spine1, AXR.x, -lift); rotRoot(o, B.Spine2, AXR.x, -lift * 0.8); // (the chest rising: the upper back arching)
  rotRoot(o, B.LeftShoulder, AXR.z, sh); rotRoot(o, B.RightShoulder, AXR.z, -sh); // (the shoulders climbing)
  rotRoot(o, B.LeftArm, AXR.z, -0.08 * f); rotRoot(o, B.RightArm, AXR.z, 0.08 * f); // (the arms floating out a little with it)
  // the body never quite still: a slow uneven sway, the weight shifting
  const sw = Math.sin(t * 0.43 + ph) * 0.03 + Math.sin(t * 0.17 + ph * 2) * 0.025;
  rotRoot(o, B.Spine, AXR.z, sw * amt); rotRoot(o, B.Spine1, AXR.y, Math.sin(t * 0.29 + ph) * 0.03 * amt);
  if (g > 0.05) for (const side of ['Left', 'Right']) curlFingers(o.rig, side, { Index: [0.5 * g, 0.6 * g, 0.3 * g], Middle: [0.55 * g, 0.6 * g, 0.3 * g], Ring: [0.6 * g, 0.6 * g, 0.3 * g], Pinky: [0.7 * g, 0.6 * g, 0.3 * g] }); // (the fingers clutch on a gasp)
  B.Head.quaternion.copy(B.Head.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(headQ)); B.Head.updateMatrixWorld(true);
  return { gasp: gasp * amt };
}

// ---------------- voices: 3D audio from the head + lip sync ----------------
const speaking = new Map(); // actorId -> playing voice
const FACE = ['jawOpen', 'mouthWide', 'mouthPucker'];
function faceMeshes(o) {
  if (!o.face) { o.face = []; o.root.traverse((m) => { if (m.morphTargetDictionary && FACE.every((k) => k in m.morphTargetDictionary)) o.face.push(m); }); }
  return o.face;
}
// hear one stretch of a line (to check a caption's placement)
let preview = null;
async function previewStretch(src, start, end) {
  preview?.stop?.();
  const { buffer } = await loadVoice(src), c = audioCtx(), node = c.createBufferSource();
  node.buffer = buffer; node.connect(c.destination); node.start(0, Math.max(0, start - 0.05), end - start + 0.25);
  preview = node;
}
// captions for a voice source: from its pasted script, aligned to the audio (see captions.js)
const ensureCaptions = (src) => loadCaptions(src);
// the rows are the pause-separated stretches (always all of them); the script's lines fill them in order
async function alignScript(src, script) {
  const voice = await loadVoice(src), r = align(script, voice.env), segs = speechSegments(voice.env);
  const cues = segs.map((sg) => { const c = r.cues.find((x) => Math.abs(x.start - sg.start) < 0.02); return { start: sg.start, end: c ? c.end : sg.end, segEnd: sg.end, text: c ? c.text : '' }; });
  const data = { src, script, cues, created: Date.now() };
  await saveCaptions(src, data);
  for (const v of speaking.values()) if (v.src === src) v.caps = data;
  status(r.exact ? `matched line for line: ${r.phrases} lines, ${r.segments} pauses-separated stretches` : `${r.segments} stretches of speech found, your script has ${r.phrases} lines: placed by best fit; check with ▶, fix with ⤓ ⤒ or by editing a row`);
  return data;
}
async function speak(o) {
  const a = o.data; if (!a.voice) return;
  stopVoice(a.id);
  audioCtx(); // unlock audio inside the click
  try {
    const v = playVoice(await loadVoice(a.voice.src), { loop: !!a.voice.loop });
    v.src = a.voice.src; ensureCaptions(a.voice.src).then((c) => { v.caps = c; });
    speaking.set(a.id, v);
    if (selected === a.id) renderActorBox();
    status(`${a.name} speaks “${a.voice.name}”`);
  } catch (err) { status(`can't play ${a.voice.name}: ${err.message}`); }
}
function stopVoice(id) { const v = speaking.get(id); if (!v) return; v.stop(); }
// subtitles: the nearest speaker's line centre-bottom (main subtitle); everyone else's floats above their head
const capsBox = $('#captions');
let capLines = [];
function updateCaptions() {
  const lines = [];
  for (const [id, v] of speaking) {
    const o = actors.get(id), cue = o && !v.ended && cueAt(v.caps, v.time()); if (!cue) continue;
    const head = o.rig.bones.Head.getWorldPosition(new THREE.Vector3());
    lines.push({ id, text: cue.text, name: o.data.name, head, d: head.distanceTo(camera.position) });
  }
  lines.sort((a, b) => a.d - b.d);
  capLines = lines;
  const html = lines.map((l, i) => {
    if (i === 0) return `<div class="cap main">${esc(l.text)}</div>`;
    const p = l.head.clone().add(new THREE.Vector3(0, 0.35, 0)).project(camera);
    if (p.z > 1 || Math.abs(p.x) > 1.1 || Math.abs(p.y) > 1.1) return '';
    const fade = Math.max(0.35, 1 - l.d / 45);
    return `<div class="cap side" style="left:${((p.x + 1) / 2) * 100}%;top:${((1 - p.y) / 2) * 100}%;opacity:${fade.toFixed(2)}">${esc(l.text)}</div>`;
  }).join('');
  if (capsBox && capsBox._html !== html) { capsBox.innerHTML = html; capsBox._html = html; }
}
function updateVoices(dt) {
  if (speaking.size) setListener(camera);
  for (const [id, v] of speaking) {
    const o = actors.get(id);
    if (!o) { v.stop(); speaking.delete(id); continue; }
    const head = o.rig.bones.Head, pos = head.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0.06, 0));
    const facing = new THREE.Vector3(0, 0, 1).applyQuaternion(head.getWorldQuaternion(new THREE.Quaternion()));
    v.place(pos, facing, camera.position);
    const m = v.mouth(dt);
    for (const mesh of faceMeshes(o)) for (const k of FACE) mesh.morphTargetInfluences[mesh.morphTargetDictionary[k]] = m[k];
    if (v.ended && m.jawOpen < 0.01 && m.mouthWide < 0.01) { speaking.delete(id); if (selected === id) renderActorBox(); } // mouth closed again: done
  }
}
function playScene() {
  const list = [...actors.values()].filter((o) => o.data.voice && o.data.voice.autoplay !== false);
  if (!list.length) { status('nobody has a voice line yet: select a character and pick one under "voice"'); return; }
  for (const o of list) speak(o);
  status(`playing: ${list.map((o) => o.data.name.split(' ')[0]).join(', ')}`);
}
$('#playScene').onclick = () => (speaking.size ? (speaking.forEach((v) => v.stop()), status('stopped')) : playScene());

// ---------------- record: a vertical 1080x1920 clip (TikTok) with the voices and the subtitles burnt in ----------------
let recorder = null;
function pickType() {
  for (const t of ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'])
    if (window.MediaRecorder?.isTypeSupported(t)) return t;
  return '';
}
function startRec() {
  if (!window.MediaRecorder) { status('recording is not supported in this browser'); return; }
  const res = terrainParams().res;
  stage.setRes(res, true);
  // the frames go through a 2D canvas so the subtitles (page elements on screen) are drawn into the video
  const comp = document.createElement('canvas'); comp.width = 1080; comp.height = 1920;
  const g = comp.getContext('2d'), stream = comp.captureStream(30);
  voiceStream().getAudioTracks().forEach((tr) => stream.addTrack(tr));
  const type = pickType(), chunks = [], t0 = performance.now();
  const mr = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 10e6, audioBitsPerSecond: 192e3 });
  mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  mr.onstop = () => {
    const ext = type.includes('mp4') ? 'mp4' : 'webm', blob = new Blob(chunks, { type: type.split(';')[0] || 'video/webm' });
    const file = `${slug(rec.name)}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${ext}`;
    download(blob, file);
    status(`saved ${file} (${((performance.now() - t0) / 1000).toFixed(1)} s, ${(blob.size / 1e6).toFixed(1)} MB, 1080x1920${ext === 'webm' ? ', WebM: convert to MP4 if TikTok refuses it' : ''})`);
  };
  mr.start(250);
  recorder = { mr, g, comp, t0 };
  $('#record').classList.add('on');
  status('recording (vertical): press P to play the scene, click ■ Stop to save');
}
function stopRec() {
  if (!recorder) return;
  recorder.mr.stop(); recorder = null;
  stage.setRes(terrainParams().res, false);
  $('#record').classList.remove('on'); $('#record').textContent = '● Rec (vertical)';
}
// one frame of the recording: the 3D view, then the subtitles in the same style as on screen
function drawRecFrame() {
  const { g, comp, t0 } = recorder, W = comp.width, H = comp.height;
  g.drawImage(canvas, 0, 0, W, H);
  g.textAlign = 'center'; g.textBaseline = 'alphabetic';
  const wrap = (text, max) => { const words = text.split(' '), out = []; let line = ''; for (const w of words) { const t = line ? `${line} ${w}` : w; if (g.measureText(t).width > max && line) { out.push(line); line = w; } else line = t; } if (line) out.push(line); return out; };
  capLines.forEach((l, i) => {
    let x = W / 2, y = H * 0.72, size = 50, alpha = 1; // well above the bottom: TikTok's caption and buttons cover the lowest fifth
    if (i > 0) { const p = l.head.clone().add(new THREE.Vector3(0, 0.35, 0)).project(camera); if (p.z > 1 || Math.abs(p.x) > 1.1 || Math.abs(p.y) > 1.1) return; x = ((p.x + 1) / 2) * W; y = ((1 - p.y) / 2) * H; size = 32; alpha = Math.max(0.35, 1 - l.d / 45); }
    g.font = `italic ${size}px Georgia, "Times New Roman", serif`;
    const rows = wrap(l.text, i ? W * 0.45 : W * 0.84), lh = size * 1.25;
    rows.forEach((row, k) => {
      const yy = i ? y - (rows.length - 1 - k) * lh : y - (rows.length - 1 - k) * lh;
      g.globalAlpha = alpha; g.shadowColor = 'rgba(0,0,0,.95)'; g.shadowBlur = 10; g.shadowOffsetY = 3;
      g.fillStyle = '#ece6d6'; g.fillText(row, x, yy);
    });
    g.globalAlpha = 1; g.shadowBlur = 0; g.shadowOffsetY = 0;
  });
  $('#record').textContent = `■ Stop ${((performance.now() - t0) / 1000).toFixed(0)}s`;
}
$('#record').onclick = () => (recorder ? stopRec() : startRec());

// ---------------- ambience (the panel on the right) ----------------
// rec.ambience = { id: volume } for the beds that are on. Browsers start audio only after a gesture: a scene
// that opens with ambience starts it on the first click / key press.
let ambienceArmed = false;
function renderAmbience() {
  const box = $('#ambienceList'); if (!box) return;
  rec.ambience ||= {};
  box.replaceChildren(...AMBIENCES.map((a) => {
    const on = a.id in rec.ambience, vol = rec.ambience[a.id] ?? a.volume, row = document.createElement('div');
    row.className = 'amb' + (on ? ' on' : '');
    row.innerHTML = `<label><input type="checkbox" ${on ? 'checked' : ''}> ${esc(a.name)}</label><input type="range" min="0" max="1" step="0.01" value="${vol}" ${on ? '' : 'disabled'}>`;
    const [chk, vr] = row.querySelectorAll('input');
    chk.onchange = () => {
      if (chk.checked) { rec.ambience[a.id] = +vr.value; startBed(a.id, +vr.value); } else { delete rec.ambience[a.id]; stopBed(a.id); }
      autosave(); renderAmbience();
    };
    vr.oninput = () => { rec.ambience[a.id] = +vr.value; bedVolume(a.id, +vr.value); autosave(); };
    return row;
  }));
}
function syncAmbience(gesture = false) { // start / stop beds to match the scene (only once audio is allowed)
  rec.ambience ||= {};
  for (const a of AMBIENCES) if (!(a.id in rec.ambience) && bedPlaying(a.id)) stopBed(a.id);
  if (!gesture && !ambienceArmed) return;
  ambienceArmed = true;
  for (const [id, v] of Object.entries(rec.ambience)) startBed(id, v);
}
const armAmbience = () => { if (!ambienceArmed && Object.keys(rec?.ambience || {}).length) syncAmbience(true); };
addEventListener('pointerdown', armAmbience, true); addEventListener('keydown', armAmbience, true);

// ---------------- snapshot for slides: a clean vertical 1080x1920 frame of what the camera sees ----------------
async function takeShot() {
  if (recorder) { status('stop the recording first'); return; }
  const res = terrainParams().res, ringWas = ring.visible, handlesWas = handles.visible, capsWas = capsBox.style.visibility;
  ring.visible = false; handles.visible = false;
  stage.setRes(res, true); stage.render(performance.now() / 1000, { card: false }); // one vertical frame: no editor markers, no title card
  const c = document.createElement('canvas'); c.width = 1080; c.height = 1920; c.getContext('2d').drawImage(canvas, 0, 0, 1080, 1920);
  stage.setRes(res, false); ring.visible = ringWas; handles.visible = handlesWas; capsBox.style.visibility = capsWas;
  const id = uid();
  await put('shots', id, { id, image: c.toDataURL('image/jpeg', 0.9), scene: rec.name, place: rec.terrain?.name, actors: rec.actors.map((a) => a.name), props: (rec.props || []).map((p) => p.kind), created: Date.now() });
  canvas.classList.add('flash'); setTimeout(() => canvas.classList.remove('flash'), 180);
  $('#status').innerHTML = `snapshot saved for <a href="/slides.html">Slides ▸</a> (1080×1920)`;
}
$('#snapshot').onclick = takeShot;

// ---------------- context menu (right click) ----------------
let menuEl = null, menuT = 0;
function closeMenu() { menuEl?.remove(); menuEl = null; }
async function openMenu(e) {
  closeMenu();
  setRay(e); const p = groundPoint();
  const lib = (await all('characters')).sort((x, y) => y.created - x.created);
  const sel = selected && actors.get(selected), selP = selectedProp && props.get(selectedProp);
  const m = document.createElement('div'); m.className = 'ctxmenu';
  // submenus open on hover (or click) and switch only after a short pause, so cutting diagonally across
  // other items toward an open submenu doesn't close it
  const item = (label, fn, sub) => {
    const d = document.createElement('div'); d.className = 'ctxitem' + (sub ? ' sub' : '') + (fn || sub ? '' : ' off');
    const t = document.createElement('span'); t.textContent = label; d.appendChild(t);
    const openMe = () => { for (const sib of d.parentElement.children) if (sib !== d) sib.classList.remove('open'); if (sub) d.classList.add('open'); };
    d.addEventListener('mouseenter', (ev) => { ev.stopPropagation(); clearTimeout(menuT); const anyOpen = [...(d.parentElement?.children || [])].some((x) => x !== d && x.classList.contains('open')); menuT = setTimeout(openMe, anyOpen ? 220 : 0); });
    d.addEventListener('click', (ev) => { ev.stopPropagation(); if (fn) { closeMenu(); fn(); } else if (sub) { clearTimeout(menuT); openMe(); } });
    if (sub) d.appendChild(sub);
    return d;
  };
  const list = (entries) => { const d = document.createElement('div'); d.className = 'ctxmenu nested'; entries.forEach((x) => d.appendChild(x)); return d; };
  if (p) {
    m.appendChild(item('Spawn prop', null, list(CATEGORIES.map((c) => item(c, null, list(Object.entries(PROPS).filter(([, d]) => d.category === c).map(([k, d]) => item(d.label, () => spawnProp(k, p)))))))));
    m.appendChild(item('Add character here', null, lib.length ? list(lib.map((c) => item(c.name, () => addActorAt(c.id, p)))) : list([item('(send one from the Characters tab)')])));
    if (sel && !sel.data.seat) m.appendChild(item(`Move ${sel.data.name.split(' ')[0]} here`, () => { sel.data.x = p.x; sel.data.z = p.z; place(sel); updateRing(); autosave(); }));
    if (selP) m.appendChild(item(`Move the ${PROPS[selP.data.kind].label.toLowerCase()} here`, () => { selP.data.x = p.x; selP.data.z = p.z; placeProp(selP); updateRing(); autosave(); }));
    // composition (directives, see scenes/README.md) around the selected prop or character
    const focus = selP ? selP.data : sel ? sel.data : null;
    if (focus) {
      const who = selP ? `the ${PROPS[selP.data.kind].label.toLowerCase()}` : sel.data.name.split(' ')[0];
      const addDir = (d, msg) => { rec.directives ||= []; rec.directives.push({ id: `${d.kind}-${uid().slice(-4)}`, ...d }); applySceneDirectives(); syncActors(); autosave(); renderPanel(); status(msg); };
      m.appendChild(item(`Around ${who}`, null, list([
        item('Make every path lead here', () => addDir({ kind: 'converge', toward: focus.id, count: 5 }, `paths now wander in toward ${who}`)),
        item('Bring stone causeways down to it', () => addDir({ kind: 'causeways', toward: focus.id, count: 7 }, `stone causeways now come down to ${who} from every side`)),
        item('Clear the ground around it', () => addDir({ kind: 'clearing', around: focus.id, radius: 6 }, `the ground is cleared around ${who}`)),
        item('Keep it in sight from the spawn', () => addDir({ kind: 'sightline', from: 'spawn', to: focus.id }, `nothing stands between the spawn and ${who}`)),
        item('Ring it with', null, list(CATEGORIES.map((c) => item(c, null, list(Object.entries(PROPS).filter(([, d]) => d.category === c).map(([k, d]) => item(d.label, () => addDir({ kind: 'ring', prop: k, around: focus.id, radius: 10, count: 8, face: 'in' }, `${who} is ringed with ${d.label.toLowerCase()}s`)))))))),
        ...((rec.directives || []).some((d) => [d.toward, d.around, d.to].includes(focus.id)) ? [item('Undo its directives', () => { rec.directives = rec.directives.filter((d) => ![d.toward, d.around, d.to].includes(focus.id)); applySceneDirectives(); syncActors(); autosave(); renderPanel(); status(`${who} no longer shapes the place`); })] : []),
      ])));
    }
    m.appendChild(item('Fly here', () => { const dir = p.clone().sub(cam.pos); dir.y = 0; dir.normalize(); const to = p.clone().addScaledVector(dir, -9); to.y = Math.max(p.y + 3.5, world.height(to.x, to.z) + 1); flyTo(to, p.clone().add(new THREE.Vector3(0, 0.8, 0))); }));
  } else m.appendChild(item('(point at the ground)'));
  document.body.appendChild(m); menuEl = m;
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.min(e.clientX, innerWidth - r.width - 8)}px`; m.style.top = `${Math.min(e.clientY, innerHeight - r.height - 8)}px`;
}
addEventListener('pointerdown', (e) => { if (menuEl && !menuEl.contains(e.target)) closeMenu(); }, true);
async function addActorAt(charId, p) {
  const c = await loadChar(charId); if (!c) return;
  const a = { ...newActor(charId, c.name, rec.actors.length), rel: false, x: p.x, z: p.z }; a.rotY = Math.atan2(camera.position.x - p.x, camera.position.z - p.z);
  rec.actors.push(a); await spawnActor(a); select(a.id); autosave(); renderPanel();
}

// ---------------- panel ----------------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
function renderPanel() { renderAmbience(); renderShots(); $('#sceneName').value = rec.name; renderMeta(); renderTerrain(); renderActorList(); renderActorBox(); renderLibrary(); renderMood(); renderScenes(); }
function renderMeta() { $('#sceneMeta').textContent = `${rec.actors.length} character${rec.actors.length === 1 ? '' : 's'} · scenes/${rec.id}.json (saves as you go)`; }
function renderTerrain() {
  const t = rec.terrain;
  $('#terrainBox').innerHTML = t
    ? `<p class="placename">${esc(t.name)}</p><p class="meta">${esc(t.biome?.archetype || 'village')} · seed ${t.seed}${t.region ? ' · from the world map' : ''}</p><p class="meta"><a href="/scenario.html">change it in Scenarios ▸</a> (Set scene)</p>`
    : `<p class="hint">No terrain set: showing the default village. Pick a place in <a href="/scenario.html">Scenarios</a> and press <b>Set scene</b>.</p>`;
}
function renderActorList() {
  const box = $('#actorList');
  if (!rec.actors.length) { box.innerHTML = '<p class="hint">Nobody here yet. On the <a href="/">Characters</a> tab, press <b>Send to scene</b>; or add from the library below.</p>'; return; }
  box.replaceChildren(...rec.actors.map((a) => {
    const row = document.createElement('div'); row.className = 'actor' + (a.id === selected ? ' on' : '');
    row.innerHTML = `<span>${esc(a.name)}</span><button title="remove from the scene">×</button>`;
    row.onclick = () => { if (picking) { seatActor(actors.get(a.id), picking.propId); endPicking(); return; } select(a.id); if (!walking) frameActor(a.id); };
    row.querySelector('button').onclick = (e) => { e.stopPropagation(); removeActor(a.id); };
    return row;
  }));
}
function renderPropBox(box, pr) {
  const d = pr.data, def = PROPS[d.kind], seats = pr.built.seats.length;
  const sitters = rec.actors.filter((a) => a.seat?.prop === d.id);
  box.innerHTML = `
    <p class="placename">${esc(def.label)}</p><p class="meta">${def.category}${seats ? ` · ${sitters.length}/${seats} seat${seats > 1 ? 's' : ''} taken${sitters.length ? `: ${sitters.map((a) => esc(a.name)).join(', ')}` : ''}` : ''}</p>
    <div class="row"><span>turn</span><input type="range" min="-3.1416" max="3.1416" step="0.01" value="${Math.atan2(Math.sin(d.rotY), Math.cos(d.rotY))}"><output>${Math.round((Math.atan2(Math.sin(d.rotY), Math.cos(d.rotY)) * 180) / Math.PI)}°</output></div>
    <div class="row"><span>scale</span><input type="range" min="0.5" max="2" step="0.01" value="${d.scale || 1}"><output>${(d.scale || 1).toFixed(2)}</output></div>
    <div class="buttons">
      ${seats ? `<button data-a="seat" class="primary" style="grid-column: span 2" ${freeSeat(d.id) < 0 ? 'disabled' : ''}>Seat a character ▸</button>` : ''}
      ${sitters.length ? '<button data-a="unseat">Everyone stands</button>' : ''}<button data-a="rm" ${d.locked ? 'disabled' : ''}>Remove</button>
      <button data-a="lock" class="${d.locked ? 'on' : ''}" style="grid-column: span 2" title="locked: it can't be dragged, turned, scaled or removed by accident">${d.locked ? '🔒 Position locked' : 'Lock position'}</button>
    </div>`;
  const [turnI, scaleI] = box.querySelectorAll('input[type=range]'), outs = box.querySelectorAll('output');
  turnI.oninput = () => { d.rotY = +turnI.value; outs[0].textContent = `${Math.round((d.rotY * 180) / Math.PI)}°`; placeProp(pr); autosave(); };
  scaleI.oninput = () => { d.scale = +scaleI.value; outs[1].textContent = d.scale.toFixed(2); placeProp(pr); updateRing(); autosave(); };
  box.querySelector('[data-a=seat]')?.addEventListener('click', () => startPicking(d.id));
  box.querySelector('[data-a=unseat]')?.addEventListener('click', () => { for (const o of actors.values()) if (o.data.seat?.prop === d.id) standUp(o, true); autosave(); renderPanel(); });
  box.querySelector('[data-a=rm]').onclick = () => removeProp(d.id);
  box.querySelector('[data-a=lock]').onclick = () => { if (d.locked) delete d.locked; else d.locked = true; autosave(); renderActorBox(); };
  if (d.locked) { turnI.disabled = true; scaleI.disabled = true; }
}
function renderActorBox() {
  const box = $('#actorBox'), pr = selectedProp && props.get(selectedProp);
  if (pr) { renderPropBox(box, pr); return; }
  const o = selected && actors.get(selected);
  if (!o) { box.innerHTML = ''; return; }
  const a = o.data;
  box.innerHTML = `
    <div class="row"><span>name</span><input class="text" value="${esc(a.name)}"></div>
    <div class="row"><span>animation</span><select>${o.clips.map((c) => `<option ${c.name === a.anim ? 'selected' : ''}>${c.name}</option>`).join('')}</select></div>
    <div class="row"><span>${a.seat ? 'turn on seat' : 'turn'}</span><input type="range" min="-3.1416" max="3.1416" step="0.01" value="${(() => { const v = a.seat ? a.seatRot || 0 : a.rotY; return Math.atan2(Math.sin(v), Math.cos(v)); })()}"><output></output></div>
    <div class="row"><span>scale</span><input type="range" min="0.4" max="2" step="0.01" value="${a.scale}"><output>${a.scale.toFixed(2)}</output></div>
    <div class="buttons"><button data-a="lock" class="${a.locked ? 'on' : ''}" style="grid-column: span 2" title="locked: it can't be dragged, turned, scaled or deleted by accident">${a.locked ? '🔒 Position locked' : 'Lock position'}</button></div>
    <div class="buttons"><button data-a="dup">Duplicate</button><button data-a="face">Face the camera</button><button data-a="look" class="${a.lookAtMe ? 'on' : ''}" style="grid-column: span 2" title="only the face turns to you; the eyes look straight into the camera">${a.lookAtMe ? '◉ Looking at you' : '◎ Look at me'}</button>${a.seat ? '<button data-a="stand" style="grid-column: span 2">Stand up</button>' : ''}</div>
    <p class="meta">pose ${o.compiled ? `<b>(directed: ${esc(a.pose.preset || 'stand')})</b>` : a.pose ? '<b>(custom, still)</b>' : '(playing the animation)'}</p>
    <div class="buttons">
      <button data-a="photo">From photo…</button><button data-a="cam">From webcam…</button>
      <button data-a="edit" class="${editPose ? 'on' : ''}" style="grid-column: span 2" title="drag the coloured handles: hands, feet, head, chest, hips">${editPose ? 'Editing pose: drag the handles' : 'Edit pose (handles)'}</button>
      <label><input type="checkbox" data-a="mirror"> mirror photo</label><label><input type="checkbox" data-a="breathe" ${a.breathe !== false ? 'checked' : ''}> breathing</label>
      <button data-a="savepose" ${a.pose ? '' : 'disabled'}>Save to poses</button><button data-a="anim" ${a.pose ? '' : 'disabled'}>Back to animation</button>
      <div class="row" style="grid-column: span 2"><span>preset</span><select data-a="preset"><option value="">—</option>${PRESETS.map((p) => `<option ${a.pose?.preset === p ? 'selected' : ''}>${p}</option>`).join('')}</select></div>
    </div>
    <input type="file" accept="image/*" data-a="file" hidden>
    <p class="meta">voice line ${a.voice ? `<b>${esc(a.voice.name)}</b>` : '(none)'}</p>
    <div class="row"><span>voice</span><select data-a="voice"><option value="">none</option></select></div>
    <div class="buttons">
      <button data-a="vplay" class="primary" ${a.voice ? '' : 'disabled'}>${speaking.has(a.id) ? '■ Stop' : '▶ Speak'}</button><button data-a="vimport">Import audio…</button>
      <label><input type="checkbox" data-a="vloop" ${a.voice?.loop ? 'checked' : ''}> loop</label><label title="speaks when you press ▶ Play scene"><input type="checkbox" data-a="vauto" ${a.voice?.autoplay !== false ? 'checked' : ''}> in Play scene</label>
    </div>
    <input type="file" accept="audio/*" data-a="vfile" hidden>
    <div data-a="caps"></div>`;
  const [nameI, turnI, scaleI] = [box.querySelector('input.text'), ...box.querySelectorAll('input[type=range]')];
  const outs = box.querySelectorAll('output'); outs[0].textContent = `${Math.round((+turnI.value * 180) / Math.PI)}°`;
  nameI.onchange = () => { a.name = nameI.value.trim() || a.name; autosave(); renderActorList(); };
  box.querySelector('select').onchange = (e) => { setAnim(o, e.target.value); autosave(); };
  turnI.oninput = () => { a[a.seat ? 'seatRot' : 'rotY'] = +turnI.value; outs[0].textContent = `${Math.round((+turnI.value * 180) / Math.PI)}°`; place(o); autosave(); };
  scaleI.oninput = () => { a.scale = +scaleI.value; outs[1].textContent = a.scale.toFixed(2); place(o); updateRing(); autosave(); };
  box.querySelector('[data-a=lock]').onclick = () => { if (a.locked) delete a.locked; else a.locked = true; autosave(); renderActorBox(); };
  if (a.locked) { turnI.disabled = true; scaleI.disabled = true; box.querySelector('[data-a=face]').disabled = true; }
  box.querySelector('[data-a=dup]').onclick = async () => {
    const b = { ...structuredClone(a), id: uid(), x: a.x + 1.2, z: a.z + 0.6, locked: undefined }; // (a copy starts unlocked: it has to be moved off the original)
    rec.actors.push(b); await spawnActor(b); select(b.id); autosave(); renderMeta();
  };
  box.querySelector('[data-a=stand]')?.addEventListener('click', () => standUp(o));
  box.querySelector('[data-a=look]').onclick = () => { a.lookAtMe = !a.lookAtMe; autosave(); renderActorBox(); };
  // voice line: pick from assets/ or imported files; speak / stop; loop; part of "Play scene"
  (async () => {
    const sel = box.querySelector('[data-a=voice]'), files = [...assetList().map((f) => ({ ...f, group: 'assets/' })), ...(await importedList()).map((f) => ({ ...f, group: 'imported' }))];
    for (const g of ['assets/', 'imported']) {
      const fs = files.filter((f) => f.group === g); if (!fs.length) continue;
      const og = document.createElement('optgroup'); og.label = g; for (const f of fs) { const op = document.createElement('option'); op.value = f.src; op.textContent = f.name; og.appendChild(op); } sel.appendChild(og);
    }
    sel.value = a.voice?.src || '';
    sel.onchange = () => { stopVoice(a.id); a.voice = sel.value ? { src: sel.value, name: files.find((f) => f.src === sel.value).name, loop: a.voice?.loop || false, autoplay: a.voice?.autoplay ?? true } : null; autosave(); renderActorBox(); };
  })();
  box.querySelector('[data-a=vimport]').onclick = () => box.querySelector('[data-a=vfile]').click();
  box.querySelector('[data-a=vfile]').onchange = async (e) => { const f = e.target.files[0]; if (!f) return; const v = await importFile(f); stopVoice(a.id); a.voice = { ...v, loop: false, autoplay: true }; autosave(); renderActorBox(); status(`“${f.name}” imported for ${a.name}`); };
  box.querySelector('[data-a=vplay]').onclick = () => (speaking.has(a.id) ? stopVoice(a.id) : speak(o));
  box.querySelector('[data-a=vloop]').onchange = (e) => { if (a.voice) { a.voice.loop = e.target.checked; autosave(); } };
  box.querySelector('[data-a=vauto]').onchange = (e) => { if (a.voice) { a.voice.autoplay = e.target.checked; autosave(); } };
  // captions: paste the script; it's aligned to the audio's pauses. Each phrase can be heard, moved, edited.
  if (a.voice) (async () => {
    const el = box.querySelector('[data-a=caps]'), src = a.voice.src, caps = await loadCaptions(src);
    if (!el.isConnected) return;
    el.innerHTML = `<p class="meta">captions: paste the script (one line per spoken line is best; "(laughs)"-style directions are fine)</p>
      <textarea class="script" rows="4" placeholder="No.&#10;Don't hang up.&#10;I've been dialing this number since before you were born.">${esc(caps?.script || '')}</textarea>
      <div class="buttons"><button data-a="align" style="grid-column: span 2">${caps?.cues?.length ? 'Align again' : 'Align to the audio'}</button></div>
      <div class="caplist"></div>`;
    const ta = el.querySelector('.script');
    el.querySelector('[data-a=align]').onclick = async () => { if (!ta.value.trim()) { status('paste the script first'); return; } await alignScript(src, ta.value); renderActorBox(); };
    if (!caps?.cues?.length) return;
    const list = el.querySelector('.caplist');
    const save = async () => { await saveCaptions(src, caps); for (const v of speaking.values()) if (v.src === src) v.caps = caps; };
    // a row's text moves with ⤓ / ⤒ together with every row after it (fixes an off-by-one after a missing line)
    const shift = async (from, dir) => {
      const texts = caps.cues.map((c) => c.text);
      if (dir > 0) { texts.splice(from, 0, ''); if (texts.at(-1)) texts[texts.length - 2] = `${texts[texts.length - 2]} ${texts.pop()}`.trim(); else texts.pop(); }
      else { if (texts[from - 1]) texts[from - 1] = `${texts[from - 1]} ${texts[from]}`.trim(); else if (from > 0) texts[from - 1] = texts[from]; texts.splice(from, 1); texts.push(''); }
      caps.cues.forEach((c, k) => { c.text = texts[k] || ''; c.end = c.segEnd ?? c.end; }); // after a shift, every row is just its own stretch
      await save(); renderActorBox();
    };
    caps.cues.forEach((c, k) => {
      const row = document.createElement('div'); row.className = 'caprow' + (c.text ? '' : ' empty');
      row.innerHTML = `<button data-a="hear" title="play this stretch">▶</button><span>${c.start.toFixed(1)}s</span><input class="text" value="${esc(c.text)}" placeholder="(no caption)"><button data-a="down" title="push this line and everything after it down one stretch">⤓</button><button data-a="up" title="pull this line and everything after it up one stretch" ${k ? '' : 'disabled'}>⤒</button>`;
      row.querySelector('input').onchange = async (e) => { c.text = e.target.value.trim(); await save(); row.classList.toggle('empty', !c.text); };
      row.querySelector('[data-a=hear]').onclick = () => previewStretch(src, c.start, c.end);
      row.querySelector('[data-a=down]').onclick = () => shift(k, 1);
      row.querySelector('[data-a=up]').onclick = () => shift(k, -1);
      list.appendChild(row);
    });
  })();
  box.querySelector('[data-a=face]').onclick = () => {
    const w = o.root.getWorldPosition(new THREE.Vector3()), want = Math.atan2(camera.position.x - w.x, camera.position.z - w.z);
    if (a.seat) { const seatYaw = new THREE.Euler().setFromQuaternion(o.root.parent.getWorldQuaternion(new THREE.Quaternion()), 'YXZ').y; a.seatRot = want - seatYaw; } else a.rotY = want;
    place(o); autosave(); renderActorBox();
  };
  const mirrorI = box.querySelector('[data-a=mirror]'), fileI = box.querySelector('[data-a=file]');
  mirrorI.checked = mirrorPref;
  mirrorI.onchange = () => { mirrorPref = mirrorI.checked; };
  box.querySelector('[data-a=photo]').onclick = () => fileI.click();
  fileI.onchange = async () => {
    const f = fileI.files[0]; fileI.value = ''; if (!f) return;
    const img = new Image(); img.src = URL.createObjectURL(f); await img.decode();
    await poseFromImage(o, img, f.name.replace(/\.[^.]+$/, ''), mirrorPref);
  };
  box.querySelector('[data-a=cam]').onclick = () => openWebcam(o);
  box.querySelector('[data-a=edit]').onclick = () => { editPose = !editPose; renderActorBox(); status(editPose ? 'drag a handle: blue hands, green feet, yellow head, orange chest, pink hips (crouch)' : ''); };
  box.querySelector('[data-a=preset]').onchange = (e) => { if (!e.target.value) return; a.pose = { preset: e.target.value, ...(a.pose && !a.pose.bones ? { look: a.pose.look, leftHand: a.pose.leftHand, rightHand: a.pose.rightHand } : {}) }; o.compiledKey = null; compileDirected(); autosave(); renderActorBox(); };
  box.querySelector('[data-a=breathe]').onchange = (e) => { a.breathe = e.target.checked; autosave(); };
  box.querySelector('[data-a=anim]').onclick = () => { clearPose(o); editPose = false; renderActorBox(); };
  box.querySelector('[data-a=savepose]').onclick = async () => {
    const th = document.createElement('canvas'); th.width = 120; th.height = 90; th.getContext('2d').drawImage(canvas, 0, 0, 120, 90);
    await addToPoseLibrary(`${a.name.split(' ')[0]}'s pose`, th.toDataURL('image/jpeg', 0.8), a.pose);
  };
  renderPoses();
}

// ---------------- poses from photos / the webcam, and the pose library ----------------
let mirrorPref = false;
function thumbOf(img, w = 120) { const c = document.createElement('canvas'); const h = Math.round((w * (img.videoHeight || img.naturalHeight || img.height)) / (img.videoWidth || img.naturalWidth || img.width)); c.width = w; c.height = h; c.getContext('2d').drawImage(img, 0, 0, w, h); return c.toDataURL('image/jpeg', 0.8); }
async function poseFromImage(o, img, name, mirror) {
  status('reading the pose…');
  const det = await detect(img);
  if (!det) { status('no person found in that picture: try a full-body shot with some contrast'); return false; }
  o.rig.root.updateMatrixWorld(true);
  const from = o.data.pose || snapshot(o.rig);
  const pose = retarget(o.rig, det, { mirror });
  applyPose(o.rig, from); // retarget posed the rig directly; let the tween carry it there
  setPose(o, pose);
  await addToPoseLibrary(name, thumbOf(img), pose);
  const seen = det.norm.filter((l) => (l.visibility ?? 1) > 0.5).length;
  status(`posed from “${name}” (${seen}/33 body points seen${det.hands.length ? `, ${det.hands.length} hand${det.hands.length > 1 ? 's' : ''}` : ''}) · saved to the pose library`);
  renderActorBox();
  return true;
}
async function addToPoseLibrary(name, thumb, pose) { const id = uid(); await put('poses', id, { id, name, thumb, pose: structuredClone(pose), created: Date.now() }); renderPoses(); }
async function renderPoses() {
  const box = $('#poseLib'); if (!box) return;
  const list = (await all('poses')).sort((x, y) => y.created - x.created);
  if (!list.length) { box.innerHTML = '<p class="hint">Poses from photos, the webcam or your edits collect here; click one to put the selected character in it.</p>'; return; }
  box.replaceChildren(...list.map((p) => {
    const d = document.createElement('div'); d.className = 'libitem'; d.title = selected ? `pose ${actors.get(selected)?.data.name} like this` : 'select a character first';
    d.innerHTML = `<img src="${p.thumb}" alt=""><span>${esc(p.name)}</span><button title="delete this pose">×</button>`;
    d.onclick = () => { const o = selected && actors.get(selected); if (!o) { status('select a character first'); return; } setPose(o, structuredClone(p.pose)); renderActorBox(); status(`${o.data.name} takes “${p.name}”`); };
    d.querySelector('button').onclick = async (e) => { e.stopPropagation(); await del('poses', p.id); renderPoses(); };
    return d;
  }));
}
// webcam: a small window, snap now or in 3 seconds (time to strike the pose yourself); mirrored by default
async function openWebcam(o) {
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: false }); }
  catch (err) { status(`no webcam: ${err.message}`); return; }
  const wrap = document.createElement('div'); wrap.className = 'camwin';
  wrap.innerHTML = `<video playsinline muted></video><div class="count"></div><div class="buttons"><button data-a="snap">Snap</button><button data-a="timer">Snap in 3 s</button><label><input type="checkbox" data-a="mir" checked> mirror</label><button data-a="close">Close</button></div>`;
  document.body.appendChild(wrap);
  const video = wrap.querySelector('video'); video.srcObject = stream; await video.play();
  const close = () => { stream.getTracks().forEach((t) => t.stop()); wrap.remove(); };
  const snap = async () => {
    const c = document.createElement('canvas'); c.width = video.videoWidth; c.height = video.videoHeight; c.getContext('2d').drawImage(video, 0, 0);
    const ok = await poseFromImage(o, c, `webcam ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`, wrap.querySelector('[data-a=mir]').checked);
    if (ok) close();
  };
  wrap.querySelector('[data-a=snap]').onclick = snap;
  wrap.querySelector('[data-a=timer]').onclick = () => {
    let n = 3; const cd = wrap.querySelector('.count'); cd.textContent = n;
    const iv = setInterval(() => { n--; cd.textContent = n || ''; if (!n) { clearInterval(iv); snap(); } }, 1000);
  };
  wrap.querySelector('[data-a=close]').onclick = close;
}
async function renderLibrary() {
  const list = (await all('characters')).sort((x, y) => y.created - x.created), box = $('#library');
  if (!list.length) { box.innerHTML = '<p class="hint">Characters you send from the Characters tab collect here.</p>'; return; }
  const used = new Set(rec.actors.map((a) => a.charId));
  box.replaceChildren(...list.map((c) => {
    const d = document.createElement('div'); d.className = 'libitem'; d.title = `add another ${c.name}`;
    d.innerHTML = `<img src="${c.thumb}" alt=""><span>${esc(c.name)}</span>${used.has(c.id) ? '' : '<button title="delete from the library">×</button>'}`;
    d.onclick = () => addActor(c.id);
    d.querySelector('button')?.addEventListener('click', async (e) => { e.stopPropagation(); await del('characters', c.id); chars.delete(c.id); renderLibrary(); });
    return d;
  }));
}
const MOOD = [['time', 'time of day', 0, 1], ['haze', 'fog', 0, 1], ['wrongness', 'wrongness', 0, 1], ['skyHue', 'sky hue', -60, 60]];
function renderMood() {
  const box = $('#moodBox'), p = terrainParams();
  const lk = document.createElement('div'); lk.className = 'row';
  lk.innerHTML = `<span>Look</span><select title="drawn: the PS2 drawn textures · photo: photographed surfaces, PS2 horror · source: lit photo materials with shadows, like Garry's Mod (per scene)">${[['', 'drawn'], ['photo', 'photo (PS2 horror)'], ['source', "source (Garry's Mod)"]].map(([v, l]) => `<option value="${v}" ${(look() || '') === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  lk.querySelector('select').onchange = (e) => { rec.terrain ||= { ...TERRAIN_DEFAULTS, biome: structuredClone(VILLAGE) }; if (e.target.value) rec.terrain.look = e.target.value; else delete rec.terrain.look; refreshLook(); autosave(); };
  box.replaceChildren(lk, ...MOOD.map(([k, label, mn, mx]) => {
    const row = document.createElement('div'); row.className = 'row';
    row.innerHTML = `<span>${label}</span><input type="range" min="${mn}" max="${mx}" step="${(mx - mn) / 200}" value="${p[k]}"><output>${(+p[k]).toFixed(2)}</output>`;
    const input = row.querySelector('input'), out = row.querySelector('output');
    input.oninput = () => { rec.terrain ||= { ...TERRAIN_DEFAULTS, biome: structuredClone(VILLAGE) }; rec.terrain[k] = +input.value; out.textContent = (+input.value).toFixed(2); requestTerrain(); };
    return row;
  }));
}
let terrainPending = 0;
function requestTerrain() { cancelAnimationFrame(terrainPending); terrainPending = requestAnimationFrame(() => { buildTerrain(false); for (const o of actors.values()) place(o); updateRing(); autosave(); }); }
async function renderScenes() {
  const list = (await listScenes()).sort((x, y) => y.updated - x.updated), box = $('#sceneList');
  if (!list.length) { box.innerHTML = '<p class="hint">Scenes show up here.</p>'; return; }
  box.replaceChildren(...list.map((s) => {
    const d = document.createElement('div'); d.className = 'scenerow' + (s.id === rec.id ? ' on' : '');
    d.innerHTML = `<div><b>${esc(s.name)}</b><br><span class="meta">${new Date(s.updated).toLocaleString()} · ${(s.actors || []).length} char · ${esc(s.terrain?.name || 'default village')}</span></div><button data-a="load">Open</button><button data-a="del" title="delete this scene (its file)">×</button>`;
    d.querySelector('[data-a=load]').onclick = () => openSaved(s);
    d.querySelector('[data-a=del]').onclick = async () => { if (!confirm(`Delete the scene “${s.name}” (scenes/${s.id}.json)?`)) return; await removeScene(s.id); if (rec.id === s.id) { await newScene(true); } renderScenes(); };
    return d;
  }));
}

$('#sceneName').onchange = () => { rec.name = $('#sceneName').value.trim() || 'Untitled scene'; autosave(); stage.drawCard(rec.name); };
// go to a saved scene (it becomes the working copy)
async function openSaved(s) {
  await flushSave();
  stopBeds(); for (const v of speaking.values()) v.stop();
  await openScene(s.id); selected = null; selectedProp = null; terrainKey = ''; await load(true); status(`opened “${s.name}” (scenes/${s.id}.json)`);
}
async function flushSave() { if (saveT) { clearTimeout(saveT); saveT = 0; await setCurrentScene(rec); } }
async function newScene(force) {
  await flushSave();
  const sc = emptyScene('Untitled scene', await freeSceneId('Untitled scene')); await setCurrentScene(sc);
  selected = null; selectedProp = null; terrainKey = ''; await load(true); if (!force) status(`new scene: scenes/${sc.id}.json`);
}
// a small picture of the view, so saved scenes are easy to recognise in the finder
function viewThumb() {
  stage.render(performance.now() / 1000, { card: false });
  const c = document.createElement('canvas'); c.width = 160; c.height = 120; c.getContext('2d').drawImage(canvas, 0, 0, 160, 120);
  return c.toDataURL('image/jpeg', 0.75);
}
// the scene is its file and saves as you go; Save writes now (and a thumbnail), Save as new forks a copy
async function saveScene(asNew) {
  if (asNew) { const copy = { ...structuredClone(rec), id: await freeSceneId(rec.name), created: Date.now() }; rec = copy; }
  clearTimeout(saveT); saveT = 0; await setCurrentScene(rec);
  put('meta', `thumb:${rec.id}`, viewThumb()).catch(() => {});
  renderMeta(); renderScenes(); status(`saved scenes/${rec.id}.json`);
}
$('#save').onclick = () => saveScene(false);
$('#saveAs').onclick = () => saveScene(true);
$('#newScene').onclick = () => newScene(false);
$('#fullscreen').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : canvas.parentElement.requestFullscreen?.()); // the wrapper: subtitles come along
$('#walkMode').onclick = () => {
  walking = !walking; keys.clear();
  $('#walkMode').textContent = walking ? 'Walk: on (click the view)' : 'Walk (WASD)'; $('#walkMode').classList.toggle('on', walking);
  if (walking) { me.x = camera.position.x; me.z = camera.position.z; if (!world.walkable(me.x, me.z)) { me.x = 0; me.z = 0; } me.y = world.floor(me.x, me.z); me.yaw = cam.yaw; me.pitch = 0; } // keep looking where the fly camera looked
  else if (document.pointerLockElement === canvas) document.exitPointerLock();
};

// ---------------- export ----------------
function download(blob, file) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = file; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 10000); }
$('#exportGlb').onclick = async () => {
  const out = new THREE.Group(); out.name = rec.name;
  const terrain = bakeForExport(world.group); terrain.name = 'terrain'; out.add(terrain);
  // props without their sitters (the characters are exported on their own, with their skeletons)
  const sitting = [...actors.values()].filter((o) => o.root.parent?.name === 'seat').map((o) => [o.root, o.root.parent]);
  for (const [r] of sitting) r.removeFromParent();
  try { for (const pr of props.values()) { const g = bakeForExport(pr.built.group); g.name = PROPS[pr.data.kind].label; out.add(g); } }
  finally { for (const [r, st] of sitting) st.add(r); }
  for (const o of actors.values()) { // characters in their current pose, with the materials they were exported with
    const c = SkeletonUtils.clone(o.root); c.name = o.data.name;
    o.root.updateMatrixWorld(true); o.root.matrixWorld.decompose(c.position, c.quaternion, c.scale); // world placement (sitting ones hang under their seat)
    c.traverse((m) => { if (m.isMesh) m.material = Array.isArray(m.material) ? m.material.map((x) => x.userData.orig || x) : m.material.userData.orig || m.material; });
    out.add(c);
  }
  out.userData = { scene: { format: 'dreamare-scene', name: rec.name, terrain: rec.terrain, actors: rec.actors, props: rec.props || [] } };
  const glb = await new GLTFExporter().parseAsync(out, { binary: true });
  download(new Blob([glb], { type: 'model/gltf-binary' }), `${slug(rec.name)}.glb`);
  status(`exported ${slug(rec.name)}.glb (${(glb.byteLength / 1e6).toFixed(1)} MB)`);
};
const b64 = (buf) => { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => { const bin = atob(s), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u.buffer; };
$('#exportFile').onclick = async () => {
  const ids = [...new Set(rec.actors.map((a) => a.charId))], characters = [];
  for (const id of ids) { const c = await get('characters', id); if (c) characters.push({ id: c.id, name: c.name, thumb: c.thumb, created: c.created, glb: b64(c.glb) }); }
  // voice lines travel inside the file (assets/ files too, so the scene works anywhere)
  const scene = { ...structuredClone(rec), savedId: undefined, savedAt: undefined }, audio = [], seen = new Map();
  for (const a of scene.actors) if (a.voice) {
    if (!seen.has(a.voice.src)) { const id = a.voice.src.startsWith('db:') ? a.voice.src.slice(3) : uid(); seen.set(a.voice.src, id); try { const caps = await loadCaptions(a.voice.src); audio.push({ id, name: a.voice.name, data: b64(await rawBytes(a.voice.src)), cues: caps?.cues || null }); } catch { seen.set(a.voice.src, null); } }
    const id = seen.get(a.voice.src); if (id) a.voice.src = `db:${id}`; else a.voice = null;
  }
  const file = { format: 'dreamare-scene', version: 2, scene, characters, audio };
  const blob = new Blob([JSON.stringify(file)], { type: 'application/json' });
  download(blob, `${slug(rec.name)}.scene.json`);
  status(`exported ${slug(rec.name)}.scene.json (${characters.length} characters${audio.length ? `, ${audio.length} voice line${audio.length > 1 ? 's' : ''}` : ''}, ${(blob.size / 1e6).toFixed(1)} MB)`);
};
$('#importFile').onclick = () => $('#importInput').click();
$('#importInput').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    const j = JSON.parse(await f.text());
    if (j.format !== 'dreamare-scene') throw new Error('not a Dreamare scene file');
    for (const c of j.characters) if (!(await get('characters', c.id))) await put('characters', c.id, { ...c, glb: unb64(c.glb) });
    for (const au of j.audio || []) {
      if (!(await get('audio', au.id))) await put('audio', au.id, { id: au.id, name: au.name, data: unb64(au.data), created: Date.now() });
      if (au.cues && !(await loadCaptions(`db:${au.id}`))) await saveCaptions(`db:${au.id}`, { src: `db:${au.id}`, cues: au.cues, created: Date.now() });
    }
    await flushSave();
    const { savedId, savedAt, thumb, ...sc } = j.scene; rec = { ...sc, id: await freeSceneId(sc.name) }; await setCurrentScene(rec); selected = null; selectedProp = null; terrainKey = ''; await load(true);
    status(`imported “${rec.name}” (${j.characters.length} characters) as scenes/${rec.id}.json`);
  } catch (err) { status(`could not import ${f.name}: ${err.message}`); }
};

// ---------------- loop ----------------
let last = performance.now();
function frame(now) {
  if (PLAYER) { playerFrame(now); return; }
  if (film) { if (!film.exporting) filmFrame(now); requestAnimationFrame(frame); return; } // (an export drives the frames itself)
  const t = now / 1000, dt = Math.min(0.1, (now - last) / 1000); last = now;
  placeCamera(dt);
  for (const pr of props.values()) { followFace(pr); pr.built.update?.(t, camera); } // (the camera: props that watch it, like the leaning lamps)
  for (const o of actors.values()) {
    const rp = rawPose(o);
    if (!rp) { // (no pose: always an animation playing)
      if (!o.action) setAnim(o, o.data.anim);
      const es = episodeState(o, t);
      approach(o, es ? es.te : t, es?.ahead); clipBegin(o); if (es) o.mixer.setTime(es.te); else o.mixer.update(dt); clipEnd(o); episode(o, (o.ep = es?.cur)); faceLife(o, t); continue;
    }
    if (o.tween) { o.tween.t = Math.min(1, o.tween.t + dt / 0.35); const k = o.tween.t * o.tween.t * (3 - 2 * o.tween.t); applyPose(o.rig, lerpPose(o.tween.from, rp, k)); if (o.tween.t >= 1) o.tween = null; }
    else applyPose(o.rig, rp);
    if (o.data.breathe && !(hdrag && hdrag.o === o)) breathe(o.rig, t, (o.data.id.charCodeAt(0) % 7) * 0.9); // each breathes on its own rhythm
    if (!(hdrag && hdrag.o === o)) { faceLife(o, t); leanIn(o); }
  }
  reachCamera(); holdCam(P.curT ?? performance.now() / 1000); gripHands(P.curT ?? performance.now() / 1000);
  followers();
  for (const o of actors.values()) updateLook(o, dt);
  for (const o of actors.values()) faceOnProp(o);
  for (const pr of props.values()) if (pr.data.follow) { followFace(pr); pr.built.update?.(P.curT ?? t, camera); } // (again, after the heads have turned: the rays stay on the face)
  updateVoices(dt);
  updateCaptions();
  $('#playScene').textContent = speaking.size ? '■ Stop' : '▶ Play scene';
  updateHandles();
  // while the scene plays (or records), no editor markers: selection ring and pose handles hide
  const performing = speaking.size > 0 || !!recorder;
  ring.visible = ringWanted && !performing;
  if (performing) handles.visible = false;
  world.update?.(t, camera.position);
  mistStep(t); rig.setLights(collectLights()); rig.update(camera, look() === 'source'); if (look() === 'source') syncLook(scene);
  stage.render(t);
  if (recorder) drawRecFrame();
  requestAnimationFrame(frame);
}

// ---------------- open scene: a quick finder over the saved scenes (⌘O) ----------------
async function openFinder() {
  document.querySelector('.finder')?.remove();
  const scenes = (await listScenes()).sort((a, b) => b.updated - a.updated);
  for (const sc of scenes) sc.thumb = await get('meta', `thumb:${sc.id}`).catch(() => null);
  const wrap = document.createElement('div'); wrap.className = 'finder';
  wrap.innerHTML = `<div class="finderbox"><input placeholder="find a scene: its name, a character, the place…" spellcheck="false"><div class="finderlist"></div><p class="meta">↑ ↓ to choose · Enter to open · Esc to close</p></div>`;
  document.body.appendChild(wrap);
  const input = wrap.querySelector('input'), list = wrap.querySelector('.finderlist');
  let hits = [], k = 0;
  const hay = (sc) => [sc.name, sc.terrain?.name, ...(sc.actors || []).map((a) => a.name), ...(sc.props || []).map((p) => PROPS[p.kind]?.label || p.kind)].filter(Boolean).join(' · ');
  const close = () => wrap.remove();
  const draw = () => {
    const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    hits = scenes.filter((sc) => { const h = hay(sc).toLowerCase(); return words.every((w) => h.includes(w)); });
    k = Math.min(k, Math.max(0, hits.length - 1));
    list.replaceChildren(...(hits.length ? hits.map((sc, i) => {
      const row = document.createElement('div'); row.className = 'findrow' + (i === k ? ' on' : '') + (sc.id === rec.id ? ' current' : '');
      const who = (sc.actors || []).map((a) => a.name.split(' ')[0]);
      row.innerHTML = `${sc.thumb ? `<img src="${sc.thumb}" alt="">` : '<div class="nothumb"></div>'}<div><b>${esc(sc.name)}</b>${sc.id === rec.id ? ' <span class="meta">(open)</span>' : ''}<br><span class="meta">${esc(sc.terrain?.name || 'default village')} · ${who.length ? esc([...new Set(who)].join(', ')) : 'nobody'} · ${new Date(sc.updated).toLocaleString()}</span></div>`;
      row.onmouseenter = () => { k = i; list.querySelectorAll('.findrow').forEach((r, j) => r.classList.toggle('on', j === k)); };
      row.onclick = () => { close(); openSaved(sc); };
      return row;
    }) : [Object.assign(document.createElement('p'), { className: 'hint', textContent: scenes.length ? 'no saved scene matches' : 'no saved scenes yet: Scene > Save scene (⌘S)' })]));
    list.querySelector('.findrow.on')?.scrollIntoView({ block: 'nearest' });
  };
  input.oninput = () => { k = 0; draw(); };
  input.onkeydown = (e) => {
    if (e.key === 'ArrowDown') { k = Math.min(hits.length - 1, k + 1); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { k = Math.max(0, k - 1); draw(); e.preventDefault(); }
    else if (e.key === 'Enter' && hits[k]) { close(); openSaved(hits[k]); }
    else if (e.key === 'Escape') close();
    e.stopPropagation(); // typing here never flies the camera
  };
  wrap.onpointerdown = (e) => { if (e.target === wrap) close(); };
  draw(); input.focus();
}

// ---------------- shots: named viewpoints stored in the scene ----------------
function renderShots() {
  const box = $('#shotBox'); if (!box) return;
  rec.shots ||= [];
  box.innerHTML = rec.shots.map((sh, k) => `<div class="scenerow"><div><b>${esc(sh.name)}</b></div><button data-go="${k}">Go</button><button data-rm="${k}" title="remove this shot">×</button></div>`).join('') + '<div class="buttons"><button id="addShot" style="grid-column: span 2">+ Save this view as a shot</button></div>';
  box.querySelectorAll('[data-go]').forEach((b) => { b.onclick = () => goShot(rec.shots[+b.dataset.go]); });
  box.querySelectorAll('[data-rm]').forEach((b) => { b.onclick = () => { rec.shots.splice(+b.dataset.rm, 1); autosave(); renderShots(); }; });
  $('#addShot').onclick = () => {
    const name = prompt('Name this shot', `shot ${rec.shots.length + 1}`); if (!name) return;
    const look = cam.pos.clone().addScaledVector(fwd(), 5);
    rec.shots.push({ name, pos: cam.pos.toArray().map((v) => +v.toFixed(3)), look: look.toArray().map((v) => +v.toFixed(3)) }); autosave(); renderShots();
  };
}
// a shot: { name, pos: <point>, look: <point> } (points can be references: "rocking-chair", { at: "Reginald", offset: [...] })
function goShot(sh) { if (walking) $('#walkMode').click(); const p = resolvePoint(sh.pos), t = resolvePoint(sh.look); if (!p || !t) { status(`shot “${sh.name}” points at something that isn't in the scene`); return; } flyTo(p, t); }

// ---------------- the top bar ----------------
const press = (id) => () => $(id).click();
if (!PLAYER) menubar([
  { label: 'Scene', items: [
    { label: 'New scene', action: press('#newScene') },
    { label: 'Save scene', key: '⌘S', action: press('#save') },
    { label: 'Save as new', key: '⇧⌘S', action: press('#saveAs') },
    { label: 'Open scene…', key: '⌘O', action: openFinder },
    '-',
    { label: 'Import scene file…', action: press('#importFile') },
    { label: 'Export scene file', action: press('#exportFile') },
    { label: 'Export GLB', action: press('#exportGlb') },
  ] },
  { label: 'View', items: [
    { label: 'Full screen', action: press('#fullscreen') },
    { label: 'Walk mode', checked: () => walking, action: press('#walkMode') },
    { label: 'Reset view', key: 'Home', action: () => resetCamera(false) },
  ] },
  { label: 'Play', items: [
    { label: () => (speaking.size ? 'Stop' : 'Play scene'), key: 'P', action: press('#playScene') },
    { label: () => (recorder ? 'Stop recording and save' : 'Record vertical video'), checked: () => !!recorder, action: press('#record') },
    '-',
    { label: 'Snapshot for Slides', key: 'K', action: press('#snapshot') },
  ] },
]);
addEventListener('keydown', (e) => { // ⌘S / Ctrl+S save, with Shift: save as new
  if ((e.metaKey || e.ctrlKey) && e.code === 'KeyS') { e.preventDefault(); $(e.shiftKey ? '#saveAs' : '#save').click(); }
  if ((e.metaKey || e.ctrlKey) && e.code === 'KeyO') { e.preventDefault(); openFinder(); }
});

window.__editor = { goShot, resolvePoint, refreshLibrary, get library() { return library; }, openFinder, startRec, stopRec, alignScript, loadCaptions, speaking, speak, playScene, renderActorBox, THREE, pickActor, pickProp, setRay, __ray: () => ray, handles, get selected() { return selected; }, get selectedProp() { return selectedProp; }, get rec() { return rec; }, actors, props, spawnProp, seatActor, selectProp, openMenu, get picking() { return picking; }, select, addActor, load, camera, cam, stage, poseFromImage, setPose, get world() { return world; }, set editPose(v) { editPose = v; } };
// ---------------- player mode ----------------
// P.frozen: the time the scene is stopped at (null: live). Frozen or paused, nothing renders at all: one frame
// is drawn when it's asked for and the loop stops. Live, it renders at most 30 times a second.
// P.light: room lights (props with setLight, e.g. the bedroom), 1 on .. 0 out; the slides fade it.
const P = { queue: Promise.resolve(), outW: 540, frozen: null, paused: true, looping: false, lastT: 0, lastRender: 0, shot: null, onFrame: null, id: null, light: 1 };
function applyShot() {
  const sh = P.shot; if (!sh) return;
  const p = resolvePoint(sh.pos), t = resolvePoint(sh.look);
  // move: { pos, look, secs, ease }: ease 'out' is a snatch (full speed at once, then settling); the camera glides from the shot to there over secs (eased), from when the shot was shown
  if (p && t && sh.move) {
    const u0 = Math.min(1, Math.max(0, (P.curT ?? 0) - (P.showT ?? P.curT ?? 0)) / (sh.move.secs || 10)), k = sh.move.ease === 'out' ? 1 - (1 - u0) ** 3 : ease(u0), p2 = resolvePoint(sh.move.pos || sh.pos), t2 = resolvePoint(sh.move.look || sh.look);
    if (p2 && t2) { p.lerp(p2, k); t.lerp(t2, k); }
  }
  // shake: a handheld camera (the amplitude, ~0.01..0.05): slow drift and breathing, smooth noise of time
  if (p && t && sh.shake) { const T = P.curT ?? 0, a = sh.shake, n = (f, k) => Math.sin(T * f + k) * 0.6 + Math.sin(T * f * 2.3 + k * 1.7) * 0.3 + Math.sin(T * f * 5.1 + k * 3.1) * 0.1;
    p.x += n(0.7, 1) * a; p.y += n(0.9, 2) * a * 0.7; p.z += n(0.6, 3) * a; t.x += n(0.5, 4) * a * 6; t.y += n(0.8, 5) * a * 4; }
  if (p && t) { camera.position.copy(p); camera.lookAt(t); }
  // roll: a tilted horizon (radians), eased toward move.roll during a move
  const roll = (sh.roll || 0) + (sh.move?.roll != null ? (sh.move.roll - (sh.roll || 0)) * ease(Math.max(0, (P.curT ?? 0) - (P.showT ?? P.curT ?? 0)) / (sh.move.secs || 10)) : 0);
  if (roll) camera.rotateZ(roll);
  // hide: [prop / actor ids] this shot leaves out (a cinematic cheat: the far city gone from the lonely shot, still
  // there in the wide one); only in the player, the editor always shows everything
  const hide = [...(sh.hide || []), ...(P.filmHide || [])]; // (+ the film's timeline: film.hide [{ actor, from }])
  for (const [id, pr] of props) pr.built.group.visible = !hide.includes(id);
  for (const [id, o] of actors) o.root.visible = !hide.includes(id);
}
function playerStep(t, dt) {
  if (P.showT == null) P.showT = t; // (the shot's own clock starts at its first frame drawn after show)
  P.curT = t;
  applyShot(); // (first: props that watch the camera must see where it is in this frame)
  for (const pr of props.values()) { followFace(pr); pr.built.update?.(t, camera); pr.built.setLight?.(P.light); }
  for (const o of actors.values()) {
    const rp = rawPose(o);
    if (!rp) { if (!o.action) setAnim(o, o.data.anim); const es = episodeState(o, t), te = es ? es.te : t; approach(o, te, es?.ahead); clipBegin(o); o.mixer.setTime(te); clipEnd(o); episode(o, (o.ep = es?.cur)); faceLife(o, t); continue; }
    applyPose(o.rig, rp);
    if (o.data.breathe) breathe(o.rig, t, (o.data.id.charCodeAt(0) % 7) * 0.9);
    faceLife(o, t);
  }
  applyShot();
  for (const o of actors.values()) leanIn(o);
  reachCamera(); holdCam(P.curT ?? performance.now() / 1000); gripHands(P.curT ?? performance.now() / 1000);
  followers();
  for (const o of actors.values()) updateLook(o, 1); // (a whole step: a frozen frame is fully settled)
  for (const o of actors.values()) faceOnProp(o);
  for (const pr of props.values()) if (pr.data.follow) { followFace(pr); pr.built.update?.(P.curT ?? t, camera); } // (again, after the heads have turned: the rays stay on the face)
  world.update?.(t, camera.position);
  mistStep(t); rig.setLights(collectLights()); rig.update(camera, look() === 'source'); if (look() === 'source') syncLook(scene);
  stage.render(t, { card: false });
  P.lastT = t;
  P.onFrame?.(t);
}
function playerFrame(now) {
  if (P.paused || P.frozen != null || !world) { P.looping = false; return; }
  if (now - P.lastRender >= 33 || P.onFrame) { const t = now / 1000; playerStep(t, Math.min(0.1, (now - P.lastRender) / 1000)); P.lastRender = now; }
  requestAnimationFrame(frame);
}
const kick = () => { if (!P.looping && !P.paused && P.frozen == null) { P.looping = true; requestAnimationFrame(frame); } };
async function playerLoad(id) {
  const r = await fetch(`/__scenes/${id}`); if (!r.ok) throw new Error(`no scene ${id}`);
  rec = await r.json(); rec.actors ||= []; rec.props ||= []; rec.shots ||= [];
  if (rec.id !== loadedId) { resolvedDirectives = []; loadedId = rec.id; for (const o of actors.values()) o.root.removeFromParent(); actors.clear(); selected = null; } // (a new scene: fresh actors; reusing them by id carried the last scene's pose, frozen, into this one)
  if (!library.length) await refreshLibrary();
  buildTerrain(false); syncProps(); await syncActors();
  applySceneDirectives(); await syncActors();
  P.id = id;
}
const shotOf = (i) => (typeof i === 'number' ? rec.shots[i] : rec.shots.find((x) => x.name === i)) || rec.shots[0] || { pos: 'spawn', look: { at: 'spawn', offset: [0, 0, -5] } };
window.__player = {
  // show a scene's shot; frozen: a time to stop at (null = live). Resolves once it's drawn.
  // (one at a time: two overlapping loads each spawned the characters, leaving a frozen duplicate in the scene)
  show(id, shot, opts) { const run = P.queue.then(() => this._show(id, shot, opts)); P.queue = run.catch(() => {}); return run; },
  async _show(id, shot, { frozen = null, outW = 540 } = {}) {
    P.outW = outW;
    if (P.id !== id) await playerLoad(id);
    else if (terrainKey) { const p = terrainParams(); stage.setRes(p.res, true, P.outW); }
    P.shot = shotOf(shot); P.frozen = frozen; P.light = 1;
    playerStep(frozen ?? performance.now() / 1000, 0.016); P.showT = null; // (the clock restarts at the next frame: the live loop's, or an export's first)
    P.paused = false; kick();
  },
  pause(v = true) { P.paused = v; if (!v) kick(); },
  freeze() { P.frozen = P.lastT; playerStep(P.lastT, 0); return P.lastT; }, // stop time at the frame on screen
  live() { P.frozen = null; kick(); },
  light(k) { P.light = k; }, // room lights, 1 on .. 0 out (taken up by the next frame drawn)
  // this frame at full size (1080 wide) as a JPEG; the time stays where it is
  capture(q = 0.9) {
    const p = terrainParams(), was = P.outW; stage.setRes(p.res, true, 1080); playerStep(P.frozen ?? P.lastT, 0);
    const url = canvas.toDataURL('image/jpeg', q); stage.setRes(p.res, true, was); playerStep(P.frozen ?? P.lastT, 0); return url;
  },
  setOutW(w) { P.outW = w; if (world) { stage.setRes(terrainParams().res, true, w); playerStep(P.frozen ?? P.lastT, 0); } },
  set onFrame(fn) { P.onFrame = fn; },
  // draw one frame at time t now (export drives the player this way: a hidden iframe's own loop is throttled)
  render(t) { playerStep(t, 1 / 30); },
  // (scripts / tests: any shot object, frozen at time t)
  showShotObject(sh, t) { P.shot = sh; P.frozen = t; playerStep(t, 0); },
  get canvas() { return canvas; },
  get shots() { return rec ? rec.shots.map((s) => s.name) : []; },
};
P.reload = async () => { const id = P.id; P.id = null; if (id) await window.__player.show(id, P.shot?.name, { frozen: P.frozen, outW: P.outW }); };

// ---------------- the scene's film (film.js): its shots on a timeline, 3D sound, played live or exported ----------------
let film = null, camLamp = null;
const FILM_T0 = 1000; // (the scene clock during a film: film time + this, so every run is the same)
function filmStep(ft) {
  const F = rec.film, e = shotAt(F, ft), sh = shotOf(e.shot);
  P.shot = sh; P.showT = FILM_T0 + e.from; P.frozen = null;
  // the fog thickening (film.fog: its distances times k) and the mist (film.mist), over time
  film.fog0 ||= [PS2.fogNear.value, PS2.fogFar.value];
  const fk = kf(F.fog, ft); PS2.fogNear.value = film.fog0[0] * fk; PS2.fogFar.value = Math.max(film.fog0[0] * fk + 0.5, film.fog0[1] * fk);
  P.mist = F.mist ? kf(F.mist, ft) : null;
  stage.tape = F.tape ?? 0; if (F.vhs != null) stage.vhs = F.vhs; // (the film's camcorder look)
  // camLight: [[t, intensity]], a dim light on the camera (a camcorder lamp), so a face up close reads
  if (F.camLight) { camLamp ||= new THREE.PointLight(0xfff1dc, 0, 3, 2); if (!camLamp.parent) scene.add(camLamp); camLamp.position.copy(camera.position); camLamp.intensity = kf(F.camLight, ft); }
  P.filmHide = (F.hide || []).filter((h) => ft >= (h.from ?? 0) && ft < (h.to ?? Infinity)).map((h) => h.actor);
  const mouth = film?.loaded ? mouths(F, film.loaded, ft) : new Map();
  for (const [id, o] of actors) o.filmMouth = mouth.get(id) || null;
  playerStep(FILM_T0 + ft, 1 / 30);
}
function filmEnd(msg) {
  if (!film) return;
  film.graph?.stop(); if (film.fog0) { PS2.fogNear.value = film.fog0[0]; PS2.fogFar.value = film.fog0[1]; } P.mist = null; P.filmHide = null; stage.tape = 0; camLamp?.removeFromParent(); film = null;
  for (const o of actors.values()) { o.filmMouth = null; o.root.visible = true; }
  for (const pr of props.values()) pr.built.group.visible = true;
  P.shot = null; stage.setRes(terrainParams().res, false); applyFrame();
  $('#playFilm').textContent = '🎬 Play film'; if (msg) status(msg);
}
async function playFilm() {
  if (film) { filmEnd('film stopped'); return; }
  if (!rec.film?.shots?.length) { status('this scene has no film yet (scene.film in its file: shots on a timeline, sounds)'); return; }
  const ctx = audioCtx(); status('loading the film\'s sound…');
  const loaded = await loadFilm(rec.film, ctx), t0 = ctx.currentTime + 0.15;
  film = { loaded, graph: buildGraph(ctx, loaded, outputBus(), t0), ctx, t0 };
  const p = terrainParams(); stage.setRes(look() === 'source' ? Math.max(p.res, 640) : p.res, true, 1080);
  $('#playFilm').textContent = '■ Stop film'; status(`playing the film (${rec.film.secs} s)`);
}
function filmFrame() {
  const ft = film.ctx.currentTime - film.t0;
  if (ft >= rec.film.secs) { filmEnd('film finished'); return; }
  filmStep(Math.max(0, ft));
  schedule(film.ctx, film.graph, film.ctx.currentTime, Math.max(0, ft), actors, camera, true);
}
// export: every frame rendered at 30 fps (not in real time), the sound mixed offline from the same positions
async function exportFilm() {
  if (!rec.film?.shots?.length) { status('this scene has no film yet'); return; }
  if (!window.VideoEncoder || !window.AudioEncoder) { status('exporting a film needs WebCodecs (Chrome, Edge)'); return; }
  if (film) filmEnd();
  const F = rec.film, FPS = 30, SR = 48000, n = Math.round(F.secs * FPS), W = 1080, H = 1920;
  const off = new OfflineAudioContext(2, Math.ceil(F.secs * SR), SR), loaded = await loadFilm(F, off);
  film = { loaded, graph: buildGraph(off, loaded, off.destination, 0), exporting: true };
  const p = terrainParams(); stage.setRes(look() === 'source' ? Math.max(p.res, 640) : p.res, true, W);
  const codec = (await Promise.all(['avc1.640033', 'avc1.4d0033', 'avc1.42E033'].map(async (c) => ((await VideoEncoder.isConfigSupported({ codec: c, width: W, height: H })).supported ? c : null)))).find(Boolean);
  const acfg = { codec: 'mp4a.40.2', sampleRate: SR, numberOfChannels: 2, bitrate: 192000 };
  const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: 'avc', width: W, height: H, frameRate: FPS }, audio: { codec: 'aac', sampleRate: SR, numberOfChannels: 2 }, fastStart: 'in-memory' });
  let failed = null;
  const enc = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: (e) => { failed = e; } });
  enc.configure({ codec, width: W, height: H, bitrate: 10e6, framerate: FPS });
  for (let i = 0; i < n && !failed; i++) {
    const ft = i / FPS; filmStep(ft); schedule(off, film.graph, ft, ft, actors, camera, false);
    const vf = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / FPS), duration: Math.round(1e6 / FPS) });
    enc.encode(vf, { keyFrame: i % (FPS * 2) === 0 }); vf.close();
    if (enc.encodeQueueSize > 8) await new Promise((ok) => enc.addEventListener('dequeue', ok, { once: true }));
    if (i % 15 === 0) { status(`rendering the film… ${ft.toFixed(1)} / ${F.secs} s`); await new Promise((ok) => setTimeout(ok)); }
  }
  await enc.flush(); enc.close();
  status('mixing the 3D sound…');
  const buf = await off.startRendering();
  const aenc = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: (e) => { failed = e; } });
  aenc.configure(acfg);
  for (let at = 0, B = 8192; at < buf.length; at += B) {
    const k = Math.min(B, buf.length - at), data = new Float32Array(k * 2);
    for (let c = 0; c < 2; c++) data.set(buf.getChannelData(c).subarray(at, at + k), c * k);
    const ad = new AudioData({ format: 'f32-planar', sampleRate: SR, numberOfFrames: k, numberOfChannels: 2, timestamp: Math.round((at / SR) * 1e6), data }); aenc.encode(ad); ad.close();
  }
  await aenc.flush(); aenc.close();
  filmEnd();
  if (failed) { status(`film export failed: ${failed.message}`); return; }
  muxer.finalize();
  const blob = new Blob([muxer.target.buffer], { type: 'video/mp4' }), file = `${slug(rec.name)}-film.mp4`;
  download(blob, file); status(`exported ${file} (${F.secs} s, 1080×1920, ${(blob.size / 1e6).toFixed(1)} MB, 3D sound)`);
}
if (!PLAYER) { $('#playFilm').onclick = playFilm; $('#exportFilm').onclick = exportFilm; }
window.__film = { play: playFilm, export: exportFilm, step: (t) => { film ||= { probe: true }; filmStep(t); } }; // (scripts: step the film without its sound)

await loadPhotos(); // (small: ~150 KB of CC0 photos, so the photo look is there on the first frame)
if (!PLAYER) await load(true);
else window.parent?.postMessage({ type: 'player-ready' }, location.origin);
requestAnimationFrame(frame);
