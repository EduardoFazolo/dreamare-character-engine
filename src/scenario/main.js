// Scenarios page: seeded outdoor "nostalgic dream" places, same PS2 + VHS pipeline as the character page.
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { PS2 } from '../head.js';
import { generatePlace } from './kinds.js';
import { createStage, bakeForExport } from './stage.js';
import { setSceneTerrain } from '../store.js';
import { menubar } from '../menubar.js';
menubar();
import { createPhoneAudio } from './audio.js';
import { placeName } from '../names/gen.js';
import { VILLAGE, randomBiome } from './biomes.js';
import { biomeControls } from './biomeui.js';
import { createWorld, dropRegion, continueFrom, removeRegion, rerollBiome, regionById, cellOwner, neighborsOf, seaAngleOf, serialize, deserialize, DIRS } from './world.js';
import { drawMap, cellAt } from './mapview.js';
import { rng } from './util.js';
import { loadPhotos, applyLook, syncLook, sourceRig } from './photolook.js';

const $ = (s) => document.querySelector(s);

// [key, label, min, max]
const SCHEMA = [
  { group: 'Place', items: [['seed', 'seed', 1, 99999], ['density', 'prop density', 0, 2]] },
  { group: 'Mood', items: [['time', 'time of day', 0, 1], ['skyHue', 'sky hue', -60, 60], ['haze', 'fog', 0, 1], ['wrongness', 'wrongness', 0, 1]] },
  { group: 'Render', items: [['res', 'resolution', 120, 360], ['sat', 'colour', 0, 1.2], ['vhs', 'VHS', 0, 1], ['affine', 'texture warp', 0, 1]] },
];
const INT = new Set(['seed', 'res']);
const defaults = () => ({ seed: 1998, biome: structuredClone(VILLAGE), neighbors: [], seaAngle: undefined, density: 1, time: 0.3, skyHue: 0, haze: 0.62, wrongness: 0.2, res: 240, sat: 0.7, vhs: 0.6, affine: 0.5 });
function randomize() {
  const r = Math.random;
  return { ...params, seed: 1 + Math.floor(r() * 9998), density: 0.5 + r() * 1.2, time: r() < 0.2 ? 0.8 + r() * 0.2 : r() * 0.75, skyHue: r() < 0.7 ? 0 : (r() - 0.5) * 50, haze: 0.4 + r() * 0.5, wrongness: r() < 0.5 ? r() * 0.3 : r() };
}
let params = defaults();

// ---------------- renderer: the shared scenario look (low-res target -> VHS grade, title card) ----------------
const canvas = $('#view');
const stage = createStage(canvas), { renderer, scene, camera } = stage;
const setRes = stage.setRes, drawCard = stage.drawCard;

// ---------------- scene build ----------------
let world = null, wire = null, lastRes = 0;
function rebuild() {
  if (world) { scene.remove(world.group); dispose(world.group); }
  const seed = world?.seed;
  world = generatePlace(params); world.seed = params.seed;
  const reg = link != null ? regionById(atlas, link) : null;
  world.name = reg ? reg.name : placeName(params.seed, { kind: params.biome.water ? 'coast' : 'any' });
  $('#placeName').textContent = world.name;
  if (seed !== params.seed) drawCard(world.name);
  if (seed !== params.seed) { yaw = world.homeYaw; pitch = 0.02; walk = 0; me.x = me.z = 0; me.y = world.floor(0, 0); } // new place: start at the rise, facing up the path
  scene.add(world.group);
  updateWire();
  // the look (photolook.js): drawn (none), 'photo' or 'source' (sharper, lit, the tape wear nearly off)
  const src = params.look === 'source', res = src ? Math.max(params.res, 640) : params.res;
  if (params.look) applyLook(world.group, params.look);
  if (res !== lastRes) { setRes(res); lastRes = res; }
  stage.vhs = src ? Math.min(params.vhs, 0.15) : params.vhs; stage.sat = src ? Math.max(params.sat, 0.85) : params.sat;
  PS2.affine.value = params.affine;
  window.__app.world = world;
}
function dispose(o) { o.traverse((m) => { m.geometry?.dispose(); }); }
function updateWire() {
  if (wire) { scene.remove(wire); wire = null; }
  if (!$('#wire').checked || !world) return;
  wire = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: 0x40ffd0, wireframe: true, fog: false });
  world.group.updateMatrixWorld(true);
  world.group.traverse((m) => {
    if (!m.isMesh || m.name === 'sky') return;
    const w = new THREE.Mesh(m.geometry, mat); w.matrixAutoUpdate = false; w.matrix.copy(m.matrixWorld); wire.add(w);
  });
  scene.add(wire);
}

