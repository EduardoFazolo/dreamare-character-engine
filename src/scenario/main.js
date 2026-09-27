// Scenarios page: seeded outdoor "nostalgic dream" places, same PS2 + VHS pipeline as the character page.
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { PS2 } from '../head.js';
import { generate } from './gen.js';
import { createPhoneAudio } from './audio.js';
import { placeName } from '../names/gen.js';

const $ = (s) => document.querySelector(s);

// [key, label, min, max]
const SCHEMA = [
  { group: 'Place', items: [['seed', 'seed', 1, 9999], ['duneHeight', 'dune height', 0, 14], ['density', 'prop density', 0, 2]] },
  { group: 'Mood', items: [['time', 'time of day', 0, 1], ['skyHue', 'sky hue', -60, 60], ['haze', 'fog', 0, 1], ['wrongness', 'wrongness', 0, 1]] },
  { group: 'Render', items: [['res', 'resolution', 120, 360], ['sat', 'colour', 0, 1.2], ['vhs', 'VHS', 0, 1], ['affine', 'texture warp', 0, 1]] },
];
const INT = new Set(['seed', 'res']);
const defaults = () => ({ seed: 1998, duneHeight: 7, density: 1, time: 0.3, skyHue: 0, haze: 0.62, wrongness: 0.2, res: 240, sat: 0.7, vhs: 0.6, affine: 0.5 });
function randomize() {
  const r = Math.random;
  return { ...params, seed: 1 + Math.floor(r() * 9998), duneHeight: 2 + r() * 10, density: 0.5 + r() * 1.2, time: r() < 0.2 ? 0.8 + r() * 0.2 : r() * 0.75, skyHue: r() < 0.7 ? 0 : (r() - 0.5) * 50, haze: 0.4 + r() * 0.5, wrongness: r() < 0.5 ? r() * 0.3 : r() };
}
let params = defaults();

// ---------------- renderer: low-res target -> VHS upscale (copied from the character page) ----------------
const canvas = $('#view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
THREE.ColorManagement.enabled = false;
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, 4 / 3, 0.1, 800);

