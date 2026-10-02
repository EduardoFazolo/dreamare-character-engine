// Slides tab: vertical slideshow decks for TikTok. Each slide is a 1080x1920 picture (an editor snapshot or an
// upload) with your own text on it, a look, a position and a duration. Decks live in this browser; export as a
// slideshow video (or as numbered PNGs).
// A slide can also be a live scene: a reference to a scene file and one of its shots ({ live: { scene, shot,
// frozen, poster } }), played by the editor in player mode (editor.html?player) so its breathing and atmosphere
// stay. Snap stops time: the frame on screen becomes the slide's picture and nothing renders any more.
// Optimisation: one player for the whole page, only for the selected slide; every other slide (and the strip)
// shows its poster, a still captured from the player; snapped slides are just their poster.
import { zipSync } from 'fflate';
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { get, put, del, all, uid } from '../store.js';
import { menubar } from '../menubar.js';
menubar();

const $ = (s) => document.querySelector(s);
const status = (t) => ($('#status').textContent = t);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const W = 1080, H = 1920;
const LOOKS = { tiktok: 'TikTok box', outline: 'outlined', serif: 'dreamy serif', caps: 'storybook caps' }; // (caps: white serif capitals laid on the picture, a dark edge and a soft shadow, like a children's storybook card)
const POS = { top: 0.2, middle: 0.44, low: 0.64 }; // centre of the text block; "low" still clears TikTok's bottom fifth
// time on screen: set by hand, or (null) from the text: ~2.4 s + 0.18 s a word, 3 s at least
export const autoSecs = (text) => { const w = text.trim().split(/\s+/).filter(Boolean).length; return Math.min(15, Math.max(4.5, Math.round((1.9 + 0.14 * w) * 1.875 * 2) / 2)); }; // (fitted to the deck's hand-set times the user liked, then x1.25, then x1.5)
const secsOf = (s) => s.secs ?? autoSecs(s.text || '');
const newSlide = (image = null, text = '') => ({ id: uid(), image, text, secs: null, style: { look: 'tiktok', pos: 'top', size: 1 } });
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
// background: the picture, a live scene's poster, or (frame) the player's canvas; transparent: text only (over the player)
export async function drawSlide(g, slide, { frame = null, transparent = false } = {}) {
  if (transparent) g.clearRect(0, 0, W, H);
  else {
    g.fillStyle = '#0d0b10'; g.fillRect(0, 0, W, H);
    const im = frame || (await imgOf(slide.live ? slide.live.poster : slide.image));
    if (im) { const iw = im.width, ih = im.height, k = Math.max(W / iw, H / ih), w = iw * k, h = ih * k; g.drawImage(im, (W - w) / 2, (H - h) / 2, w, h); } // cover
  }
  drawText(g, slide);
}
function drawText(g, slide) {
  const text = slide.text.trim(); if (!text) return;
  const { look, pos, size } = slide.style, px = Math.round((look === 'serif' ? 54 : look === 'caps' ? 58 : 48) * size);
  g.font = look === 'serif' ? `italic ${px}px Georgia, "Times New Roman", serif` : look === 'caps' ? `bold ${px}px Georgia, "Times New Roman", serif` : `bold ${px}px "Helvetica Neue", Arial, sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  const lines = wrap(g, look === 'caps' ? text.toUpperCase() : text, W * (look === 'caps' ? 0.76 : 0.8)), lh = px * (look === 'tiktok' ? 1.38 : 1.25), y0 = H * POS[pos] - ((lines.length - 1) * lh) / 2;
  lines.forEach((line, k) => {
    const y = y0 + k * lh;
    if (look === 'tiktok') { // white text on a rounded black box per line
      const w = g.measureText(line).width + px * 0.7, h = px * 1.3, r = px * 0.28, x = W / 2 - w / 2;
      g.fillStyle = 'rgba(0,0,0,.92)'; g.beginPath(); g.roundRect(x, y - h / 2, w, h, r); g.fill();
      g.fillStyle = '#fff'; g.fillText(line, W / 2, y + px * 0.04);
    } else if (look === 'caps') {
      g.shadowColor = 'rgba(0,0,0,.7)'; g.shadowBlur = px * 0.25; g.shadowOffsetY = px * 0.08;
      g.lineJoin = 'round'; g.lineWidth = px * 0.13; g.strokeStyle = '#1a1410'; g.strokeText(line, W / 2, y);
      g.shadowBlur = 0; g.shadowOffsetY = 0; g.fillStyle = '#fbf7ec'; g.fillText(line, W / 2, y);
    } else if (look === 'outline') {
      g.lineJoin = 'round'; g.lineWidth = px * 0.16; g.strokeStyle = '#000'; g.strokeText(line, W / 2, y); g.fillStyle = '#fff'; g.fillText(line, W / 2, y);
    } else {
      g.shadowColor = 'rgba(0,0,0,.95)'; g.shadowBlur = px * 0.35; g.shadowOffsetY = px * 0.06; g.fillStyle = '#ece6d6'; g.fillText(line, W / 2, y); g.shadowBlur = 0; g.shadowOffsetY = 0;
    }
  });
}
let drawing = 0;
async function redraw() { const n = ++drawing, c = $('#slideView'), g = c.getContext('2d'), s = deck.slides[sel]; await drawSlide(g, s, { transparent: plays(s) }); if (n !== drawing) return; renderStripThumb(sel); }
const isLive = (s) => !!(s?.live && s.live.frozen == null);
// live.lightsOut: the room's lights (props with setLight) fade out over a second, starting that many seconds
// before the slide ends (snapped slides too: time stays stopped, only the light goes)
const plays = (s) => isLive(s) || !!s?.live?.lightsOut;
const lightAt = (s, t) => { const L = s.live?.lightsOut; if (!L) return 1; const k = (t - (secsOf(s) - L)) / Math.min(1, L); return 1 - Math.min(1, Math.max(0, k)); };

// ---------------- the live player (one, lazily made, only while a live slide is selected) ----------------
let playerEl = null, playerP = null, liveGen = 0;
function player() {
  if (!playerP) {
    playerEl = document.createElement('iframe'); playerEl.className = 'slideplayer'; playerEl.title = 'live scene';
    playerP = new Promise((ok) => { const on = (e) => { if (e.source === playerEl.contentWindow && e.data?.type === 'player-ready') { removeEventListener('message', on); ok(playerEl.contentWindow.__player); } }; addEventListener('message', on); });
    playerEl.src = '/editor.html?player'; $('.slidemain').prepend(playerEl);
  }
  return playerP;
}
async function syncLive() {
  const s = deck.slides[sel], live = plays(s), my = ++liveGen;
  $('.slidemain').classList.toggle('live', live);
  if (!live) { if (playerP) (await playerP).pause(true); return; }
  status('loading the scene…');
  try {
    const P = await player(); if (my !== liveGen) return;
    await P.show(s.live.scene, s.live.shot, { outW: 540, frozen: s.live.frozen }); if (my !== liveGen) return;
    s.live.poster = P.capture(0.85); save(); renderStripThumb(sel); // (refreshed each time: the shot or the scene may have changed)
    if (s.live.lightsOut) { // the preview plays the slide's time over and over, so the fade can be seen
      const t0 = performance.now(), tick = () => {
        if (my !== liveGen) { P.light(1); return; }
        P.light(lightAt(s, ((performance.now() - t0) / 1000) % secsOf(s)));
        if (s.live.frozen != null) P.render(s.live.frozen); // (stopped time doesn't draw by itself)
        setTimeout(tick, 50);
      };
      tick();
    }
    status(`live: ${s.live.sceneName || s.live.scene} · ${s.live.shot || 'first shot'} · ❄ Snap stops time`);
  } catch (err) { status(`couldn't play the scene: ${err.message}`); }
}
async function snap() {
  const s = deck.slides[sel]; if (!s?.live) return;
  if (s.live.frozen == null) { // stop time: the frame on screen becomes the picture
    const P = await player(); s.live.frozen = P.freeze(); s.live.poster = P.capture(0.92);
    status('snapped: time stopped on this frame');
  } else { s.live.frozen = null; status('live again'); }
  imgCache.delete(s.live.poster); save(); await syncLive(); renderSlideBox(); redraw();
}