// ---------------- camera ----------------
// view mode: stand on the rise, drag to look, wheel to step along your view.
// walk mode: WASD / arrows (Shift runs), mouse look under pointer lock (click the view), Esc releases.
let yaw = 0.6, pitch = 0.04, walk = 0, drag = null, mode = 'view';
const me = { x: 0, z: 0, y: 0, phase: 0 }, keys = new Set();
const locked = () => document.pointerLockElement === canvas;
canvas.addEventListener('pointerdown', (e) => {
  if (mode === 'walk' && !locked()) { canvas.requestPointerLock?.(); return; }
  if (!locked()) { drag = [e.clientX, e.clientY]; canvas.setPointerCapture(e.pointerId); }
});
canvas.addEventListener('pointerup', () => { drag = null; });
const look = (dx, dy) => { yaw -= dx * 0.0025; pitch = Math.max(-1.2, Math.min(1.2, pitch - dy * 0.0022)); };
canvas.addEventListener('pointermove', (e) => {
  if (locked()) { look(e.movementX, e.movementY); return; }
  if (!drag) return;
  look((e.clientX - drag[0]) * 2, (e.clientY - drag[1]) * 1.8);
  drag = [e.clientX, e.clientY];
});
canvas.addEventListener('wheel', (e) => { e.preventDefault(); if (mode === 'view') walk = Math.max(-30, Math.min(30, walk - e.deltaY * 0.02)); }, { passive: false });
const MOVE = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyC', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight']);
addEventListener('keydown', (e) => {
  if (mode !== 'walk' || !MOVE.has(e.code) || e.target.closest?.('input, select')) return;
  if (e.code === 'KeyC') { if (!e.repeat) me.crouched = !me.crouched; e.preventDefault(); return; } // crouch on / off
  keys.add(e.code); e.preventDefault();
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

function setMode(m) {
  mode = m; keys.clear();
  $('#walkMode').textContent = m === 'walk' ? 'Walk: on' : 'Walk (WASD)';
  $('#walkMode').classList.toggle('on', m === 'walk');
  if (m === 'walk') { me.x = -Math.sin(yaw) * walk; me.z = -Math.cos(yaw) * walk; me.y = world.floor(me.x, me.z); $('#drift').checked = false; }
  else { walk = 0; if (locked()) document.exitPointerLock(); }
  $('#status').textContent = m === 'walk' ? 'click the view to look with the mouse · WASD / arrows to walk · Shift to run · C to crouch / stand · Esc releases the mouse' : 'drag to look around · wheel to zoom';
}

function stepWalk(dt) {
  const f = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
  const s = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
  const crouch = !!me.crouched; // C toggles: crouched to half your height, moving at half speed
  const moving = f || s, speed = (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 4.6 : 2.1) * (crouch ? 0.5 : 1);
  me.eyeH = (me.eyeH ?? 1.62) + ((crouch ? 0.81 : 1.62) - (me.eyeH ?? 1.62)) * Math.min(1, dt * 10);
  if (moving) {
    const l = Math.hypot(f, s), fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const dx = ((fx * f - fz * s) / l) * speed * dt, dz = ((fz * f + fx * s) / l) * speed * dt;
    // slide along the water's edge: try each axis on its own
    if (world.walkable(me.x + dx, me.z)) me.x += dx;
    if (world.walkable(me.x, me.z + dz)) me.z += dz;
    for (const [cx, cz, cr] of world.solids) { // push out of poles, trees, the house
      const ox = me.x - cx, oz = me.z - cz, d = Math.hypot(ox, oz), R = cr + 0.3;
      if (d < R && d > 1e-6) { me.x = cx + (ox / d) * R; me.z = cz + (oz / d) * R; }
    }
    me.phase += dt * speed * 2.6;
  }
  const g = world.floor(me.x, me.z);
  me.y += (g - me.y) * Math.min(1, dt * 12); // step smoothly over bumps and onto the pier
  return Math.sin(me.phase) * 0.035 * (moving ? 1 : 0);
}

function placeCamera(t, dt) {
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  let x, y, z;
  if (mode === 'walk') { const bob = stepWalk(dt); x = me.x; z = me.z; y = me.y + (me.eyeH ?? 1.62) + bob; }
  else { x = fx * walk; z = fz * walk; y = world.height(x, z) + 1.7 + Math.sin(t * 0.7) * 0.05; } // breathing
  camera.position.set(x, y, z);
  camera.lookAt(x + fx * Math.cos(pitch), y + Math.sin(pitch), z + fz * Math.cos(pitch));
  const o = window.__app.camOverride;
  if (o) { camera.position.set(...o.pos); camera.lookAt(...o.at); }
}

const rig = sourceRig(scene, renderer);
loadPhotos().then(() => { if (params.look) rebuild(); }); // (the photos: ~6 MB of CC0 textures, only used by the photo / source looks)
$('#look').onchange = (e) => { params.look = e.target.value || undefined; rebuild(); };
let last = performance.now();
function frame(now) {
  if (view === 'map') { last = now; requestAnimationFrame(frame); return; } // the map is drawn on demand
  const t = now / 1000, dt = Math.min(0.1, (now - last) / 1000); last = now;
  if (mode === 'view' && $('#drift').checked && !drag) yaw += dt * 0.03;
  placeCamera(t, dt);
  world.update?.(t, camera.position);
  rig.update(camera, params.look === 'source'); if (params.look === 'source') syncLook(world.group);
  stage.render(t);
  phone?.update(camera, world.group.getObjectByName('receiver'), world.group.getObjectByName('phonebooth'));
  requestAnimationFrame(frame);
}

// ---------------- sound: the song plays from the booth's receiver ----------------
// browsers need a gesture before audio can start: the first click or key anywhere starts it
// No sound is wired right now. To play something from the receiver again, import a file and pass its url:
//   import songUrl from '../../assets/some-song.wav?url';  const PHONE_AUDIO = songUrl;
const PHONE_AUDIO = null;
const phone = PHONE_AUDIO ? createPhoneAudio(PHONE_AUDIO) : null;
$('#sound').hidden = !phone;
let soundOn = true;
const syncSound = () => {
  if (!phone) return; $('#sound').textContent = !phone.started ? 'Sound: click to start' : soundOn ? 'Sound: on' : 'Sound: off'; $('#sound').classList.toggle('on', phone.started && soundOn); };
let justKicked = false; // the gesture that starts the sound shouldn't also toggle it off
const kick = () => { if (phone && !phone.started && soundOn) { justKicked = true; setTimeout(() => { justKicked = false; }); phone.start().then(syncSound); } };
addEventListener('pointerdown', kick, true); addEventListener('keydown', kick, true);
$('#sound').onclick = () => { if (phone?.started && !justKicked) { soundOn = !soundOn; phone.setMuted(!soundOn); } syncSound(); };

const slug = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
$('#placeName').onclick = () => drawCard(world.name); // show the card again

// ---------------- set scene: this place becomes the terrain of the editor's current scene ----------------
$('#setScene').onclick = async () => {
  const reg = link != null ? regionById(atlas, link) : null;
  const { seed, biome, neighbors, seaAngle, density, time, skyHue, haze, wrongness, res, sat, vhs, affine, look } = params;
  await setSceneTerrain({ kind: params.kind || 'emptymemories', seed, biome: structuredClone(biome), neighbors: structuredClone(neighbors), seaAngle, density, time, skyHue, haze, wrongness, res, sat, vhs, affine, ...(look ? { look } : {}), name: world.name, region: reg ? { id: reg.id, world: atlas.seed } : null });
  $('#status').innerHTML = `“${world.name}” is now the current scene’s terrain · <a href="/editor.html">open the editor ▸</a>`;
};

// ---------------- UI ----------------
const inputs = {};
let pending = 0;
const requestRebuild = () => { cancelAnimationFrame(pending); pending = requestAnimationFrame(rebuild); };
function buildControls() {
  const root = $('#controls');
  for (const g of SCHEMA) {
    const d = document.createElement('details'); d.open = true; d.innerHTML = `<summary>${g.group}</summary>`;
    for (const [k, label, mn, mx] of g.items) {
      const row = document.createElement('div'); row.className = 'row';
      row.innerHTML = `<span>${label}</span><input type="range" min="${mn}" max="${mx}" step="${INT.has(k) ? 1 : (mx - mn) / 200}"><output></output>`;
      const input = row.querySelector('input'), out = row.querySelector('output');
      input.addEventListener('input', () => {
        params[k] = Number(input.value); out.textContent = fmt(k);
        const reg = link != null ? regionById(atlas, link) : null; // a region's scene: its mood and seed live in the world
        if (reg) { if (k in reg.mood) reg.mood[k] = params[k]; if (k === 'seed') reg.seed = params[k]; saveAtlas(); }
        requestRebuild();
      });
      inputs[k] = { input, out }; d.appendChild(row);
    }
    root.appendChild(d);
  }
}
const fmt = (k) => (INT.has(k) ? String(params[k]) : (+params[k]).toFixed(2));
function syncControls() { for (const [k, { input, out }] of Object.entries(inputs)) { input.value = params[k]; out.textContent = fmt(k); } }

$('#randomize').onclick = () => { params = randomize(); writeBack(); syncControls(); rebuild(); };
$('#randBiome').onclick = () => { Object.assign(params.biome, randomBiome(rng(Math.random() * 1e9))); writeBack(); sceneBiome.sync(); rebuild(); };
$('#reset').onclick = () => { unlink(); params = defaults(); $('#look').value = ''; walk = 0; syncControls(); sceneBiome.sync(); rebuild(); };
function writeBack() { const reg = link != null ? regionById(atlas, link) : null; if (!reg) return; reg.seed = params.seed; for (const k in reg.mood) reg.mood[k] = params[k]; saveAtlas(); }
$('#wire').onchange = updateWire;
$('#walkMode').onclick = () => setMode(mode === 'walk' ? 'view' : 'walk');
$('#fullscreen').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : canvas.requestFullscreen?.());
document.addEventListener('fullscreenchange', () => { $('#fullscreen').textContent = document.fullscreenElement ? 'Exit full screen' : 'Full screen'; });
$('#exportGlb').onclick = async () => {
  // PS2 shader materials don't survive glTF: bake them to plain unlit textured materials (fog/snap are the host engine's job)
  const out = bakeForExport(world.group);
  out.userData = { scenario: { generator: 'dreamare-dunes', version: 2, name: world.name, params: { ...params }, spawn: world.spawn.toArray(), fog: { color: PS2.fogColor.value.toArray(), near: PS2.fogNear.value, far: PS2.fogFar.value } } };
  const glb = await new GLTFExporter().parseAsync(out, { binary: true });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([glb], { type: 'model/gltf-binary' }));
  a.download = `${slug(world.name)}-${params.seed}.glb`; a.click();
  $('#status').textContent = `exported ${a.download} (${(glb.byteLength / 1024).toFixed(0)} KB)`;
};

