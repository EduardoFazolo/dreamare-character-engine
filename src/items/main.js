// Items tab: an inventory screen (slots, a turning model, name, description, lore, effects, counts) and an
// editor for all of it. Items are JSON files in ./items: edits here save to the file (dev server), and a file
// changed on disk (by hand, or by Claude from a prompt) shows up here live.
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { menubar } from '../menubar.js';
import { createStage, bakeForExport } from '../scenario/stage.js';
import { PS2 } from '../head.js';
import { SCENE } from '../scenario/material.js';
import { buildModel, SHAPES, MATERIALS } from './model.js';

const $ = (s) => document.querySelector(s);
const status = (t) => ($('#status').textContent = t);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'item';
const blank = (name = 'New item') => ({ id: '', name, category: 'Tools', held: 1, stored: 0, description: '', lore: '', effects: [], model: { parts: [{ name: 'body', shape: 'box', material: 'iron', color: '#b0a898', size: [0.12, 0.12, 0.12], pos: [0, 0.06, 0], rot: [0, 0, 0], scale: [1, 1, 1] }] } });

let items = [], cur = null, part = 0;
const saved = new Map(); // id -> the JSON last saved from here (so our own writes don't bounce back as "external" edits)

// ---------------- files ----------------
async function fetchItems() { const r = await fetch('/__items'); if (!r.ok) throw new Error('the items endpoint needs the dev server (npm run dev)'); return (await r.json()).sort((a, b) => (a.category || '').localeCompare(b.category || '') || (a.name || '').localeCompare(b.name || '')); }
let saveT = 0, pending = false;
function touch() { pending = true; clearTimeout(saveT); saveT = setTimeout(saveNow, 450); renderView(); }
async function saveNow() {
  clearTimeout(saveT); if (!cur) return;
  if (!cur.id) cur.id = uniqueId(slug(cur.name));
  const text = JSON.stringify(cur, null, 2) + '\n';
  saved.set(cur.id, text);
  const r = await fetch(`/__items/${cur.id}`, { method: 'PUT', body: text });
  pending = false;
  status(r.ok ? `saved items/${cur.id}.json` : `could not save: ${(await r.json()).error}`);
}
const uniqueId = (base) => { let id = base, n = 2; while (items.some((i) => i.id === id && i !== cur)) id = `${base}-${n++}`; return id; };
// a file changed on disk: refresh the list; take the new version of the open item unless we have unsaved edits
async function reload(changed) {
  const fresh = await fetchItems();
  const mine = cur && fresh.find((i) => i.id === cur.id);
  const external = mine && JSON.stringify(mine, null, 2) + '\n' !== saved.get(cur.id);
  items = fresh;
  if (cur && mine && external && !pending) { cur = mine; part = Math.min(part, (cur.model?.parts?.length || 1) - 1); renderAll(); status(`${changed || 'an item'} changed on disk: reloaded`); }
  else { if (cur && mine) items[items.indexOf(mine)] = cur; renderSlots(); renderCats(); }
}
import.meta.hot?.on('items:changed', (d) => reload(d?.file));

