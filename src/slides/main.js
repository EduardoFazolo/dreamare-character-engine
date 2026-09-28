// Slides tab: vertical slideshow decks for TikTok. Each slide is a 1080x1920 picture (an editor snapshot or an
// upload) with your own text on it, a look, a position and a duration. Decks live in this browser; export as a
// slideshow video (or as numbered PNGs).
import { zipSync } from 'fflate';
import { get, put, del, all, uid } from '../store.js';
import { menubar } from '../menubar.js';
menubar();

const $ = (s) => document.querySelector(s);
const status = (t) => ($('#status').textContent = t);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const W = 1080, H = 1920;
const LOOKS = { tiktok: 'TikTok box', outline: 'outlined', serif: 'dreamy serif' };
const POS = { top: 0.2, middle: 0.44, low: 0.64 }; // centre of the text block; "low" still clears TikTok's bottom fifth
const newSlide = (image = null, text = '') => ({ id: uid(), image, text, secs: 3, style: { look: 'tiktok', pos: 'top', size: 1 } });
const emptyDeck = () => ({ id: uid(), name: 'Untitled deck', slides: [newSlide()], created: Date.now(), updated: Date.now() });

let deck = null, sel = 0;
const imgCache = new Map();
const imgOf = (src) => { if (!src) return null; if (!imgCache.has(src)) { const im = new Image(); im.src = src; imgCache.set(src, im.decode().then(() => im).catch(() => null)); } return imgCache.get(src); };