// ================= world map =================
// Regions live on a 2D map; the scene shows one region, faded toward its neighbours. The world autosaves in this
// browser (convenience) and saves / loads as a JSON file (the real save: every seed and biome is in it).
const KEY = 'dreamare.world';
let atlas = null, selected = null, hover = null, link = null, view = 'scene';
try { const j = localStorage.getItem(KEY); if (j) atlas = deserialize(JSON.parse(j)); } catch { atlas = null; }
atlas ||= createWorld();
function saveAtlas() { try { localStorage.setItem(KEY, JSON.stringify(serialize(atlas))); } catch { /* private mode: the file save still works */ } }
const mapCanvas = $('#map');
const redraw = () => drawMap(mapCanvas, atlas, { selected, hover });
function unlink() { link = null; $('#backToMap').hidden = true; }

function showView(v) {
  view = v;
  $('#mapPanel').hidden = v !== 'map'; $('#scenePanel').hidden = v !== 'scene';
  mapCanvas.hidden = v !== 'map'; canvas.hidden = v !== 'scene';
  $('#modeMap').classList.toggle('on', v === 'map'); $('#modeScene').classList.toggle('on', v === 'scene');
  if (v === 'map') { if (mode === 'walk') setMode('view'); redraw(); regionPanel(); $('#status').textContent = 'click empty land to drop a region · click a region to select · double-click to enter it'; }
  else $('#status').textContent = mode === 'walk' ? 'WASD to walk · click the view to look' : 'drag to look around · wheel to zoom';
}
$('#modeMap').onclick = () => showView('map');
$('#modeScene').onclick = () => showView('scene');
$('#backToMap').onclick = () => showView('map');