// ---------------- the 3D view ----------------
const canvas = $('#itemView'), stage = createStage(canvas), { scene, camera } = stage;
stage.setRes(240); stage.vhs = 0.35; stage.sat = 0.85;
PS2.fogNear.value = 40; PS2.fogFar.value = 80; PS2.fogColor.value.setRGB(0.07, 0.06, 0.08);
SCENE.lightDir.value.set(0.5, 0.8, 0.6).normalize(); SCENE.lightCol.value.setRGB(0.85, 0.8, 0.72); SCENE.ambient.value.setRGB(0.42, 0.4, 0.46);
// a softly lit backdrop, so dark items (iron, cloth, a black receiver) still read against it
{
  const c = document.createElement('canvas'); c.width = 256; c.height = 192; const g = c.getContext('2d');
  const gr = g.createRadialGradient(128, 90, 10, 128, 96, 170); gr.addColorStop(0, '#6e6676'); gr.addColorStop(0.55, '#34303b'); gr.addColorStop(1, '#141118');
  g.fillStyle = gr; g.fillRect(0, 0, 256, 192);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.NoColorSpace; scene.background = t;
}
let modelObj = null, fit = 1, yaw = 0.6, pitch = 0.18, drag = null, spin = true;
function rebuildModel() {
  if (modelObj) { scene.remove(modelObj.group); modelObj.group.traverse((m) => m.geometry?.dispose()); }
  modelObj = buildModel(cur?.model); scene.add(modelObj.group);
  const s = modelObj.size; fit = Math.max(s.x, s.y, s.z) || 0.2;
  modelObj.center = modelObj.box.isEmpty() ? new THREE.Vector3() : modelObj.box.getCenter(new THREE.Vector3());
}
canvas.addEventListener('pointerdown', (e) => { drag = [e.clientX, e.clientY]; spin = false; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointermove', (e) => { if (!drag) return; yaw -= (e.clientX - drag[0]) * 0.01; pitch = Math.max(-1.2, Math.min(1.2, pitch + (e.clientY - drag[1]) * 0.008)); drag = [e.clientX, e.clientY]; });
canvas.addEventListener('pointerup', () => { drag = null; });
canvas.addEventListener('dblclick', () => { spin = true; });
canvas.addEventListener('wheel', (e) => { e.preventDefault(); fitZoom = Math.max(0.5, Math.min(3, fitZoom * Math.exp(e.deltaY * 0.001))); }, { passive: false });
let fitZoom = 1, last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  if (spin) yaw += dt * 0.5;
  if (modelObj) {
    const c = modelObj.center, d = fit * 1.75 * fitZoom;
    camera.position.set(c.x + Math.sin(yaw) * Math.cos(pitch) * d, c.y + Math.sin(pitch) * d, c.z + Math.cos(yaw) * Math.cos(pitch) * d);
    camera.near = d / 50; camera.far = d * 20; camera.updateProjectionMatrix(); camera.lookAt(c);
  }
  stage.render(now / 1000, { card: false });
  requestAnimationFrame(frame);
}

// thumbnails: each model rendered once, small, on a separate little renderer
const thumbR = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true, alpha: true }); thumbR.setSize(96, 96, false); thumbR.outputColorSpace = THREE.LinearSRGBColorSpace;
const thumbCache = new Map();
function thumbOf(item) {
  const key = JSON.stringify(item.model); if (thumbCache.has(key)) return thumbCache.get(key);
  const sc = new THREE.Scene(), cam = new THREE.PerspectiveCamera(35, 1, 0.001, 100), m = buildModel(item.model); sc.add(m.group);
  const c = m.box.isEmpty() ? new THREE.Vector3() : m.box.getCenter(new THREE.Vector3()), d = (Math.max(m.size.x, m.size.y, m.size.z) || 0.2) * 2.4;
  cam.position.set(c.x + d * 0.55, c.y + d * 0.25, c.z + d * 0.8); cam.lookAt(c);
  thumbR.render(sc, cam); const url = thumbR.domElement.toDataURL('image/png');
  m.group.traverse((o) => o.geometry?.dispose());
  thumbCache.set(key, url); return url;
}

