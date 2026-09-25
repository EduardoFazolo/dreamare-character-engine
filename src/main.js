import * as THREE from 'three';
import { initLandmarker, loadCanonical, makeFace, loadImage, analyzeHair } from './face.js';
import { SCHEMA, CHOICES, defaults, deform, randomize } from './mutate.js';
import { AtlasBaker } from './atlas.js';
import { HeadRig, PS2, buildEnvironment } from './head.js';
import { BodyRig } from './body.js';
import { SkinnedCharacter } from './rig.js';
import { simplifierReady } from './sdf.js';
import { exportGLB } from './export.js';
import { perf } from './perf.js';
import { zipSync, strToU8 } from 'fflate';

THREE.ColorManagement.enabled = false;

const $ = (s) => document.querySelector(s);
const status = (t) => ($('#status').textContent = t);

const canvas = $('#view');
const renderer = new THREE.WebGLRenderer({ canvas, preserveDrawingBuffer: true });
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
renderer.setPixelRatio(1);

const canon = await loadCanonical();
const canonUV = canon.uv.map((u) => [...u]);
const baker = new AtlasBaker(renderer, canon);
const rig = new HeadRig(canon, renderer);

const scene = new THREE.Scene();
buildEnvironment(scene);
const body = new BodyRig();
scene.add(body.root);
body.parts.visible = false; // the driver rig only poses; what you see is the baked skinned mesh
const sk = new SkinnedCharacter(renderer);
body.root.add(sk.group);
const camera = new THREE.PerspectiveCamera(32, 4 / 3, 0.1, 400);

let zoom = 1; // mouse wheel, kept across rebuilds; double-click resets

function frameCamera() {
  const yaw = body.root.rotation.y;
  body.root.rotation.y = 0;
  body.root.updateMatrixWorld(true);
  const half = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  let target, dist;
  if (params.view === 'portrait') {
    target = rig.group.localToWorld(new THREE.Vector3(0, -0.35, 0));
    dist = 1.25 / half * params.headScale;
  } else if (params.view === 'medium') {
    const box = new THREE.Box3().setFromObject(body.parts);
    const hipY = body.j.pelvis.getWorldPosition(new THREE.Vector3()).y;
    const top = box.max.y + 0.2, bottom = hipY - (hipY - box.min.y) * 0.2;
    target = new THREE.Vector3((box.min.x + box.max.x) / 2, (top + bottom) / 2, (box.min.z + box.max.z) / 2);
    dist = ((top - bottom) / 2) * 1.05 / half + (box.max.z - box.min.z) / 2;
  } else {
    const box = new THREE.Box3().setFromObject(body.parts);
    target = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    dist = Math.max(size.y / 2, size.x / 2 / camera.aspect) * 1.08 / half + size.z / 2;
  }
  dist *= zoom;
  // zooming in drifts the aim from the body toward the face
  if (zoom < 1 && params.view !== 'portrait') {
    const face = rig.group.localToWorld(new THREE.Vector3(0, -0.2, 0));
    target.lerp(face, Math.min(1, (1 - zoom) / 0.7));
  }
  camera.position.set(target.x, target.y + dist * 0.06, target.z + dist);
  camera.lookAt(target);
  PS2.fogNear.value = dist + 4;
  PS2.fogFar.value = dist + 60;
  body.root.rotation.y = yaw;
}