function enterRegion(reg) {
  link = reg.id; $('#backToMap').hidden = false;
  params = { ...params, ...reg.mood, seed: reg.seed, biome: reg.biome, neighbors: neighborsOf(atlas, reg), seaAngle: reg.biome.water ? seaAngleOf(atlas, reg) : undefined };
  world && (world.seed = -1); // force the arrival (title card, camera reset) even if the seed matches
  syncControls(); sceneBiome.sync(); rebuild(); showView('scene');
}

const mapBiomeRoot = document.createElement('div');
let mapBiome = null;
function regionPanel() {
  const box = $('#regionBox'), reg = selected != null ? regionById(atlas, selected) : null;
  if (!reg) { box.innerHTML = `<p class="hint">${atlas.regions.length ? 'Click a region to select it, or empty land to drop a new one.' : 'Click anywhere on the map to drop your first region (it starts as the village).'}</p>`; return; }
  const nb = neighborsOf(atlas, reg).length;
  box.innerHTML = `
    <p class="placename">${reg.name}</p>
    <p class="meta">${reg.biome.archetype} · ${reg.biome.trees !== 'none' ? reg.biome.trees : 'open'} · depth ${reg.depth} · ${nb} neighbour${nb === 1 ? '' : 's'} · seed ${reg.seed}${reg.locked ? ' · locked' : ''}</p>
    <div class="buttons">
      <button id="rEnter" style="grid-column: span 2">Generate scene ▸</button>
      <button id="rReroll" ${reg.locked ? 'disabled' : ''}>Randomize biome</button>
      <button id="rLock">${reg.locked ? 'Unlock' : 'Lock'}</button>
      <button id="rRemove" ${reg.locked ? 'disabled' : ''}>Remove</button>
      <button id="rDeselect">Deselect</button>
    </div>
    <p class="meta">continue from here:</p>
    <div class="compass">${['NW', 'N', 'NE', 'W', '', 'E', 'SW', 'S', 'SE'].map((d) => (d ? `<button data-dir="${d}">${d}</button>` : '<span></span>')).join('')}</div>`;
  box.querySelector('#rEnter').onclick = () => enterRegion(reg);
  box.querySelector('#rReroll').onclick = () => { if (rerollBiome(atlas, reg)) { changedAtlas(); } };
  box.querySelector('#rLock').onclick = () => { reg.locked = !reg.locked; changedAtlas(); };
  box.querySelector('#rRemove').onclick = () => { if (removeRegion(atlas, reg)) { if (link === reg.id) unlink(); selected = null; changedAtlas(); } };
  box.querySelector('#rDeselect').onclick = () => { selected = null; changedAtlas(); };
  box.querySelectorAll('[data-dir]').forEach((b) => { b.onclick = () => { const n = continueFrom(atlas, reg, b.dataset.dir); if (n) selected = n.id; else $('#status').textContent = `no free land to the ${b.dataset.dir}`; changedAtlas(); }; });
  box.appendChild(mapBiomeRoot);
  mapBiome = biomeControls(mapBiomeRoot, () => regionById(atlas, selected)?.biome, () => { changedAtlas(false); });
}
function changedAtlas(panel = true) { saveAtlas(); redraw(); if (panel) regionPanel(); }