// ---------------- persistence ----------------
let saveT = 0;
const save = () => { clearTimeout(saveT); saveT = setTimeout(() => { deck.updated = Date.now(); put('decks', deck.id, deck); put('meta', 'deck', deck.id); renderDecks(); }, 250); };
async function openDeck(d) { deck = d; sel = 0; $('#deckName').value = deck.name; renderAll(); }

// ---------------- panels ----------------
function renderAll() { renderStrip(); renderSlideBox(); redraw(); renderMeta(); syncLive(); }
function renderMeta() { const t = deck.slides.reduce((a, s) => a + secsOf(s), 0); $('#deckMeta').textContent = `${deck.slides.length} slide${deck.slides.length === 1 ? '' : 's'} · ${t.toFixed(1)} s · 1080×1920`; }
async function thumb(slide) { const c = document.createElement('canvas'); c.width = W; c.height = H; await drawSlide(c.getContext('2d'), slide); const t = document.createElement('canvas'); t.width = 90; t.height = 160; t.getContext('2d').drawImage(c, 0, 0, 90, 160); return t.toDataURL('image/jpeg', 0.7); }
function renderStrip() {
  const strip = $('#strip');
  strip.replaceChildren(...deck.slides.map((s, k) => {
    const d = document.createElement('div'); d.className = 'thumb' + (k === sel ? ' on' : ''); d.dataset.k = k;
    d.innerHTML = `<img alt=""><span>${k + 1}</span><em class="secs">${secsOf(s).toFixed(1)}s</em>`;
    d.onclick = () => { sel = k; renderStrip(); renderSlideBox(); redraw(); syncLive(); };
    thumb(s).then((u) => { d.querySelector('img').src = u; });
    return d;
  }), Object.assign(document.createElement('button'), { className: 'thumb add', textContent: '+', title: 'new slide', onclick: () => { deck.slides.splice(sel + 1, 0, newSlide(null, '')); sel++; save(); renderAll(); } }));
}
function renderStripTime(k) { const el = $(`#strip .thumb[data-k="${k}"] .secs`); if (el) el.textContent = `${secsOf(deck.slides[k]).toFixed(1)}s`; }
async function renderStripThumb(k) { const el = $(`#strip .thumb[data-k="${k}"] img`); if (el) el.src = await thumb(deck.slides[k]); }
function renderSlideBox() {
  const s = deck.slides[sel], box = $('#slideBox');
  box.innerHTML = `
    <textarea id="slideText" class="script" rows="3" placeholder="the line on this slide">${esc(s.text)}</textarea>
    <div class="row"><span>look</span><select id="look">${Object.entries(LOOKS).map(([k, v]) => `<option value="${k}" ${k === s.style.look ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
    <div class="row"><span>position</span><select id="pos">${Object.keys(POS).map((k) => `<option ${k === s.style.pos ? 'selected' : ''}>${k}</option>`).join('')}</select></div>
    <div class="row"><span>text size</span><input id="size" type="range" min="0.6" max="1.6" step="0.01" value="${s.style.size}"><output>${s.style.size.toFixed(2)}</output></div>
    <div class="row"><span>on screen</span><input id="secs" type="range" min="0.5" max="15" step="0.1" value="${secsOf(s)}"><output>${secsOf(s).toFixed(1)} s${s.secs == null ? ' (auto)' : ''}</output></div>
    <div class="buttons"><button id="autoSecs" style="grid-column: span 2" ${s.secs == null ? 'disabled' : ''} title="time from the length of the text">Time from the text</button></div>
    <div class="buttons"><button id="moveL" ${sel ? '' : 'disabled'}>◀ Move</button><button id="moveR" ${sel < deck.slides.length - 1 ? '' : 'disabled'}>Move ▶</button><button id="dupSlide">Duplicate</button><button id="delSlide" ${deck.slides.length > 1 ? '' : 'disabled'}>Delete</button><button id="noPic" style="grid-column: span 2" ${s.image || s.live ? '' : 'disabled'}>Remove picture</button></div>
    ${s.live ? `<div class="row"><span>room lights</span><input id="lightsOut" type="range" min="0" max="4" step="0.5" value="${s.live.lightsOut || 0}"><output>${s.live.lightsOut ? `out from ${s.live.lightsOut.toFixed(1)} s before the end` : 'stay on'}</output></div>` : ''}
    ${s.live ? `<p class="meta">scene: <b>${esc(s.live.sceneName || s.live.scene)}</b> · ${esc(s.live.shot || 'first shot')}</p><div class="buttons"><button id="snap" class="primary" style="grid-column: span 2" title="${s.live.frozen == null ? 'stop time on the frame you see: it becomes this slide\'s picture' : 'let the scene breathe again'}">${s.live.frozen == null ? '❄ Snap (stop time)' : '▶ Unsnap (live)'}</button></div>` : ''}`;
  $('#slideText').oninput = (e) => { s.text = e.target.value; save(); redraw(); };
  $('#look').onchange = (e) => { s.style.look = e.target.value; save(); redraw(); };
  $('#pos').onchange = (e) => { s.style.pos = e.target.value; save(); redraw(); };
  $('#size').oninput = (e) => { s.style.size = +e.target.value; box.querySelectorAll('output')[0].textContent = s.style.size.toFixed(2); save(); redraw(); };
  $('#secs').oninput = (e) => { s.secs = +e.target.value; box.querySelectorAll('output')[1].textContent = `${s.secs.toFixed(1)} s`; $('#autoSecs').disabled = false; save(); renderMeta(); renderStripTime(sel); };
  $('#autoSecs').onclick = () => { s.secs = null; save(); renderMeta(); renderSlideBox(); renderStripTime(sel); };
  $('#slideText').addEventListener('input', () => { if (s.secs == null) { box.querySelectorAll('output')[1].textContent = `${secsOf(s).toFixed(1)} s (auto)`; renderMeta(); renderStripTime(sel); } });
  const move = (d) => { const [x] = deck.slides.splice(sel, 1); sel += d; deck.slides.splice(sel, 0, x); save(); renderAll(); };
  $('#moveL').onclick = () => move(-1); $('#moveR').onclick = () => move(1);
  $('#dupSlide').onclick = () => { deck.slides.splice(sel + 1, 0, { ...structuredClone(s), id: uid() }); sel++; save(); renderAll(); };
  $('#delSlide').onclick = () => { deck.slides.splice(sel, 1); sel = Math.max(0, sel - 1); save(); renderAll(); };
  $('#noPic').onclick = () => { s.image = null; s.live = null; save(); renderAll(); };
  if ($('#snap')) $('#snap').onclick = snap;
  if ($('#lightsOut')) {
    $('#lightsOut').oninput = (e) => { s.live.lightsOut = +e.target.value || null; e.target.nextElementSibling.textContent = s.live.lightsOut ? `out from ${s.live.lightsOut.toFixed(1)} s before the end` : 'stay on'; save(); };
    $('#lightsOut').onchange = () => { redraw(); syncLive(); };
  }
}
async function renderShots() {
  const shots = (await all('shots')).sort((a, b) => b.created - a.created), box = $('#shotList');
  if (!shots.length) { box.innerHTML = '<p class="hint">No pictures yet. In the Editor, frame a shot and press 📷 Snapshot (or K).</p>'; return; }
  box.replaceChildren(...shots.map((sh) => {
    const d = document.createElement('div'); d.className = 'shot'; d.title = `${sh.scene || ''} · click: put on the selected slide`;
    d.innerHTML = `<img src="${sh.image}" alt=""><button title="delete this picture">×</button>`;
    d.onclick = () => { deck.slides[sel].image = sh.image; deck.slides[sel].live = null; save(); renderSlideBox(); redraw(); syncLive(); status(`picture placed on slide ${sel + 1}`); };
    d.querySelector('button').onclick = async (e) => { e.stopPropagation(); await del('shots', sh.id); renderShots(); };
    return d;
  }));
}
// scene files and their shots: clicking a shot makes the selected slide a live view of it
async function renderScenesList() {
  const box = $('#sceneShots'); if (!box) return;
  let scenes = [];
  try { scenes = (await (await fetch('/__scenes')).json()).filter((x) => !x.error && x.shots?.length).sort((a, b) => (b.updated || 0) - (a.updated || 0)); } catch { box.innerHTML = '<p class="hint">scenes need the dev server</p>'; return; }
  if (!scenes.length) { box.innerHTML = '<p class="hint">No scene has shots yet. In the Editor, frame a view and add it under Shots.</p>'; return; }
  box.replaceChildren(...scenes.map((sc) => {
    const d = document.createElement('details'); d.innerHTML = `<summary>${esc(sc.name || sc.id)}</summary>`;
    for (const sh of sc.shots) {
      const b = document.createElement('button'); b.className = 'shotbtn'; b.textContent = sh.name || 'shot';
      b.onclick = () => { const s = deck.slides[sel]; s.live = { scene: sc.id, sceneName: sc.name, shot: sh.name, frozen: null, poster: null }; s.image = null; save(); renderAll(); };
      d.appendChild(b);
    }
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
// Export: rendered frame by frame (30 fps, not in real time) and encoded with WebCodecs into a plain MP4
// (mp4-muxer). The browser's live recorder wrote fragmented files whose header only knew the first fragment
// (players showed "3 s" and then kept playing); here the file's length is exact, and loading a scene or a slow
// frame can't show up in the video.
async function exportVideo() {
  if (!window.VideoEncoder) { status('video export needs a browser with WebCodecs (Chrome, Edge, Safari 16.4+)'); return; }
  const FPS = 30, fade = 0.4, c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
  const prev = document.createElement('canvas'); prev.width = W; prev.height = H; const pg = prev.getContext('2d');
  const stills = []; for (const s of deck.slides) { if (plays(s)) { stills.push(null); continue; } const f = document.createElement('canvas'); f.width = W; f.height = H; await drawSlide(f.getContext('2d'), s); stills.push(f); }
  const codec = (await Promise.all(['avc1.640033', 'avc1.4d0033', 'avc1.42E033'].map(async (c2) => ((await VideoEncoder.isConfigSupported({ codec: c2, width: W, height: H })).supported ? c2 : null)))).find(Boolean);
  if (!codec) { status('this browser cannot encode H.264 video at 1080×1920'); return; }
  // the deck's soundtrack (deck.soundtrack: a url), cut to the slides' total and encoded to AAC beside the video
  const total0 = deck.slides.reduce((a, s) => a + secsOf(s), 0);
  let audio = null;
  if (deck.soundtrack && window.AudioEncoder) {
    try {
      status('reading the soundtrack…');
      const ctx = new OfflineAudioContext(1, 1, 48000), buf = await ctx.decodeAudioData(await (await fetch(deck.soundtrack)).arrayBuffer());
      const sr = buf.sampleRate, ch = Math.min(2, buf.numberOfChannels), len = Math.round(total0 * sr);
      const cfg = { codec: 'mp4a.40.2', sampleRate: sr, numberOfChannels: ch, bitrate: 160000 };
      if ((await AudioEncoder.isConfigSupported(cfg)).supported) audio = { buf, sr, ch, len, cfg };
      else status('this browser cannot encode AAC: the video will be silent');
    } catch (e) { status(`couldn't read the soundtrack (${e.message}): the video will be silent`); }
  }
  const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: 'avc', width: W, height: H, frameRate: FPS }, ...(audio ? { audio: { codec: 'aac', sampleRate: audio.sr, numberOfChannels: audio.ch } } : {}), fastStart: 'in-memory' });
  let failed = null;
  if (audio) {
    const aenc = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: (e) => { failed = e; } });
    aenc.configure(audio.cfg);
    const { buf, sr, ch, len } = audio, B = 1024 * 8;
    for (let at = 0; at < len; at += B) {
      const n = Math.min(B, len - at), data = new Float32Array(n * ch);
      for (let c = 0; c < ch; c++) { const src = buf.getChannelData(c); for (let i = 0; i < n; i++) data[c * n + i] = at + i < src.length ? src[at + i] : 0; }
      const ad = new AudioData({ format: 'f32-planar', sampleRate: sr, numberOfFrames: n, numberOfChannels: ch, timestamp: Math.round((at / sr) * 1e6), data });
      aenc.encode(ad); ad.close();
    }
    await aenc.flush(); aenc.close();
  }
  const enc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { failed = e; } });
  enc.configure({ codec, width: W, height: H, bitrate: 8e6, framerate: FPS });
  const anyLive = deck.slides.some(plays), P = anyLive ? await player() : null;
  $('.slidemain').classList.remove('live'); liveGen++; // (the preview steps aside while the player renders)
  let frame = 0, total = 0; const base = performance.now() / 1000;
  for (let k = 0; k < deck.slides.length && !failed; k++) {
    const s = deck.slides[k], secs = secsOf(s), n = Math.round(secs * FPS);
    if (!stills[k]) { status(`loading ${s.live.sceneName || s.live.scene} for slide ${k + 1}…`); await P.show(s.live.scene, s.live.shot, { outW: 1080, frozen: s.live.frozen }); P.pause(true); }
    for (let i = 0; i < n && !failed; i++) {
      const t = i / FPS;
      g.globalAlpha = 1;
      if (stills[k]) g.drawImage(stills[k], 0, 0); else { P.light(lightAt(s, t)); P.render(s.live.frozen ?? base + total + t); await drawSlide(g, s, { frame: P.canvas }); }
      if (t < fade && k > 0) { g.globalAlpha = 1 - t / fade; g.drawImage(prev, 0, 0); g.globalAlpha = 1; } // soft cut
      const vf = new VideoFrame(c, { timestamp: Math.round((frame * 1e6) / FPS), duration: Math.round(1e6 / FPS) });
      enc.encode(vf, { keyFrame: frame % (FPS * 2) === 0 }); vf.close(); frame++;
      if (enc.encodeQueueSize > 8) await new Promise((ok) => enc.addEventListener('dequeue', ok, { once: true }));
      if (i % 15 === 0) { status(`rendering slide ${k + 1} of ${deck.slides.length}… ${Math.round((frame / FPS) * 10) / 10} s`); await new Promise((ok) => setTimeout(ok)); }
    }
    pg.drawImage(c, 0, 0); total += secs;
  }
  await enc.flush(); enc.close();
  if (P) P.setOutW(540);
  if (failed) { status(`video export failed: ${failed.message}`); syncLive(); return; }
  muxer.finalize();
  const blob = new Blob([muxer.target.buffer], { type: 'video/mp4' }), file = `${slug(deck.name)}-slides.mp4`;
  download(blob, file);
  status(`exported a ${(frame / FPS).toFixed(1)} s slideshow (1080×1920, ${(blob.size / 1e6).toFixed(1)} MB${audio ? ', with its soundtrack' : ''}) as ${file}`);
  syncLive();
}
$('#exportVideo').onclick = () => exportVideo();