// low-res game frame -> VHS-ish upscale pass
let lowRT;
const post = new THREE.ShaderMaterial({
  uniforms: { tex: { value: null }, lowRes: { value: new THREE.Vector2() }, vhs: { value: 0.6 }, time: { value: 0 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tex; uniform vec2 lowRes; uniform float vhs, time; varying vec2 vUv;
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
      gl_FragColor = vec4(col, 1.);
    }`,
  depthTest: false,
});
const postScene = new THREE.Scene();
postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), post));
const postCam = new THREE.OrthographicCamera();

function setRes(h) {
  const w = Math.round((h * 4) / 3);
  lowRT?.dispose();
  lowRT = new THREE.WebGLRenderTarget(w, h, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
  post.uniforms.tex.value = lowRT.texture;
  post.uniforms.lowRes.value.set(w, h);
  renderer.setSize(w * 3, h * 3, false);
}

// ---------------- state ----------------
const faces = [];
let current = 0;
let params = defaults();
let texture = null;
let lastSkin = null;

// Two phases: everything cheap runs now; the character swap waits for its body sculpt, which
// runs in a worker (cached by geometry, so texture/face/render changes never re-sculpt).
// Until then the previous character stays on screen and the UI keeps running at full speed.
let gen = 0, lastRebuild = Promise.resolve();
function rebuild() {
  const face = faces[current];
  if (!face) return Promise.resolve();
  const my = ++gen;
  perf.reset();
  const t0 = performance.now();
  const uvW = perf.time('face.deform', () => deform(canonUV, params, params.texWarp, canon.index));
  texture = perf.time('face.bake', () => baker.bake(face, uvW, params, params.atlasRes));
  perf.time('face.readback', () => baker.toCanvas($('#atlas')));
  const skin = perf.time('face.skin', () => baker.skinTone(uvW));
  lastSkin = skin;
  const base = params.geoSource === 'photo' ? face.geo : canon.pos;
  const headPending = perf.time('head.update', () => rig.update(deform(base, params, params.geoWarp, canon.index), texture, params, { hair: analyzeHair(face), skin, atlas: $('#atlas') }));
  perf.time('driver.update', () => body.update(params, skin, rig.group));
  if (lowRT?.height !== params.renderH) setRes(params.renderH);
  PS2.snapRes.value.set(lowRT.width / 2, lowRT.height / 2).multiplyScalar(1 - 0.8 * params.jitter);
  PS2.affine.value = params.affine;
  post.uniforms.vhs.value = params.vhs;
  if (sk.hasSculpt(params) && !headPending) {
    finishRebuild(t0);
    return (lastRebuild = Promise.resolve());
  }
  $('#bodyInfo').textContent = 'sculpting…';
  return (lastRebuild = Promise.all([sk.ensureSculpt(body, params), headPending]).then(() => { if (my === gen) finishRebuild(t0); }));
}

function finishRebuild(t0) {
  perf.time('sk.bake', () => sk.bake(body, params));
  perf.time('ui.bodyAtlas', () => showBodyAtlas());
  sk.play(params.anim);
  sk.update(0);
  perf.time('camera', () => frameCamera());
  perf.log.total = performance.now() - t0;
}

function showBodyAtlas() {
  const c = $('#bodyAtlas');
  if (params.bodyStyle === 'segmented' || !sk.bodyCanvas) { c.style.display = 'none'; $('#bodyInfo').textContent = ''; return; }
  c.style.display = '';
  c.width = c.height = sk.bodyCanvas.width;
  c.getContext('2d').drawImage(sk.bodyCanvas, 0, 0);
  const s = sk.stats;
  $('#bodyInfo').textContent = `body texture (baked) · ${s.tris} tris · ${s.charts} charts · ${s.ms} ms`;
}

// sliders fire faster than a sculpt rebuild: coalesce to at most one rebuild per frame
let rebuildQueued = false;
function requestRebuild() {
  if (rebuildQueued) return;
  rebuildQueued = true;
  requestAnimationFrame(() => { rebuildQueued = false; rebuild(); });
}

function renderFrame(t) {
  post.uniforms.time.value = t;
  renderer.setRenderTarget(lowRT);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  renderer.render(postScene, postCam);
}

// drag to turn, otherwise sway
let yaw = 0, dragging = false, lastX = 0, idle = 0;
canvas.addEventListener('pointerdown', (e) => { dragging = true; lastX = e.clientX; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointermove', (e) => { if (dragging) { yaw += (e.clientX - lastX) * 0.01; lastX = e.clientX; idle = 0; } });
canvas.addEventListener('pointerup', () => (dragging = false));
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  zoom = Math.min(3, Math.max(0.25, zoom * Math.exp(e.deltaY * 0.0015)));
  frameCamera();
}, { passive: false });
canvas.addEventListener('dblclick', () => { zoom = 1; frameCamera(); });

let paused = false, lastT;
function loop(ms) {
  requestAnimationFrame(loop);
  if (paused || !faces.length) return;
  const t = ms / 1000;
  idle += 1 / 60;
  const sway = idle > 2 ? Math.sin(t * 0.6) * 0.45 : 0;
  body.root.rotation.y = yaw + sway;
  sk.update(Math.min(0.1, t - (lastT ?? t)));
  lastT = t;
  renderFrame(t);
}

// ---------------- UI ----------------
const inputs = {};
function buildControls() {
  const root = $('#controls');
  SCHEMA.forEach((g, gi) => {
    const d = document.createElement('details');
    d.open = gi < 2 || g.group === 'Grade';
    d.innerHTML = `<summary>${g.group}</summary>`;
    for (const [k, label, mn, mx] of g.items) {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `<span>${label}</span><input type="range" min="${mn}" max="${mx}" step="${(mx - mn) / 200}"><output></output>`;
      const input = row.querySelector('input'), out = row.querySelector('output');
      input.addEventListener('input', () => { params[k] = Number(input.value); out.textContent = (+input.value).toFixed(2); requestRebuild(); });
      inputs[k] = { input, out };
      d.appendChild(row);
    }
    root.appendChild(d);
  });
  const d = document.createElement('details');
  d.open = true;
  d.innerHTML = '<summary>Options</summary>';
  for (const [k, c] of Object.entries(CHOICES)) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<span>${c.label}</span><select>${c.options.map((o) => `<option>${o}</option>`).join('')}</select>`;
    const sel = row.querySelector('select');
    sel.addEventListener('change', () => { params[k] = typeof c.def === 'number' ? Number(sel.value) : sel.value; rebuild(); });
    inputs[k] = { input: sel };
    d.appendChild(row);
  }
  root.appendChild(d);
}

function syncControls() {
  for (const [k, { input, out }] of Object.entries(inputs)) {
    input.value = params[k];
    if (out) out.textContent = (+params[k]).toFixed(2);
  }
}

function renderFaces() {
  const box = $('#faces');
  box.innerHTML = '';
  faces.forEach((f, i) => {
    const img = document.createElement('img');
    img.src = f.img.src;
    img.title = f.name;
    img.className = i === current ? 'on' : '';
    img.onclick = () => { current = i; renderFaces(); rebuild(); };
    box.appendChild(img);
  });
}

async function addFace(src, name) {
  const img = await loadImage(src);
  const f = await makeFace(img, name);
  if (!f) { status(`no face found in ${name}`); return false; }
  faces.push(f);
  return true;
}

async function addFiles(files) {
  for (const file of files) {
    if (await addFace(URL.createObjectURL(file), file.name)) current = faces.length - 1;
  }
  renderFaces();
  rebuild();
}

$('#file').addEventListener('change', (e) => addFiles([...e.target.files]));
document.body.addEventListener('dragover', (e) => e.preventDefault());
document.body.addEventListener('drop', (e) => { e.preventDefault(); addFiles([...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'))); });

$('#randomize').onclick = () => {
  if ($('#randPhoto').checked && faces.length > 1) {
    let i;
    do i = Math.floor(Math.random() * faces.length); while (i === current);
    current = i;
    renderFaces();
  }
  params = randomize(params);
  syncControls();
  rebuild();
};
$('#reset').onclick = () => { params = defaults(); syncControls(); rebuild(); };
$('#export').onclick = () => {
  const a = document.createElement('a');
  a.download = `dreamare_face_${(params.seed >>> 0).toString(36)}_${params.atlasRes}.png`;
  a.href = $('#atlas').toDataURL('image/png');
  a.click();
};

$('#exportGlb').onclick = async () => {
  await lastRebuild; // never export while a sculpt is still on its way
  const name = `dreamare_${params.outfit}_${(params.seed >>> 0).toString(36)}`;
  const canvases = new Map([[texture, $('#atlas')], [sk.bodyTexture, sk.bodyCanvas], [rig.headTexture, rig.headCanvas]]);
  const { glb, report } = await exportGLB(sk, canvases, { name, materials: params.exportMat });
  const reportJson = JSON.stringify(report, null, 2);
  if (!report.ok) {
    // a character with errors is not exported: only the report explaining why
    download(new Blob([reportJson], { type: 'application/json' }), `${name}.report.json`);
    status(`export refused: ${report.errors.map((e) => e.code).join(', ')} (see ${name}.report.json)`);
    return;
  }
  // one zip instead of a burst of downloads; textures are already inside the GLB, the PNGs are extras
  const files = {
    [`${name}.glb`]: new Uint8Array(glb),
    [`${name}.report.json`]: strToU8(reportJson),
    'textures/face.png': await pngBytes($('#atlas')),
  };
  if (params.bodyStyle !== 'segmented' && sk.bodyCanvas) files['textures/body.png'] = await pngBytes(sk.bodyCanvas);
  if (rig.headCanvas) files['textures/head.png'] = await pngBytes(rig.headCanvas);
  download(new Blob([zipSync(files, { level: 6 })], { type: 'application/zip' }), `${name}.zip`);
  status(`exported ${name}.zip (${report.warnings.length} warnings)`);
};

function download(blob, file) {
  const a = document.createElement('a');
  a.download = file;
  a.href = URL.createObjectURL(blob);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function pngBytes(canvas) {
  const blob = await new Promise((ok) => canvas.toBlob(ok, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

$('#roll').onclick = () => roll(12);
async function roll(n) {
  paused = true;
  const keep = { params, current };
  const gal = $('#gallery');
  gal.innerHTML = '';
  for (let i = 0; i < n; i++) {
    current = Math.floor(Math.random() * faces.length);
    params = randomize(defaults());
    await rebuild();
    body.root.rotation.y = (Math.random() - 0.5) * 1.1;
    sk.update(Math.random() * 3);
    renderFrame(i);
    const img = document.createElement('img');
    img.src = canvas.toDataURL('image/jpeg', 0.85);
    const snap = { params, current };
    img.onclick = () => { ({ params, current } = snap); params = { ...params }; syncControls(); renderFaces(); rebuild(); window.scrollTo(0, 0); };
    gal.appendChild(img);
  }
  ({ params, current } = keep);
  await rebuild();
  paused = false;
}

// ---------------- boot ----------------
buildControls();
syncControls();
setRes(params.renderH);
await Promise.all([initLandmarker(), body.preload(), simplifierReady]);
status('detecting sample faces…');
for (const name of await (await fetch('/faces/index.json')).json()) await addFace(`/faces/${name}`, name).catch(() => {});
renderFaces();
status(`${faces.length} faces loaded. Drag to turn, scroll to zoom, double-click to reset. Drop your own photos anywhere.`);
params = randomize(params);
syncControls();
window.__app = { roll, randomize, defaults, get params() { return params; }, set params(p) { params = p; syncControls(); rebuild(); }, rebuild, idle: () => lastRebuild, faces, get skin() { return lastSkin; }, sk, setYaw(v) { yaw = v; idle = -1e9; }, camera, body, analyzeHair, deform, canon, canonUV, rig };
await rebuild();
requestAnimationFrame(loop);