// ---------------- drawing ----------------
function wrap(g, text, max) {
  const out = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const w of para.split(/\s+/).filter(Boolean)) { const t = line ? `${line} ${w}` : w; if (g.measureText(t).width > max && line) { out.push(line); line = w; } else line = t; }
    out.push(line);
  }
  return out;
}
export async function drawSlide(g, slide) {
  g.fillStyle = '#0d0b10'; g.fillRect(0, 0, W, H);
  const im = await imgOf(slide.image);
  if (im) { const k = Math.max(W / im.width, H / im.height), w = im.width * k, h = im.height * k; g.drawImage(im, (W - w) / 2, (H - h) / 2, w, h); } // cover
  const text = slide.text.trim(); if (!text) return;
  const { look, pos, size } = slide.style, px = Math.round((look === 'serif' ? 64 : 58) * size);
  g.font = look === 'serif' ? `italic ${px}px Georgia, "Times New Roman", serif` : `bold ${px}px "Helvetica Neue", Arial, sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  const lines = wrap(g, text, W * 0.8), lh = px * (look === 'tiktok' ? 1.38 : 1.25), y0 = H * POS[pos] - ((lines.length - 1) * lh) / 2;
  lines.forEach((line, k) => {
    const y = y0 + k * lh;
    if (look === 'tiktok') { // white text on a rounded black box per line
      const w = g.measureText(line).width + px * 0.7, h = px * 1.3, r = px * 0.28, x = W / 2 - w / 2;
      g.fillStyle = 'rgba(0,0,0,.92)'; g.beginPath(); g.roundRect(x, y - h / 2, w, h, r); g.fill();
      g.fillStyle = '#fff'; g.fillText(line, W / 2, y + px * 0.04);
    } else if (look === 'outline') {
      g.lineJoin = 'round'; g.lineWidth = px * 0.16; g.strokeStyle = '#000'; g.strokeText(line, W / 2, y); g.fillStyle = '#fff'; g.fillText(line, W / 2, y);
    } else {
      g.shadowColor = 'rgba(0,0,0,.95)'; g.shadowBlur = px * 0.35; g.shadowOffsetY = px * 0.06; g.fillStyle = '#ece6d6'; g.fillText(line, W / 2, y); g.shadowBlur = 0; g.shadowOffsetY = 0;
    }
  });
}
let drawing = 0;
async function redraw() { const n = ++drawing, c = $('#slideView'), g = c.getContext('2d'); await drawSlide(g, deck.slides[sel]); if (n !== drawing) return; renderStripThumb(sel); }

// ---------------- persistence ----------------
let saveT = 0;
const save = () => { clearTimeout(saveT); saveT = setTimeout(() => { deck.updated = Date.now(); put('decks', deck.id, deck); put('meta', 'deck', deck.id); renderDecks(); }, 250); };
async function openDeck(d) { deck = d; sel = 0; $('#deckName').value = deck.name; renderAll(); }

// ---------------- panels ----------------
function renderAll() { renderStrip(); renderSlideBox(); redraw(); renderMeta(); }
function renderMeta() { const t = deck.slides.reduce((a, s) => a + (s.secs ?? 3), 0); $('#deckMeta').textContent = `${deck.slides.length} slide${deck.slides.length === 1 ? '' : 's'} · ${t.toFixed(1)} s · 1080×1920`; }
async function thumb(slide) { const c = document.createElement('canvas'); c.width = W; c.height = H; await drawSlide(c.getContext('2d'), slide); const t = document.createElement('canvas'); t.width = 90; t.height = 160; t.getContext('2d').drawImage(c, 0, 0, 90, 160); return t.toDataURL('image/jpeg', 0.7); }
function renderStrip() {
  const strip = $('#strip');
  strip.replaceChildren(...deck.slides.map((s, k) => {
    const d = document.createElement('div'); d.className = 'thumb' + (k === sel ? ' on' : ''); d.dataset.k = k;
    d.innerHTML = `<img alt=""><span>${k + 1}</span>`;
    d.onclick = () => { sel = k; renderStrip(); renderSlideBox(); redraw(); };
    thumb(s).then((u) => { d.querySelector('img').src = u; });
    return d;
  }), Object.assign(document.createElement('button'), { className: 'thumb add', textContent: '+', title: 'new slide', onclick: () => { deck.slides.splice(sel + 1, 0, newSlide(null, '')); sel++; save(); renderAll(); } }));
}
async function renderStripThumb(k) { const el = $(`#strip .thumb[data-k="${k}"] img`); if (el) el.src = await thumb(deck.slides[k]); }
function renderSlideBox() {
  const s = deck.slides[sel], box = $('#slideBox');
  box.innerHTML = `
    <textarea id="slideText" class="script" rows="3" placeholder="the line on this slide">${esc(s.text)}</textarea>
    <div class="row"><span>look</span><select id="look">${Object.entries(LOOKS).map(([k, v]) => `<option value="${k}" ${k === s.style.look ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
    <div class="row"><span>position</span><select id="pos">${Object.keys(POS).map((k) => `<option ${k === s.style.pos ? 'selected' : ''}>${k}</option>`).join('')}</select></div>
    <div class="row"><span>text size</span><input id="size" type="range" min="0.6" max="1.6" step="0.01" value="${s.style.size}"><output>${s.style.size.toFixed(2)}</output></div>
    <div class="row"><span>on screen</span><input id="secs" type="range" min="1" max="10" step="0.5" value="${s.secs ?? 3}"><output>${(s.secs ?? 3).toFixed(1)} s</output></div>
    <div class="buttons"><button id="moveL" ${sel ? '' : 'disabled'}>◀ Move</button><button id="moveR" ${sel < deck.slides.length - 1 ? '' : 'disabled'}>Move ▶</button><button id="dupSlide">Duplicate</button><button id="delSlide" ${deck.slides.length > 1 ? '' : 'disabled'}>Delete</button><button id="noPic" style="grid-column: span 2" ${s.image ? '' : 'disabled'}>Remove picture</button></div>`;
  $('#slideText').oninput = (e) => { s.text = e.target.value; save(); redraw(); };
  $('#look').onchange = (e) => { s.style.look = e.target.value; save(); redraw(); };
  $('#pos').onchange = (e) => { s.style.pos = e.target.value; save(); redraw(); };
  $('#size').oninput = (e) => { s.style.size = +e.target.value; box.querySelectorAll('output')[0].textContent = s.style.size.toFixed(2); save(); redraw(); };
  $('#secs').oninput = (e) => { s.secs = +e.target.value; box.querySelectorAll('output')[1].textContent = `${s.secs.toFixed(1)} s`; save(); renderMeta(); };
  const move = (d) => { const [x] = deck.slides.splice(sel, 1); sel += d; deck.slides.splice(sel, 0, x); save(); renderAll(); };
  $('#moveL').onclick = () => move(-1); $('#moveR').onclick = () => move(1);
  $('#dupSlide').onclick = () => { deck.slides.splice(sel + 1, 0, { ...structuredClone(s), id: uid() }); sel++; save(); renderAll(); };
  $('#delSlide').onclick = () => { deck.slides.splice(sel, 1); sel = Math.max(0, sel - 1); save(); renderAll(); };
  $('#noPic').onclick = () => { s.image = null; save(); renderAll(); };
}
async function renderShots() {
  const shots = (await all('shots')).sort((a, b) => b.created - a.created), box = $('#shotList');
  if (!shots.length) { box.innerHTML = '<p class="hint">No pictures yet. In the Editor, frame a shot and press 📷 Snapshot (or K).</p>'; return; }
  box.replaceChildren(...shots.map((sh) => {
    const d = document.createElement('div'); d.className = 'shot'; d.title = `${sh.scene || ''} · click: put on the selected slide`;
    d.innerHTML = `<img src="${sh.image}" alt=""><button title="delete this picture">×</button>`;
    d.onclick = () => { deck.slides[sel].image = sh.image; save(); renderSlideBox(); redraw(); status(`picture placed on slide ${sel + 1}`); };
    d.querySelector('button').onclick = async (e) => { e.stopPropagation(); await del('shots', sh.id); renderShots(); };
    return d;
  }));
}
async function renderDecks() {
  const decks = (await all('decks')).sort((a, b) => b.updated - a.updated), box = $('#deckList');
  box.replaceChildren(...decks.map((d) => {
    const row = document.createElement('div'); row.className = 'scenerow' + (d.id === deck?.id ? ' on' : '');
    row.innerHTML = `<div><b>${esc(d.name)}</b><br><span class="meta">${d.slides.length} slides · ${new Date(d.updated).toLocaleString()}</span></div><button data-a="load">Open</button><button data-a="del" title="delete this deck">×</button>`;
    row.querySelector('[data-a=load]').onclick = () => openDeck(d);
    row.querySelector('[data-a=del]').onclick = async () => { if (!confirm(`Delete the deck “${d.name}”?`)) return; await del('decks', d.id); if (d.id === deck.id) await openDeck(emptyDeck()); renderDecks(); };
    return row;
  }));
}

// ---------------- export ----------------
const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'deck';
function download(blob, file) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = file; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 10000); }
$('#exportPng').onclick = async () => {
  const files = {}, c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
  for (let k = 0; k < deck.slides.length; k++) {
    await drawSlide(g, deck.slides[k]);
    const b = await new Promise((ok) => c.toBlob(ok, 'image/png'));
    files[`${String(k + 1).padStart(2, '0')}.png`] = new Uint8Array(await b.arrayBuffer());
  }
  download(new Blob([zipSync(files, { level: 0 })], { type: 'application/zip' }), `${slug(deck.name)}-slides.zip`);
  status(`exported ${deck.slides.length} slides (1080×1920 PNG) as ${slug(deck.name)}-slides.zip`);
};
$('#exportVideo').onclick = async () => {
  if (!window.MediaRecorder) { status('video export is not supported in this browser'); return; }
  const fade = 0.4, c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
  const frames = []; for (const s of deck.slides) { const f = document.createElement('canvas'); f.width = W; f.height = H; await drawSlide(f.getContext('2d'), s); frames.push(f); }
  const type = ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
  const stream = c.captureStream(30), rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 8e6 }), chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise((ok) => { rec.onstop = ok; });
  rec.start(250); status('rendering the slideshow…');
  const starts = []; let acc = 0; for (const s of deck.slides) { starts.push(acc); acc += s.secs ?? 3; }
  const t0 = performance.now(), total = acc;
  await new Promise((ok) => {
    const step = () => {
      const t = (performance.now() - t0) / 1000; if (t >= total) { ok(); return; }
      let k = 0; while (k + 1 < starts.length && starts[k + 1] <= t) k++; const into = t - starts[k];
      g.globalAlpha = 1; g.drawImage(frames[k], 0, 0);
      if (into < fade && k > 0) { g.globalAlpha = 1 - into / fade; g.drawImage(frames[k - 1], 0, 0); g.globalAlpha = 1; } // soft cut
      requestAnimationFrame(step);
    };
    step();
  });
  rec.stop(); await done;
  const ext = type.includes('mp4') ? 'mp4' : 'webm';
  download(new Blob(chunks, { type: type.split(';')[0] || 'video/webm' }), `${slug(deck.name)}-slides.${ext}`);
  status(`exported a ${total.toFixed(1)} s slideshow (1080×1920) as ${slug(deck.name)}-slides.${ext}`);
};

// ---------------- the rest of the UI ----------------
$('#deckName').onchange = () => { deck.name = $('#deckName').value.trim() || 'Untitled deck'; save(); };
$('#newDeck').onclick = async () => { await openDeck(emptyDeck()); save(); };
$('#addBlank').onclick = () => { deck.slides.splice(sel + 1, 0, newSlide(null, '')); sel++; save(); renderAll(); };
$('#upload').onclick = () => $('#uploadInput').click();
$('#uploadInput').onchange = async (e) => {
  for (const f of e.target.files) {
    const url = await new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(f); });
    const id = uid(); await put('shots', id, { id, image: url, scene: f.name, created: Date.now() });
  }
  e.target.value = ''; renderShots();
};
addEventListener('focus', renderShots); // snapshots taken in the editor tab show up when you come back

window.__slides = { get deck() { return deck; }, drawSlide, renderShots, openDeck };
const lastId = await get('meta', 'deck');
await openDeck((lastId && (await get('decks', lastId))) || emptyDeck());
renderShots(); renderDecks();
