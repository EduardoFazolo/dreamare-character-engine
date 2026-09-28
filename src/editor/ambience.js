// Ambience beds for a scene: a few calm, ominous CC0 field recordings (public/ambience, see CREDITS.md), mixed
// under the voices (so recordings get them too). Each loops seamlessly: overlapping copies crossfade over 2 s
// at every turn, so no loop point is ever heard.
import { audioCtx, outputBus } from './voice.js';

export const AMBIENCES = [
  { id: 'night-field-dogs', name: 'Night field, dogs far off', file: '/ambience/night-field-dogs.mp3', volume: 0.7 },
  { id: 'tonal-wind', name: 'Soft tonal wind', file: '/ambience/tonal-wind.mp3', volume: 0.55 },
  { id: 'power-lines', name: 'Power lines humming', file: '/ambience/power-lines.mp3', volume: 0.35 },
  { id: 'foghorn-sea', name: 'Foghorn at sea', file: '/ambience/foghorn-sea.mp3', volume: 0.5 },
  { id: 'radio-static', name: 'Radio static, garbled', file: '/ambience/radio-static.mp3', volume: 0.25 },
];
const FADE = 2;
const buffers = new Map(), beds = new Map();
const load = (a) => { if (!buffers.has(a.id)) buffers.set(a.id, fetch(a.file).then((r) => r.arrayBuffer()).then((b) => audioCtx().decodeAudioData(b))); return buffers.get(a.id); };

export async function startBed(id, volume) {
  if (beds.has(id)) { setVolume(id, volume); return; }
  const a = AMBIENCES.find((x) => x.id === id); if (!a) return;
  const c = audioCtx(), gain = c.createGain(); gain.gain.value = 0; gain.connect(outputBus());
  const bed = { gain, sources: [], timer: 0, stopped: false };
  beds.set(id, bed);
  const buffer = await load(a);
  if (bed.stopped) return;
  gain.gain.setTargetAtTime(volume, c.currentTime, 0.6); // fade the whole bed in
  // one copy of the recording with its own fade-in / fade-out; the next starts FADE seconds before this ends
  const copy = (at) => {
    const src = c.createBufferSource(), g = c.createGain(), d = buffer.duration;
    src.buffer = buffer; src.connect(g).connect(gain);
    g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(1, at + FADE); g.gain.setValueAtTime(1, at + d - FADE); g.gain.linearRampToValueAtTime(0, at + d);
    src.start(at); src.stop(at + d + 0.05);
    bed.sources.push(src); src.onended = () => { bed.sources = bed.sources.filter((s) => s !== src); };
    return at + d - FADE;
  };
  let next = copy(c.currentTime + 0.05);
  const tick = () => { if (bed.stopped) return; while (next - c.currentTime < 3) next = copy(next); bed.timer = setTimeout(tick, 1000); };
  tick();
}
export function stopBed(id) {
  const bed = beds.get(id); if (!bed) return;
  bed.stopped = true; clearTimeout(bed.timer); beds.delete(id);
  const c = audioCtx(); bed.gain.gain.setTargetAtTime(0, c.currentTime, 0.4);
  setTimeout(() => { for (const s of bed.sources) { try { s.stop(); } catch { /* ended */ } } bed.gain.disconnect(); }, 2500);
}
export function setVolume(id, v) { const bed = beds.get(id); if (bed) bed.gain.gain.setTargetAtTime(v, audioCtx().currentTime, 0.1); }
export const playing = (id) => beds.has(id);
export function stopAll() { for (const id of [...beds.keys()]) stopBed(id); }
