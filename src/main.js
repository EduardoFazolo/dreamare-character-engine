import * as THREE from 'three';
import { initLandmarker, loadCanonical, makeFace, loadImage } from './face.js';
import { SCHEMA, CHOICES, defaults, deform, randomize } from './mutate.js';
import { AtlasBaker } from './atlas.js';
import { HeadRig, PS2, buildEnvironment } from './head.js';

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
const rig = new HeadRig(canon);

const scene = new THREE.Scene();
buildEnvironment(scene);
scene.add(rig.group);
const camera = new THREE.PerspectiveCamera(32, 4 / 3, 0.1, 60);
camera.position.set(0, -0.2, 4.1);
camera.lookAt(0, -0.25, 0);

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

function rebuild() {
  const face = faces[current];
  if (!face) return;
  const uvW = deform(canonUV, params, params.texWarp);
  texture = baker.bake(face, uvW, params, params.atlasRes);
  const base = params.geoSource === 'photo' ? face.geo : canon.pos;
  rig.update(deform(base, params, params.geoWarp), texture, params);
  baker.toCanvas($('#atlas'));
  if (lowRT?.height !== params.renderH) setRes(params.renderH);
  PS2.snapRes.value.set(lowRT.width / 2, lowRT.height / 2).multiplyScalar(1 - 0.8 * params.jitter);
  PS2.affine.value = params.affine;
  post.uniforms.vhs.value = params.vhs;
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

let paused = false;
function loop(ms) {
  requestAnimationFrame(loop);
  if (paused || !faces.length) return;
  const t = ms / 1000;
  idle += 1 / 60;
  const sway = idle > 2 ? Math.sin(t * 0.6) * 0.45 : 0;
  rig.group.rotation.y = yaw + sway;
  rig.group.position.y = Math.sin(t * 1.3) * 0.015;
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
      input.addEventListener('input', () => { params[k] = Number(input.value); out.textContent = (+input.value).toFixed(2); rebuild(); });
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

$('#randomize').onclick = () => { params = randomize(params); syncControls(); rebuild(); };
$('#reset').onclick = () => { params = defaults(); syncControls(); rebuild(); };
$('#export').onclick = () => {
  const a = document.createElement('a');
  a.download = `face_${faces[current].name.replace(/\.\w+$/, '')}_${params.atlasRes}.png`;
  a.href = $('#atlas').toDataURL('image/png');
  a.click();
};

$('#roll').onclick = () => roll(12);
function roll(n) {
  paused = true;
  const keep = { params, current, yaw: rig.group.rotation.y };
  const gal = $('#gallery');
  gal.innerHTML = '';
  for (let i = 0; i < n; i++) {
    current = Math.floor(Math.random() * faces.length);
    params = randomize(defaults());
    rebuild();
    rig.group.rotation.y = (Math.random() - 0.5) * 1.1;
    rig.group.position.y = 0;
    renderFrame(i);
    const img = document.createElement('img');
    img.src = canvas.toDataURL('image/jpeg', 0.85);
    const snap = { params, current };
    img.onclick = () => { ({ params, current } = snap); params = { ...params }; syncControls(); renderFaces(); rebuild(); window.scrollTo(0, 0); };
    gal.appendChild(img);
  }
  ({ params, current } = keep);
  rebuild();
  paused = false;
}

// ---------------- boot ----------------
buildControls();
syncControls();
setRes(params.renderH);
await initLandmarker();
status('detecting sample faces…');
for (const name of await (await fetch('/faces/index.json')).json()) await addFace(`/faces/${name}`, name).catch(() => {});
renderFaces();
status(`${faces.length} faces loaded. Drag the head to turn it. Drop your own photos anywhere.`);
params = randomize(params);
syncControls();
rebuild();
requestAnimationFrame(loop);
window.__app = { roll, get params() { return params; }, set params(p) { params = p; syncControls(); rebuild(); }, rebuild, faces };