mapCanvas.addEventListener('mousemove', (e) => { const [x, y] = cellAt(mapCanvas, atlas, e), o = cellOwner(atlas, x, y), h = o >= 0 ? o : null; if (h !== hover) { hover = h; redraw(); } });
mapCanvas.addEventListener('mouseleave', () => { hover = null; redraw(); });
mapCanvas.addEventListener('click', (e) => {
  const [x, y] = cellAt(mapCanvas, atlas, e), o = cellOwner(atlas, x, y);
  if (o >= 0) selected = o;
  else if (o === -1) { const reg = dropRegion(atlas, x, y); if (reg) selected = reg.id; else $('#status').textContent = 'not enough free land there'; }
  changedAtlas();
});
mapCanvas.addEventListener('dblclick', (e) => { const [x, y] = cellAt(mapCanvas, atlas, e), o = cellOwner(atlas, x, y); if (o >= 0) enterRegion(regionById(atlas, o)); });
$('#worldNew').onclick = () => { if (atlas.regions.length && !confirm('Start a new, empty world? (Save this one first if you want to keep it.)')) return; atlas = createWorld(); selected = null; unlink(); changedAtlas(); };
$('#worldSave').onclick = () => {
  const a = document.createElement('a'), first = atlas.regions[0]?.name || 'world';
  a.href = URL.createObjectURL(new Blob([JSON.stringify(serialize(atlas))], { type: 'application/json' }));
  a.download = `${slug(first)}-world-${atlas.seed}.json`; a.click();
  $('#status').textContent = `saved ${a.download} (${atlas.regions.length} regions)`;
};
$('#worldLoad').onclick = () => $('#worldFile').click();
$('#worldFile').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try { atlas = deserialize(JSON.parse(await f.text())); selected = null; unlink(); changedAtlas(); $('#status').textContent = `loaded ${f.name} (${atlas.regions.length} regions)`; }
  catch (err) { $('#status').textContent = `could not load ${f.name}: ${err.message}`; }
  e.target.value = '';
};

// scene-side biome controls edit params.biome (which is the linked region's biome object when in a region)
const sceneBiome = biomeControls($('#biomeScene'), () => params.biome, () => { if (link != null) saveAtlas(); requestRebuild(); });

window.__app = { get atlas() { return atlas; }, enterRegion, showView, me, phone, get mode() { return mode; }, get yaw() { return yaw; }, set yaw(v) { yaw = v; }, get params() { return params; }, set params(p) { params = p; syncControls(); rebuild(); }, randomize, defaults, rebuild };
buildControls(); syncControls(); sceneBiome.sync(); rebuild();
requestAnimationFrame(frame);