// ---------------- the rest of the UI ----------------
$('#deckName').onchange = () => { deck.name = $('#deckName').value.trim() || 'Untitled deck'; save(); };
$('#allAuto').onclick = () => { deck.slides.forEach((sl) => { sl.secs = null; }); save(); renderAll(); status('every slide timed from its text'); };
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
// Deck files: public/decks/*.json (index.json lists them), decks made outside this browser (e.g. by Claude),
// copied into this browser's decks once per version; their live slides get posters made on the way in.
async function deckFiles() {
  let list = []; try { list = await (await fetch('/decks/index.json')).json(); } catch { return null; }
  let last = null;
  for (const e of list) {
    const d = await (await fetch(`/decks/${e.file}`)).json().catch(() => null); if (!d) continue;
    const have = await get('decks', d.id);
    if (have && have.fileVersion === e.version) continue;
    // a newer file brings the texts and the slide order; what was done here (snaps, pictures, looks) stays
    if (have) for (const s of d.slides) {
      const o = have.slides.find((h) => h.id === s.id) || have.slides.find((h) => h.live && s.live && h.live.scene === s.live.scene && h.live.shot === s.live.shot);
      if (!o) continue;
      s.style = o.style || s.style;
      if (o.live && s.live && o.live.scene === s.live.scene && o.live.shot === s.live.shot) { s.live.frozen = o.live.frozen; s.live.poster = o.live.poster; s.live.lightsOut ??= o.live.lightsOut; }
    }
    d.autoTimed = true; // (a file's slide times are what it says: the old one-time switch to text timing isn't for it)
    d.fileVersion = e.version; d.updated = Date.now();
    await put('decks', d.id, d); last = d;
  }
  return last;
}
async function makePosters(d) { // one pass through the player, then it stops
  const todo = d.slides.filter((s) => s.live && !s.live.poster); if (!todo.length) return;
  const P = await player();
  for (const [k, s] of todo.entries()) { status(`making pictures for the deck… ${k + 1}/${todo.length}`); await P.show(s.live.scene, s.live.shot, { outW: 540 }); s.live.poster = P.capture(0.85); }
  P.pause(true); await put('decks', d.id, d); renderStrip(); syncLive(); status(`“${d.name}” is ready: ${d.slides.length} live slides`);
}
const imported = await deckFiles();
if (imported) await put('meta', 'deck', imported.id);
// (once: decks that came from files switch to text-based timing; their texts and snaps are kept)
for (const d of await all('decks')) if (d.fileVersion && !d.autoTimed) { d.slides.forEach((sl) => { sl.secs = null; }); d.autoTimed = true; await put('decks', d.id, d); }
// (once: every hand-set time 50% longer, like the text-based ones; not decks from files: their times are what the file says)
if (!(await get('meta', 'secsX1.5'))) { for (const d of await all('decks')) if (!d.fileVersion && d.slides.some((sl) => sl.secs != null)) { d.slides.forEach((sl) => { if (sl.secs != null) sl.secs = Math.min(15, Math.round(sl.secs * 1.5 * 2) / 2); }); await put('decks', d.id, d); } await put('meta', 'secsX1.5', true); }
const lastId = await get('meta', 'deck');
await openDeck((lastId && (await get('decks', lastId))) || emptyDeck());
renderShots(); renderDecks(); renderScenesList();
if (imported) makePosters(deck);