let lowRT;
const post = new THREE.ShaderMaterial({
  uniforms: { tex: { value: null }, lowRes: { value: new THREE.Vector2() }, vhs: { value: 0.6 }, time: { value: 0 }, sat: { value: 0.7 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tex; uniform vec2 lowRes; uniform float vhs, time, sat; varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main(){
      vec2 uv = vUv; uv.x += vhs * .0015 * sin(uv.y * 30. + time * 2.);
      vec2 px = 1. / lowRes;
      vec3 c = texture2D(tex, uv).rgb;
      vec3 blur = (texture2D(tex, uv - vec2(px.x, 0)).rgb + 2. * c + texture2D(tex, uv + vec2(px.x, 0)).rgb) * .25;
      float r = texture2D(tex, uv + vec2(px.x * 1.5, 0)).r, b = texture2D(tex, uv - vec2(px.x * 1.5, 0)).b;
      vec3 col = mix(c, mix(vec3(r, blur.g, b), blur, .4), vhs);
      col *= 1. - vhs * .1 * (.5 + .5 * sin(vUv.y * lowRes.y * 6.2832));
      col += (hash(vUv * 900. + time) - .5) * .05 * vhs;
      vec2 q = vUv - .5; col *= 1. - dot(q, q) * .7 * vhs;
      col = mix(col, col * vec3(1.03, .98, 1.06), vhs);
      // dream bloom: bright areas bleed softly
      vec3 halo = (texture2D(tex, uv + px * vec2(3., 2.)).rgb + texture2D(tex, uv - px * vec2(3., 2.)).rgb + texture2D(tex, uv + px * vec2(-2., 3.)).rgb + texture2D(tex, uv - px * vec2(-2., 3.)).rgb) * .25;
      col += max(halo - .6, 0.) * .6 * vhs;
      // old-console grade: drained colour, lifted blacks, a touch less contrast
      col = mix(vec3(dot(col, vec3(.299, .587, .114))), col, sat);
      col = col * .92 + .035;
      gl_FragColor = vec4(col, 1.);
    }`,
  depthTest: false,
});
const postScene = new THREE.Scene();
postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), post));
// area-name card (old RPG style): drawn into the frame itself, so full screen and recordings show it too
const cardCanvas = document.createElement('canvas'); cardCanvas.width = 1024; cardCanvas.height = 160;
const cardTex = new THREE.CanvasTexture(cardCanvas); cardTex.colorSpace = THREE.NoColorSpace;
const card = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: cardTex, transparent: true, opacity: 0, depthTest: false }));
card.position.set(0, -0.45, 0); postScene.add(card);
let cardT0 = -1e9;
function drawCard(name) {
  const g = cardCanvas.getContext('2d'), W = cardCanvas.width, H = cardCanvas.height;
  g.clearRect(0, 0, W, H);
  g.font = 'italic 64px Georgia, "Times New Roman", serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  const tw = Math.min(W - 40, g.measureText(name).width);
  g.strokeStyle = 'rgba(230,224,210,.55)'; g.lineWidth = 2; // thin rules either side, like an area title
  g.beginPath(); g.moveTo(W / 2 - tw / 2 - 20, H / 2 + 44); g.lineTo(W / 2 + tw / 2 + 20, H / 2 + 44); g.stroke();
  g.shadowColor = 'rgba(0,0,0,.85)'; g.shadowBlur = 10; g.shadowOffsetY = 3;
  g.fillStyle = '#ece6d6'; g.fillText(name, W / 2, H / 2, W - 40);
  cardTex.needsUpdate = true; cardT0 = performance.now() / 1000;
}
function fitCard() { // keep the card's pixels square whatever the frame's aspect
  const a = renderer.domElement.width / renderer.domElement.height, w = a > 1 ? 1.2 : 2.1;
  card.position.y = a > 1 ? -0.45 : -0.6; // lower third; lower still in the tall frame
  card.scale.set(w, (w * cardCanvas.height) / cardCanvas.width * a, 1);
}
const postCam = new THREE.OrthographicCamera(); postCam.position.z = 1; // the title card sits at z = 0, in front of the near plane
// normal: 4:3 at `h` lines. vertical (recording): 9:16, as wide in game pixels as the 4:3 frame is tall x 0.75
// (res 240 -> 180x320), output 1080-wide for TikTok.
let vertical = false;
function setRes(res) {
  let w, h, scale;
  if (vertical) { w = Math.round(res * 0.75); h = Math.round((w * 16) / 9); scale = 1080 / w; }
  else { h = res; w = Math.round((h * 4) / 3); scale = 3; }
  camera.aspect = w / h; camera.fov = vertical ? 70 : 55; camera.updateProjectionMatrix();
  canvas.classList.toggle('vertical', vertical);
  lowRT?.dispose();
  lowRT = new THREE.WebGLRenderTarget(w, h, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
  post.uniforms.tex.value = lowRT.texture;
  post.uniforms.lowRes.value.set(w, h);
  PS2.snapRes.value.set(w / 2, h / 2);
  renderer.setSize(Math.round(w * scale), Math.round(h * scale), false);
  fitCard();
}

// ---------------- scene build ----------------
let world = null, wire = null, lastRes = 0;
function rebuild() {
  if (world) { scene.remove(world.group); dispose(world.group); }
  const seed = world?.seed;
  world = generate(params); world.seed = params.seed;
  world.name = placeName(params.seed, { kind: 'coast' });
  $('#placeName').textContent = world.name;
  if (seed !== params.seed) drawCard(world.name);
  if (seed !== params.seed) { yaw = world.homeYaw; pitch = 0.02; walk = 0; me.x = me.z = 0; me.y = world.floor(0, 0); } // new place: start at the rise, facing up the path
  scene.add(world.group);
  updateWire();
  if (params.res !== lastRes) { setRes(params.res); lastRes = params.res; }
  post.uniforms.vhs.value = params.vhs; post.uniforms.sat.value = params.sat;
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
const MOVE = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight']);
addEventListener('keydown', (e) => { if (mode !== 'walk' || !MOVE.has(e.code) || e.target.closest?.('input, select')) return; keys.add(e.code); e.preventDefault(); });
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

function setMode(m) {
  mode = m; keys.clear();
  $('#walkMode').textContent = m === 'walk' ? 'Walk: on' : 'Walk (WASD)';
  $('#walkMode').classList.toggle('on', m === 'walk');
  if (m === 'walk') { me.x = -Math.sin(yaw) * walk; me.z = -Math.cos(yaw) * walk; me.y = world.floor(me.x, me.z); $('#drift').checked = false; }
  else { walk = 0; if (locked()) document.exitPointerLock(); }
  $('#status').textContent = m === 'walk' ? 'click the view to look with the mouse · WASD / arrows to walk · Shift to run · Esc releases the mouse' : 'drag to look around · wheel to zoom';
}

function stepWalk(dt) {
  const f = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
  const s = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
  const moving = f || s, speed = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 4.6 : 2.1;
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
  if (mode === 'walk') { const bob = stepWalk(dt); x = me.x; z = me.z; y = me.y + 1.62 + bob; }
  else { x = fx * walk; z = fz * walk; y = world.height(x, z) + 1.7 + Math.sin(t * 0.7) * 0.05; } // breathing
  camera.position.set(x, y, z);
  camera.lookAt(x + fx * Math.cos(pitch), y + Math.sin(pitch), z + fz * Math.cos(pitch));
  const o = window.__app.camOverride;
  if (o) { camera.position.set(...o.pos); camera.lookAt(...o.at); }
}

let last = performance.now();
function frame(now) {
  const t = now / 1000, dt = Math.min(0.1, (now - last) / 1000); last = now;
  if (mode === 'view' && $('#drift').checked && !drag) yaw += dt * 0.03;
  placeCamera(t, dt);
  world.update?.(t, camera.position);
  post.uniforms.time.value = t;
  { const a = t - cardT0; card.material.opacity = Math.min(THREE.MathUtils.smoothstep(a, 0.4, 1.4), 1 - THREE.MathUtils.smoothstep(a, 4.2, 5.4)); card.visible = card.material.opacity > 0.001; } // fade in, hold, fade out
  renderer.setRenderTarget(lowRT); renderer.render(scene, camera);
  renderer.setRenderTarget(null); renderer.render(postScene, postCam);
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

// ---------------- record: a vertical clip (video + the phone's audio) for TikTok ----------------
let rec = null;
function pickType() {
  for (const t of ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'])
    if (window.MediaRecorder?.isTypeSupported(t)) return t;
  return '';
}
async function startRec() {
  if (!window.MediaRecorder) { $('#status').textContent = 'recording is not supported in this browser'; return; }
  if (phone && !phone.started && soundOn) { await phone.start(); syncSound(); }
  vertical = true; setRes(params.res);
  const stream = canvas.captureStream(30), audio = phone?.stream(); // no phone audio -> a silent clip
  audio?.getAudioTracks().forEach((t) => stream.addTrack(t));
  const type = pickType(), chunks = [], t0 = performance.now();
  const mr = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 10e6, audioBitsPerSecond: 192e3 });
  mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  mr.onstop = () => {
    const ext = type.includes('mp4') ? 'mp4' : 'webm', blob = new Blob(chunks, { type: type.split(';')[0] || 'video/webm' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `${slug(world.name)}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${ext}`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    $('#status').textContent = `saved ${a.download} (${((performance.now() - t0) / 1000).toFixed(1)} s, ${(blob.size / 1e6).toFixed(1)} MB, 1080x1920${ext === 'webm' ? ', WebM: convert to MP4 if TikTok refuses it' : ''})`;
  };
  mr.start(250);
  rec = { mr, t0, timer: setInterval(() => { $('#record').textContent = `■ Stop ${((performance.now() - t0) / 1000).toFixed(0)}s`; }, 250) };
  $('#record').classList.add('on'); $('#record').textContent = '■ Stop 0s';
}
function stopRec() {
  if (!rec) return;
  clearInterval(rec.timer); rec.mr.stop(); rec = null;
  vertical = false; setRes(params.res);
  $('#record').classList.remove('on'); $('#record').textContent = '● Rec (vertical)';
}
$('#record').onclick = () => (rec ? stopRec() : startRec());

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
      input.addEventListener('input', () => { params[k] = Number(input.value); out.textContent = fmt(k); requestRebuild(); });
      inputs[k] = { input, out }; d.appendChild(row);
    }
    root.appendChild(d);
  }
}
const fmt = (k) => (INT.has(k) ? String(params[k]) : (+params[k]).toFixed(2));
function syncControls() { for (const [k, { input, out }] of Object.entries(inputs)) { input.value = params[k]; out.textContent = fmt(k); } }

$('#randomize').onclick = () => { params = randomize(); syncControls(); rebuild(); };
$('#reset').onclick = () => { params = defaults(); walk = 0; syncControls(); rebuild(); };
$('#wire').onchange = updateWire;
$('#walkMode').onclick = () => setMode(mode === 'walk' ? 'view' : 'walk');
$('#fullscreen').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : canvas.requestFullscreen?.());
document.addEventListener('fullscreenchange', () => { $('#fullscreen').textContent = document.fullscreenElement ? 'Exit full screen' : 'Full screen'; });
$('#exportGlb').onclick = async () => {
  // PS2 shader materials don't survive glTF: bake them to plain unlit textured materials (fog/snap are the host engine's job)
  const out = world.group.clone(true), mats = new Map();
  out.traverse((m) => {
    if (!m.material) return;
    const src = m.material;
    if (!mats.has(src)) {
      if (src.isShaderMaterial) {
        const c = src.uniforms.color.value, k = Math.max(1, c.r, c.g, c.b); // glTF colour factors stop at 1
        const b = new THREE.MeshBasicMaterial({ map: src.uniforms.map.value, color: c.clone().multiplyScalar(1 / k), alphaTest: src.uniforms.alphaTest.value, side: src.side, vertexColors: src.vertexColors });
        b.name = src.name; mats.set(src, b);
      } else mats.set(src, src);
    }
    m.material = mats.get(src);
  });
  out.userData = { scenario: { generator: 'dreamare-dunes', version: 2, name: world.name, params: { ...params }, spawn: world.spawn.toArray(), fog: { color: PS2.fogColor.value.toArray(), near: PS2.fogNear.value, far: PS2.fogFar.value } } };
  const glb = await new GLTFExporter().parseAsync(out, { binary: true });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([glb], { type: 'model/gltf-binary' }));
  a.download = `${slug(world.name)}-${params.seed}.glb`; a.click();
  $('#status').textContent = `exported ${a.download} (${(glb.byteLength / 1024).toFixed(0)} KB)`;
};

window.__app = { me, phone, get mode() { return mode; }, get yaw() { return yaw; }, set yaw(v) { yaw = v; }, get params() { return params; }, set params(p) { params = p; syncControls(); rebuild(); }, randomize, defaults, rebuild };
buildControls(); syncControls(); rebuild();
requestAnimationFrame(frame);
