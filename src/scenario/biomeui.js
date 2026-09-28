// Biome controls (sliders, plant kind, switches), shared by the map (selected region) and the scene.
import { ARCHETYPES, ARCHETYPE_NAMES, VEG } from './biomes.js';

const SLIDERS = [['duneHeight', 'dunes', 0, 14], ['hills', 'hills', 0, 16], ['treeDensity', 'plant density', 0, 1], ['treeSize', 'plant size', 0.4, 2.5], ['rocks', 'rocks', 0, 1], ['tufts', 'grass tufts', 0, 2], ['houses', 'extra houses', 0, 6], ['fields', 'fields', 0, 1], ['booth', 'phone booth %', 0, 1]];
const SWITCHES = [['water', 'water'], ['house', 'house'], ['path', 'path'], ['busStop', 'bus stop'], ['lamps', 'lamps'], ['fence', 'fence'], ['poles', 'poles'], ['tower', 'radio tower'], ['pier', 'pier'], ['figure', 'figure']];

// root: container; get(): the biome object being edited; changed(kind): called after an edit ('value' | 'preset')
export function biomeControls(root, get, changed) {
  root.replaceChildren();
  const d = document.createElement('details'); d.open = true; d.innerHTML = '<summary>Biome</summary>';
  const inputs = {};
  const row = (html) => { const r = document.createElement('div'); r.className = 'row'; r.innerHTML = html; d.appendChild(r); return r; };

  const preset = row(`<span>preset</span><select>${ARCHETYPE_NAMES.map((n) => `<option>${n}</option>`).join('')}</select>`).querySelector('select');
  preset.onchange = () => { const b = get(); for (const k of Object.keys(b)) delete b[k]; Object.assign(b, structuredClone(ARCHETYPES[preset.value])); sync(); changed('preset'); };
  const kind = row(`<span>plants</span><select>${VEG.map((n) => `<option>${n}</option>`).join('')}</select>`).querySelector('select');
  kind.onchange = () => { get().trees = kind.value; if (kind.value !== 'none' && get().treeDensity < 0.05) get().treeDensity = 0.3; sync(); changed('value'); };
  for (const [k, label, mn, mx] of SLIDERS) {
    const r = row(`<span>${label}</span><input type="range" min="${mn}" max="${mx}" step="${k === 'houses' ? 1 : (mx - mn) / 200}"><output></output>`);
    const input = r.querySelector('input'), out = r.querySelector('output');
    input.oninput = () => { get()[k] = Number(input.value); out.textContent = (+input.value).toFixed(k === 'houses' ? 0 : 2); changed('value'); };
    inputs[k] = { input, out };
  }
  const sw = document.createElement('div'); sw.className = 'switches';
  for (const [k, label] of SWITCHES) {
    const l = document.createElement('label'); l.innerHTML = `<input type="checkbox"> ${label}`;
    const c = l.querySelector('input'); c.onchange = () => { get()[k] = c.checked ? 1 : 0; changed('value'); };
    inputs[k] = { check: c }; sw.appendChild(l);
  }
  d.appendChild(sw);
  root.appendChild(d);

  function sync() {
    const b = get(); if (!b) return;
    preset.value = b.archetype in ARCHETYPES ? b.archetype : 'village';
    kind.value = b.trees;
    for (const [k] of SLIDERS) { inputs[k].input.value = b[k]; inputs[k].out.textContent = (+b[k]).toFixed(k === 'houses' ? 0 : 2); }
    for (const [k] of SWITCHES) inputs[k].check.checked = !!b[k];
  }
  sync();
  return { sync };
}