// ---------------- the inventory screen (read side) ----------------
let catSel = null;
function renderCats() {
  const cats = [...new Set(items.map((i) => i.category || 'Items'))];
  if (!cats.includes(catSel)) catSel = cur?.category || cats[0];
  $('#cats').replaceChildren(...cats.map((c) => { const b = document.createElement('button'); b.className = 'cat' + (c === catSel ? ' on' : ''); b.textContent = c; b.onclick = () => { catSel = c; renderCats(); renderSlots(); }; return b; }));
}
function renderSlots() {
  const list = items.filter((i) => (i.category || 'Items') === catSel);
  $('#slots').replaceChildren(...list.map((it) => {
    const d = document.createElement('div'); d.className = 'slot' + (it.id === cur?.id ? ' on' : ''); d.title = it.name;
    d.innerHTML = `<img src="${thumbOf(it)}" alt="">${it.held > 1 ? `<span>${it.held}</span>` : ''}`;
    d.onclick = () => select(it);
    return d;
  }), Object.assign(document.createElement('button'), { className: 'slot add', textContent: '+', title: 'new item', onclick: newItem }));
}
function renderView() {
  if (!cur) return;
  $('#nameOut').textContent = cur.name || '';
  const paras = (t) => (t || '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
  $('#descOut').innerHTML = paras(cur.description); $('#loreOut').innerHTML = paras(cur.lore);
  $('#heldOut').textContent = `${cur.held ?? 0}`; $('#storedOut').textContent = `${cur.stored ?? 0}`;
  $('#effectsOut').innerHTML = (cur.effects || []).filter((e) => e.name || e.value).map((e) => `<div class="eff"><span>${esc(e.name)}</span><b>${esc(e.value)}</b></div>`).join('') || '<p class="hint">none</p>';
  $('#itemMeta').textContent = cur.id ? `items/${cur.id}.json` : 'not saved yet';
}

// ---------------- the editor (left panel) ----------------
function field(label, html) { return `<div class="row"><span>${label}</span>${html}</div>`; }
function renderItemBox() {
  $('#itemName').value = cur.name || '';
  $('#itemBox').innerHTML = `
    ${field('category', `<input class="text" data-k="category" value="${esc(cur.category)}">`)}
    ${field('held', `<input class="text" type="number" min="0" data-k="held" value="${cur.held ?? 0}">`)}
    ${field('stored', `<input class="text" type="number" min="0" data-k="stored" value="${cur.stored ?? 0}">`)}
    <p class="meta">description</p><textarea class="script" rows="4" data-k="description" placeholder="(blank line = new paragraph)">${esc(cur.description)}</textarea>
    <p class="meta">lore</p><textarea class="script" rows="4" data-k="lore">${esc(cur.lore)}</textarea>`;
  $('#itemBox').querySelectorAll('[data-k]').forEach((el) => { el.oninput = () => { const k = el.dataset.k; cur[k] = el.type === 'number' ? +el.value : el.value; if (k === 'category') { renderCats(); } touch(); }; });
}
function renderEffects() {
  const box = $('#effectsBox'); cur.effects ||= [];
  box.innerHTML = cur.effects.map((e, k) => `<div class="effrow"><input class="text" data-i="${k}" data-f="name" value="${esc(e.name)}" placeholder="effect"><input class="text" data-i="${k}" data-f="value" value="${esc(e.value)}" placeholder="value"><button data-rm="${k}" title="remove">×</button></div>`).join('') + '<div class="buttons"><button id="addEff" style="grid-column: span 2">+ Effect</button></div>';
  box.querySelectorAll('input').forEach((el) => { el.oninput = () => { cur.effects[+el.dataset.i][el.dataset.f] = el.value; touch(); }; });
  box.querySelectorAll('[data-rm]').forEach((b) => { b.onclick = () => { cur.effects.splice(+b.dataset.rm, 1); renderEffects(); touch(); }; });
  $('#addEff').onclick = () => { cur.effects.push({ name: '', value: '' }); renderEffects(); touch(); };
}
const SHAPE_FIELDS = { box: [['size', 3]], cylinder: [['radiusTop', 1], ['radiusBottom', 1], ['height', 1], ['segments', 1]], cone: [['radius', 1], ['height', 1], ['segments', 1]], sphere: [['radius', 1], ['segments', 1], ['thetaLength', 1]], torus: [['radius', 1], ['tube', 1], ['segments', 1], ['arc', 1]], lathe: [['segments', 1]] };
function renderModelBox() {
  const box = $('#modelBox'), parts = (cur.model ||= { parts: [] }).parts;
  part = Math.max(0, Math.min(part, parts.length - 1));
  const p = parts[part];
  const vec = (k, n, step) => `<div class="vec">${[...Array(n)].map((_, i) => `<input type="number" step="${step}" data-v="${k}" data-j="${i}" value="${+((p[k] || [])[i] ?? (k === 'scale' ? 1 : 0)).toFixed(4)}">`).join('')}</div>`;
  box.innerHTML = `
    <div class="partlist">${parts.map((q, k) => `<div class="partrow${k === part ? ' on' : ''}" data-p="${k}">${esc(q.name || q.shape)} <span class="meta">${q.shape} · ${q.material}</span></div>`).join('')}</div>
    <div class="buttons"><button id="addPart">+ Part</button><button id="dupPart" ${p ? '' : 'disabled'}>Duplicate</button><button id="rmPart" ${p ? '' : 'disabled'} style="grid-column: span 2">Delete part</button></div>
    ${p ? `
    ${field('name', `<input class="text" data-s="name" value="${esc(p.name)}">`)}
    ${field('shape', `<select data-s="shape">${SHAPES.map((s) => `<option ${s === p.shape ? 'selected' : ''}>${s}</option>`).join('')}</select>`)}
    ${field('material', `<select data-s="material">${MATERIALS.map((s) => `<option ${s === p.material ? 'selected' : ''}>${s}</option>`).join('')}</select>`)}
    ${field('colour', `<input type="color" data-s="color" value="${esc(p.color || '#ffffff')}">`)}
    <p class="meta">position (m) · rotation (°) · scale</p>${vec('pos', 3, 0.005)}${vec('rot', 3, 5)}${vec('scale', 3, 0.05)}
    ${(SHAPE_FIELDS[p.shape] || []).map(([k, n]) => (n === 3 ? `<p class="meta">${k}</p>${vec(k, 3, 0.005)}` : field(k, `<input class="text" type="number" step="${k === 'segments' ? 1 : k.endsWith('Length') || k === 'arc' ? 5 : 0.005}" data-n="${k}" value="${p[k] ?? ''}">`))).join('')}
    ${p.shape === 'lathe' ? `<p class="meta">profile points: radius, height per line (bottom to top)</p><textarea class="script" rows="6" data-pts>${esc((p.points || []).map((q) => q.join(', ')).join('\n'))}</textarea>` : ''}` : ''}`;
  box.querySelectorAll('.partrow').forEach((r) => { r.onclick = () => { part = +r.dataset.p; renderModelBox(); }; });
  $('#addPart').onclick = () => { parts.push({ name: `part ${parts.length + 1}`, shape: 'box', material: 'iron', color: '#a8a098', size: [0.05, 0.05, 0.05], pos: [0, 0.1, 0], rot: [0, 0, 0], scale: [1, 1, 1] }); part = parts.length - 1; modelChanged(); };
  $('#dupPart').onclick = () => { parts.splice(part + 1, 0, { ...structuredClone(p), name: `${p.name || p.shape} copy` }); part++; modelChanged(); };
  $('#rmPart').onclick = () => { parts.splice(part, 1); modelChanged(); };
  if (!p) return;
  box.querySelectorAll('[data-s]').forEach((el) => { el.oninput = () => { p[el.dataset.s] = el.value; modelChanged(el.dataset.s !== 'shape'); }; });
  box.querySelectorAll('[data-v]').forEach((el) => { el.oninput = () => { const k = el.dataset.v; p[k] ||= k === 'scale' ? [1, 1, 1] : [0, 0, 0]; p[k][+el.dataset.j] = +el.value; modelChanged(true); }; });
  box.querySelectorAll('[data-n]').forEach((el) => { el.oninput = () => { p[el.dataset.n] = +el.value; modelChanged(true); }; });
  box.querySelector('[data-pts]')?.addEventListener('input', (e) => { const pts = e.target.value.split('\n').map((l) => l.split(/[,\s]+/).filter(Boolean).map(Number)).filter((q) => q.length === 2 && q.every(Number.isFinite)); if (pts.length >= 2) { p.points = pts; modelChanged(true); } });
}
function modelChanged(keepPanel = false) { rebuildModel(); if (!keepPanel) renderModelBox(); else box3(); touch(); renderSlots(); }
function box3() { document.querySelectorAll('.partrow').forEach((r, k) => { const q = cur.model.parts[k]; r.innerHTML = `${esc(q.name || q.shape)} <span class="meta">${q.shape} · ${q.material}</span>`; }); }

function renderAll() { renderCats(); renderSlots(); renderView(); renderItemBox(); renderEffects(); renderModelBox(); rebuildModel(); }
async function select(it) { if (pending) await saveNow(); cur = it; part = 0; catSel = it.category || catSel; renderAll(); }
async function newItem() { if (pending) await saveNow(); cur = blank(); cur.category = catSel || 'Tools'; items.push(cur); await saveNow(); renderAll(); $('#itemName').select(); }

$('#itemName').oninput = () => { cur.name = $('#itemName').value; renderSlots(); touch(); };
async function deleteItem() { if (!cur?.id || !confirm(`Delete “${cur.name}” (items/${cur.id}.json)?`)) return; await fetch(`/__items/${cur.id}`, { method: 'DELETE' }); items = items.filter((i) => i !== cur); cur = items[0] || null; if (!cur) await newItem(); else renderAll(); }
async function duplicateItem() { await saveNow(); const c = { ...structuredClone(cur), id: '', name: `${cur.name} (copy)` }; items.push(c); cur = c; await saveNow(); renderAll(); }
async function exportGlb() {
  const g = bakeForExport(modelObj.group); g.name = cur.name;
  g.userData = { item: { id: cur.id, name: cur.name, category: cur.category, description: cur.description, lore: cur.lore, effects: cur.effects, held: cur.held, stored: cur.stored } };
  const glb = await new GLTFExporter().parseAsync(g, { binary: true });
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([glb], { type: 'model/gltf-binary' })); a.download = `${cur.id || slug(cur.name)}.glb`; a.click();
  status(`exported ${a.download}`);
}
menubar([
  { label: 'Item', items: [
    { label: 'New item', action: newItem },
    { label: 'Save', key: '⌘S', action: saveNow },
    { label: 'Duplicate', action: duplicateItem },
    '-',
    { label: 'Export model (GLB)', action: exportGlb },
    '-',
    { label: 'Delete item…', action: deleteItem },
  ] },
  { label: 'View', items: [{ label: 'Turntable', checked: () => spin, action: () => { spin = !spin; } }] },
]);
addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.code === 'KeyS') { e.preventDefault(); saveNow(); } });

window.__items = { get items() { return items; }, get cur() { return cur; }, select, reload };
try {
  items = await fetchItems();
  if (!items.length) await newItem(); else await select(items[0]);
} catch (err) { status(err.message); }
requestAnimationFrame(frame);
