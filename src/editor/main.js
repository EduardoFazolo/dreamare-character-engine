// Scene editor: the current scene = a terrain (the Scenarios generator's inputs, rebuilt here) + characters
// (GLBs sent from the Characters tab) placed on it. Autosaves the working copy; save / save-as / load past
// scenes; export the whole scene as GLB, or as a scene file with the characters inside.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { ps2Material } from '../head.js';
import { generate } from '../scenario/gen.js';
import { createStage, bakeForExport } from '../scenario/stage.js';
import { VILLAGE } from '../scenario/biomes.js';
import { menubar } from '../menubar.js';
import { makeRig, detect, retarget, applyPose, snapshot, lerpPose, breathe, HANDLES, handlePos, dragHandle, dragStart, toRoot, toWorld, sitPose, hipsAt } from './pose.js';
import { PROPS, CATEGORIES, buildProp } from '../scenario/props.js';
import { assetList, importedList, importFile, loadVoice, playVoice, setListener, audioCtx, rawBytes, voiceStream } from './voice.js';
import { align, segments as speechSegments, loadCaptions, saveCaptions, cueAt } from './captions.js';
import { AMBIENCES, startBed, stopBed, setVolume as bedVolume, playing as bedPlaying, stopAll as stopBeds } from './ambience.js';
import { currentScene, setCurrentScene, emptyScene, onSceneChange, get, put, del, all, uid, newActor } from '../store.js';

const $ = (s) => document.querySelector(s);
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
const autosave = () => { clearTimeout(saveT); saveT = setTimeout(() => { saveT = 0; setCurrentScene(rec); }, 250); };
// leaving the tab: write a pending change now instead of waiting for the debounce
addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && saveT) { clearTimeout(saveT); saveT = 0; setCurrentScene(rec); } });
addEventListener('pagehide', () => { if (saveT) { clearTimeout(saveT); saveT = 0; setCurrentScene(rec); } });

// ---------------- terrain ----------------
function terrainParams() { return { ...TERRAIN_DEFAULTS, ...(rec.terrain || {}), biome: structuredClone(rec.terrain?.biome || VILLAGE) }; }
function buildTerrain(force) {
  const p = terrainParams(), key = JSON.stringify(p);
  if (!force && key === terrainKey) return false;
  terrainKey = key;
  if (world) { scene.remove(world.group); world.group.traverse((m) => m.geometry?.dispose()); }
  world = generate(p);
  world.name = p.name;
  scene.add(world.group);
  stage.setRes(p.res); stage.vhs = p.vhs; stage.sat = p.sat;
  return true;
}

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
  const c = await loadChar(a.charId);
  if (!c) return null;
  const root = SkeletonUtils.clone(c.gltf.scene);
  ps2ify(root);
  const mixer = new THREE.AnimationMixer(root), clips = c.gltf.animations;
  const o = { root, mixer, clips, data: a, action: null, rig: makeRig(root), tween: null };
  root.userData.actorId = a.id;
  scene.add(root);
  actors.set(a.id, o);
  if (a.pose) o.mixer.stopAllAction(); else setAnim(o, a.anim);
  place(o);
  return o;
}
// a still pose (from a photo, the library or the handles) replaces the clip; it arrives smoothly
function setPose(o, pose, { tween = true } = {}) {
  const from = o.data.pose || snapshot(o.rig); // from wherever the body is now (the clip's current frame)
  o.mixer.stopAllAction(); o.action = null;
  o.data.pose = pose; o.data.breathe ??= true;
  o.tween = tween ? { from, t: 0 } : null;
  autosave();
}
function clearPose(o) { o.data.pose = null; o.tween = null; setAnim(o, o.data.anim === 'Custom' ? 'Idle' : o.data.anim); autosave(); }
function setAnim(o, name) {
  const clip = o.clips.find((c) => c.name === name) || o.clips.find((c) => c.name === 'Idle') || o.clips.find((c) => c.name === 'Pose') || o.clips[0];
  o.action?.stop();
  if (clip) { o.action = o.mixer.clipAction(clip); o.action.play(); o.data.anim = clip.name; }
}
function place(o) {
  const a = o.data, st = a.seat && props.get(a.seat.prop)?.built.seats[a.seat.idx];
  if (st) { // sitting: hang the character under the seat anchor, hips on it (it rocks / swings with the prop)
    if (o.root.parent !== st) st.add(o.root);
    if (!o.sitOffset) { applyPose(o.rig, a.pose); o.root.position.set(0, 0, 0); o.root.scale.setScalar(1); o.sitOffset = hipsAt(o.rig); }
    const turn = a.seatRot || 0; // turned on the seat, around the hips
    o.root.rotation.set(0, turn, 0); o.root.scale.setScalar(a.scale);
    o.root.position.copy(o.sitOffset).applyAxisAngle(new THREE.Vector3(0, 1, 0), turn).multiplyScalar(-a.scale);
    return;
  }
  if (o.root.parent !== scene) scene.add(o.root);
  o.root.position.set(a.x, world.floor(a.x, a.z), a.z);
  o.root.rotation.set(0, a.rotY, 0);
  o.root.scale.setScalar(a.scale);
}
// sent characters arrive with offsets relative to the spawn's view: turn them into world spots facing you
function settle(a) {
  if (!a.rel) return false;
  const y = world.homeYaw, fx = -Math.sin(y), fz = -Math.cos(y), rx = Math.cos(y), rz = -Math.sin(y);
  const x = rx * a.x + fx * -a.z, z = rz * a.x + fz * -a.z;
  a.x = x; a.z = z; a.rotY = Math.atan2(-x, -z); a.rel = false;
  return true;
}

