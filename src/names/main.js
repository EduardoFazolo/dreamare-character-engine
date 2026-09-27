// Names tab: browse seeded people / place names, copy them, keep the good ones.
import { personName, placeName } from './gen.js';

const $ = (s) => document.querySelector(s);
// [key, label, min, max, step]
const SLIDERS = [['whimsy', 'whimsy', 0, 1, 0.01], ['french', 'French', 0, 0.5, 0.01], ['titles', 'titles', 0, 1, 0.01], ['count', 'how many', 6, 60, 1], ['seed', 'seed', 1, 99999, 1]];
let params = { kind: 'people', whimsy: 0.55, french: 0.12, titles: 0.35, count: 30, seed: 1 };

// kept names are a per-browser convenience (localStorage may be unavailable: then they last for the visit)
const KEY = 'dreamare.names.kept';
let kept = [];
try { kept = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { kept = []; }
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(kept)); } catch { /* private mode */ } };

function names() {
  const f = params.kind === 'people' ? personName : placeName, opts = { whimsy: params.whimsy, french: params.french, titles: params.titles, kind: params.kind === 'coast' ? 'coast' : 'any' };
  return Array.from({ length: params.count }, (_, i) => f(params.seed * 1000 + i, opts));
}

async function copy(text, what) {
  try { await navigator.clipboard.writeText(text); $('#status').textContent = `copied ${what}`; }
  catch { $('#status').textContent = 'the browser blocked the clipboard; select the text instead'; }
}

function card(name, isKept) {
  const d = document.createElement('div');
  d.className = 'name';
  const star = document.createElement('button');
  star.className = 'star'; star.textContent = kept.includes(name) ? '★' : '☆'; star.title = isKept ? 'forget' : 'keep';
  star.onclick = (e) => {
    e.stopPropagation();
    kept = kept.includes(name) ? kept.filter((k) => k !== name) : [...kept, name];
    save(); render();
  };
  const t = document.createElement('span'); t.textContent = name;
  d.append(t, star);
  d.onclick = () => copy(name, `“${name}”`);
  return d;
}

function render() {
  const list = names();
  $('#names').replaceChildren(...list.map((n) => card(n, false)));
  $('#kept').replaceChildren(...kept.map((n) => card(n, true)));
  $('.kepthead').textContent = kept.length ? `Kept (${kept.length})` : 'Kept: nothing yet';
}

function buildControls() {
  const root = $('#controls'), d = document.createElement('details');
  d.open = true; d.innerHTML = '<summary>Names</summary>';
  const kind = document.createElement('div'); kind.className = 'row';
  kind.innerHTML = '<span>kind</span><select><option value="people">people</option><option value="places">places</option><option value="coast">places (coast)</option></select>';
  kind.querySelector('select').onchange = (e) => { params.kind = e.target.value; render(); };
  d.appendChild(kind);
  for (const [k, label, mn, mx, st] of SLIDERS) {
    const row = document.createElement('div'); row.className = 'row';
    row.innerHTML = `<span>${label}</span><input type="range" min="${mn}" max="${mx}" step="${st}" value="${params[k]}"><output>${params[k]}</output>`;
    const input = row.querySelector('input'), out = row.querySelector('output');
    input.oninput = () => { params[k] = Number(input.value); out.textContent = st < 1 ? (+input.value).toFixed(2) : input.value; render(); };
    params[`_${k}`] = { input, out };
    d.appendChild(row);
  }
  root.appendChild(d);
}

$('#generate').onclick = () => {
  params.seed = 1 + Math.floor(Math.random() * 99998);
  const s = params._seed; s.input.value = params.seed; s.out.textContent = params.seed;
  render();
};
$('#copyAll').onclick = () => copy(names().join('\n'), `${params.count} names`);
$('#copyKept').onclick = () => (kept.length ? copy(kept.join('\n'), `${kept.length} kept names`) : ($('#status').textContent = 'nothing kept yet'));

window.__names = { get params() { return params; }, names, personName, placeName };
buildControls(); render();