// ---------------- props ----------------
const props = new Map(); // propId -> { data, built }
let selectedProp = null, picking = null; // picking: { propId } while choosing who sits
function placeProp(pr) {
  const d = pr.data, g = pr.built.group;
  g.position.set(d.x, world.height(d.x, d.z) - 0.02, d.z); g.rotation.set(0, d.rotY, 0); g.scale.setScalar(d.scale || 1);
}
function syncProps() {
  rec.props ||= [];
  const want = new Set(rec.props.map((p) => p.id));
  for (const [id, pr] of props) if (!want.has(id)) { scene.remove(pr.built.group); props.delete(id); }
  for (const d of rec.props) {
    let pr = props.get(d.id);
    if (!pr) { const built = buildProp(d.kind); if (!built) continue; built.group.userData.propId = d.id; pr = { data: d, built }; props.set(d.id, pr); scene.add(built.group); }
    pr.data = d; placeProp(pr);
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
  for (const h of hits) { let o = h.object; while (o && o.userData.propId == null) o = o.parent; if (o) return o.userData.propId; }
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
  let moved = false;
  for (const a of rec.actors) moved = settle(a) || moved;
  if (moved) autosave();
  const want = new Set(rec.actors.map((a) => a.id));
  for (const [id, o] of actors) if (!want.has(id)) { o.root.removeFromParent(); actors.delete(id); }
  for (const a of rec.actors) {
    const o = actors.get(a.id);
    if (o) { o.data = a; place(o); } else await spawnActor(a);
  }
  if (selected && !actors.has(selected)) selected = null;
  updateRing();
}

// ---------------- load / reload ----------------
async function load(fresh = true) {
  rec = await currentScene();
  renderPoses();
  const rebuilt = buildTerrain(false);
  syncProps();
  await syncActors();
  if (fresh || rebuilt) { resetCamera(); stage.drawCard(rec.name || world.name); }
  if (fresh) { stopBeds(); ambienceArmed = false; }
  syncAmbience();
  renderPanel();
}
onSceneChange(() => load(false)); // e.g. a character was sent from another tab

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
  const u = k('Space') + (rmb || !selected ? k('KeyE') - k('KeyQ') : 0); // Q/E turn a selected character unless you're looking
  // C toggles a crouch to half the travel height; easing down and back up works standing still too
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
  const grab = (hit && hit === selected) || (phit && phit === selectedProp);
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
    if (p && selectedProp) { const pr = props.get(selectedProp); pr.data.x = p.x; pr.data.z = p.z; placeProp(pr); updateRing(); }
    else if (p) { const o = actors.get(selected); if (o.data.seat) standUp(o, true); o.data.x = p.x; o.data.z = p.z; place(o); updateRing(); }
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
const FLY = /^(Key[WASDQE]|Space|Arrow(Up|Down|Left|Right)|Shift(Left|Right)|Alt(Left|Right))$/;
addEventListener('keydown', (e) => {
  if (e.target.closest?.('input[type=text], input:not([type]), select, textarea')) return; // typing a name
  if (e.target.tagName === 'BUTTON' || e.target.type === 'checkbox' || e.target.type === 'range') e.target.blur(); // keys fly the camera, they don't press panel controls
  if (e.code === 'KeyC' && !e.repeat) { if (walking) me.crouched = !me.crouched; else crouchOn = !crouchOn; } // crouch on / off
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
    if ((e.code === 'KeyQ' || e.code === 'KeyE') && !rmb) { pr.data.rotY += (e.code === 'KeyQ' ? 1 : -1) * (Math.PI / 12); placeProp(pr); autosave(); renderActorBox(); }
    if (e.code === 'Delete' || e.code === 'Backspace') { removeProp(selectedProp); e.preventDefault(); }
    return;
  }
  const o = selected && actors.get(selected); if (!o) return;
  if ((e.code === 'KeyQ' || e.code === 'KeyE') && !rmb) { const k = o.data.seat ? 'seatRot' : 'rotY'; o.data[k] = (o.data[k] || 0) + (e.code === 'KeyQ' ? 1 : -1) * (Math.PI / 12); place(o); autosave(); renderActorBox(); }
  if (e.code === 'Delete' || e.code === 'Backspace') { removeActor(selected); e.preventDefault(); }
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => { keys.clear(); endLook(); });

// ---------------- pose handles: drag hands, feet, head, chest, hips (IK does the rest) ----------------
let editPose = false, hdrag = null;
const HANDLE_COL = { LeftHand: 0x7fd6ff, RightHand: 0x7fd6ff, LeftFoot: 0x9dff9d, RightFoot: 0x9dff9d, Head: 0xffe07f, Spine2: 0xff9f7f, Hips: 0xff7fd0 };
const handles = new THREE.Group(); scene.add(handles);
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
  if (!o.data.pose) setPose(o, snapshot(o.rig), { tween: false }); // editing an animated character: start from its current frame
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
function updateLook(o, dt) {
  const a = o.data; o.lookW = THREE.MathUtils.clamp((o.lookW || 0) + (a.lookAtMe ? dt : -dt) / 0.35, 0, 1);
  if (o.lookW <= 0) { if (o.eyesTouched) { for (const m of eyeMeshes(o)) for (const k of EYES) m.morphTargetInfluences[m.morphTargetDictionary[k]] = 0; o.eyesTouched = false; } return; }
  const w = o.lookW * o.lookW * (3 - 2 * o.lookW), neck = o.rig.bones.Neck, head = o.rig.bones.Head;
  o.root.updateWorldMatrix(true, true);
  const eye = camera.position;
  turnToward(neck, eye, w * 0.35, 0.45); // neck: a third of the turn, up to ~26°
  turnToward(head, eye, w, 1.0); // head: the rest, up to ~57° more
  // eyes: what's left, measured in the head's own frame (+Z forward, +X the character's left, +Y up)
  head.getWorldQuaternion(_lq);
  _lv.copy(eye).sub(head.getWorldPosition(_lf)).applyQuaternion(_lq.invert()).normalize();
  // the look morphs turn the eyeballs 0.40 rad sideways and 0.32 rad up / down at full weight (faceanim.js)
  const yaw = Math.atan2(_lv.x, _lv.z), pitch = Math.atan2(_lv.y, Math.hypot(_lv.x, _lv.z));
  const look = { eyeLookLeft: Math.max(0, yaw) / 0.4, eyeLookRight: Math.max(0, -yaw) / 0.4, eyeLookUp: Math.max(0, pitch) / 0.32, eyeLookDown: Math.max(0, -pitch) / 0.32 };
  for (const m of eyeMeshes(o)) for (const k of EYES) m.morphTargetInfluences[m.morphTargetDictionary[k]] = Math.min(1, look[k]) * w;
  o.eyesTouched = true;
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
function renderPanel() { renderAmbience(); $('#sceneName').value = rec.name; renderMeta(); renderTerrain(); renderActorList(); renderActorBox(); renderLibrary(); renderMood(); renderScenes(); }
function renderMeta() { $('#sceneMeta').textContent = `${rec.actors.length} character${rec.actors.length === 1 ? '' : 's'} · ${rec.savedId ? `saved ${new Date(rec.savedAt || rec.updated).toLocaleString()}` : 'not saved yet (autosaved as the working copy)'}`; }
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
      ${sitters.length ? '<button data-a="unseat">Everyone stands</button>' : ''}<button data-a="rm">Remove</button>
    </div>`;
  const [turnI, scaleI] = box.querySelectorAll('input[type=range]'), outs = box.querySelectorAll('output');
  turnI.oninput = () => { d.rotY = +turnI.value; outs[0].textContent = `${Math.round((d.rotY * 180) / Math.PI)}°`; placeProp(pr); autosave(); };
  scaleI.oninput = () => { d.scale = +scaleI.value; outs[1].textContent = d.scale.toFixed(2); placeProp(pr); updateRing(); autosave(); };
  box.querySelector('[data-a=seat]')?.addEventListener('click', () => startPicking(d.id));
  box.querySelector('[data-a=unseat]')?.addEventListener('click', () => { for (const o of actors.values()) if (o.data.seat?.prop === d.id) standUp(o, true); autosave(); renderPanel(); });
  box.querySelector('[data-a=rm]').onclick = () => removeProp(d.id);
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
    <div class="buttons"><button data-a="dup">Duplicate</button><button data-a="face">Face the camera</button><button data-a="look" class="${a.lookAtMe ? 'on' : ''}" style="grid-column: span 2" title="only the face turns to you; the eyes look straight into the camera">${a.lookAtMe ? '◉ Looking at you' : '◎ Look at me'}</button>${a.seat ? '<button data-a="stand" style="grid-column: span 2">Stand up</button>' : ''}</div>
    <p class="meta">pose ${a.pose ? '<b>(custom, still)</b>' : '(playing the animation)'}</p>
    <div class="buttons">
      <button data-a="photo">From photo…</button><button data-a="cam">From webcam…</button>
      <button data-a="edit" class="${editPose ? 'on' : ''}" style="grid-column: span 2" title="drag the coloured handles: hands, feet, head, chest, hips">${editPose ? 'Editing pose: drag the handles' : 'Edit pose (handles)'}</button>
      <label><input type="checkbox" data-a="mirror"> mirror photo</label><label><input type="checkbox" data-a="breathe" ${a.breathe !== false ? 'checked' : ''}> breathing</label>
      <button data-a="savepose" ${a.pose ? '' : 'disabled'}>Save to poses</button><button data-a="anim" ${a.pose ? '' : 'disabled'}>Back to animation</button>
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
  box.querySelector('[data-a=dup]').onclick = async () => {
    const b = { ...structuredClone(a), id: uid(), x: a.x + 1.2, z: a.z + 0.6 };
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
  box.replaceChildren(...MOOD.map(([k, label, mn, mx]) => {
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
  const list = (await all('scenes')).sort((x, y) => y.updated - x.updated), box = $('#sceneList');
  if (!list.length) { box.innerHTML = '<p class="hint">Saved scenes show up here.</p>'; return; }
  box.replaceChildren(...list.map((s) => {
    const d = document.createElement('div'); d.className = 'scenerow' + (s.id === rec.savedId ? ' on' : '');
    d.innerHTML = `<div><b>${esc(s.name)}</b><br><span class="meta">${new Date(s.updated).toLocaleString()} · ${s.actors.length} char · ${esc(s.terrain?.name || 'default village')}</span></div><button data-a="load">Load</button><button data-a="del" title="delete this saved scene">×</button>`;
    d.querySelector('[data-a=load]').onclick = () => openSaved(s);
    d.querySelector('[data-a=del]').onclick = async () => { if (!confirm(`Delete the saved scene “${s.name}”?`)) return; await del('scenes', s.id); if (rec.savedId === s.id) { rec.savedId = null; autosave(); } renderScenes(); renderMeta(); };
    return d;
  }));
}

$('#sceneName').onchange = () => { rec.name = $('#sceneName').value.trim() || 'Untitled scene'; autosave(); stage.drawCard(rec.name); };
// go to a saved scene (it becomes the working copy)
async function openSaved(s) {
  stopBeds(); for (const v of speaking.values()) v.stop();
  rec = { ...structuredClone(s), id: uid(), savedId: s.id, savedAt: s.updated };
  delete rec.thumb;
  await setCurrentScene(rec); selected = null; terrainKey = ''; await load(true); status(`opened “${s.name}”`);
}
// a small picture of the view, so saved scenes are easy to recognise in the finder
function viewThumb() {
  stage.render(performance.now() / 1000, { card: false });
  const c = document.createElement('canvas'); c.width = 160; c.height = 120; c.getContext('2d').drawImage(canvas, 0, 0, 160, 120);
  return c.toDataURL('image/jpeg', 0.75);
}
async function saveScene(asNew) {
  const id = asNew || !rec.savedId ? uid() : rec.savedId, now = Date.now();
  const copy = { ...structuredClone(rec), id, updated: now, thumb: viewThumb() }; delete copy.savedId; delete copy.savedAt;
  await put('scenes', id, copy);
  rec.savedId = id; rec.savedAt = now; await setCurrentScene(rec);
  renderMeta(); renderScenes(); status(`saved “${rec.name}”`);
}
$('#save').onclick = () => saveScene(false);
$('#saveAs').onclick = () => saveScene(true);
$('#newScene').onclick = async () => {
  if (rec.actors.length && !rec.savedId && !confirm('Start a new, empty scene? This one was never saved.')) return;
  rec = emptyScene(); await setCurrentScene(rec); selected = null; terrainKey = ''; await load(true);
};
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
    rec = { ...j.scene, id: uid(), savedId: null }; await setCurrentScene(rec); selected = null; terrainKey = ''; await load(true);
    status(`imported “${rec.name}” (${j.characters.length} characters) as the current scene: save it to keep it in the list`);
  } catch (err) { status(`could not import ${f.name}: ${err.message}`); }
};

// ---------------- loop ----------------
let last = performance.now();
function frame(now) {
  const t = now / 1000, dt = Math.min(0.1, (now - last) / 1000); last = now;
  placeCamera(dt);
  for (const pr of props.values()) pr.built.update?.(t);
  for (const o of actors.values()) {
    if (!o.data.pose) { o.mixer.update(dt); continue; }
    if (o.tween) { o.tween.t = Math.min(1, o.tween.t + dt / 0.35); const k = o.tween.t * o.tween.t * (3 - 2 * o.tween.t); applyPose(o.rig, lerpPose(o.tween.from, o.data.pose, k)); if (o.tween.t >= 1) o.tween = null; }
    else applyPose(o.rig, o.data.pose);
    if (o.data.breathe && !(hdrag && hdrag.o === o)) breathe(o.rig, t, (o.data.id.charCodeAt(0) % 7) * 0.9); // each breathes on its own rhythm
  }
  for (const o of actors.values()) updateLook(o, dt);
  updateVoices(dt);
  updateCaptions();
  $('#playScene').textContent = speaking.size ? '■ Stop' : '▶ Play scene';
  updateHandles();
  // while the scene plays (or records), no editor markers: selection ring and pose handles hide
  const performing = speaking.size > 0 || !!recorder;
  ring.visible = ringWanted && !performing;
  if (performing) handles.visible = false;
  world.update?.(t, camera.position);
  stage.render(t);
  if (recorder) drawRecFrame();
  requestAnimationFrame(frame);
}

// ---------------- open scene: a quick finder over the saved scenes (⌘O) ----------------
async function openFinder() {
  document.querySelector('.finder')?.remove();
  const scenes = (await all('scenes')).sort((a, b) => b.updated - a.updated);
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
      const row = document.createElement('div'); row.className = 'findrow' + (i === k ? ' on' : '') + (sc.id === rec.savedId ? ' current' : '');
      const who = (sc.actors || []).map((a) => a.name.split(' ')[0]);
      row.innerHTML = `${sc.thumb ? `<img src="${sc.thumb}" alt="">` : '<div class="nothumb"></div>'}<div><b>${esc(sc.name)}</b>${sc.id === rec.savedId ? ' <span class="meta">(open)</span>' : ''}<br><span class="meta">${esc(sc.terrain?.name || 'default village')} · ${who.length ? esc([...new Set(who)].join(', ')) : 'nobody'} · ${new Date(sc.updated).toLocaleString()}</span></div>`;
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

// ---------------- the top bar ----------------
const press = (id) => () => $(id).click();
menubar([
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

window.__editor = { openFinder, startRec, stopRec, alignScript, loadCaptions, speaking, speak, playScene, renderActorBox, THREE, pickActor, pickProp, setRay, __ray: () => ray, handles, get selected() { return selected; }, get selectedProp() { return selectedProp; }, get rec() { return rec; }, actors, props, spawnProp, seatActor, selectProp, openMenu, get picking() { return picking; }, select, addActor, load, camera, cam, stage, poseFromImage, setPose, get world() { return world; }, set editPose(v) { editPose = v; } };
await load(true);
requestAnimationFrame(frame);
