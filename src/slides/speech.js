// Spoken captions for slides: when each word of a slide's text is said in its voice line, from the audio and the
// known text (no speech recognition). The line's loudness finds where speech is and where the pauses are; the
// words are laid over the speech in order, each taking time in proportion to its syllables, and a sentence or
// clause break is moved onto the nearest real pause. Then chunks: what's on screen at a time (a short phrase,
// broken at punctuation, ~6 words at most).
import { segments, syllables } from '../editor/captions.js';

const cache = new Map(); // url -> Promise<{ buf, words, dur }>

// loudness envelope at 100 fps, normalised to the line's loud speech (the 95th percentile)
function envelope(buf) {
  const x = buf.getChannelData(0), sr = buf.sampleRate, hop = Math.round(sr / 100), n = Math.floor(x.length / hop), rms = new Float32Array(n);
  for (let f = 0; f < n; f++) { let s = 0; for (let i = f * hop; i < (f + 1) * hop; i++) s += x[i] * x[i]; rms[f] = Math.sqrt(s / hop); }
  const sorted = Array.from(rms).sort((a, b) => a - b), ref = sorted[Math.floor(n * 0.95)] || 1;
  for (let f = 0; f < n; f++) rms[f] = Math.min(1, rms[f] / ref);
  return { rms, fps: 100 };
}

export const tokens = (text) => text.replace(/\[[^\]]*\]/g, ' ').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));

// words: [{ w, t0, t1 }] in seconds from the start of the line
export function timeWords(text, buf) {
  const env = envelope(buf), segs = segments(env), words = tokens(text);
  if (!words.length) return [];
  if (!segs.length) segs.push({ start: 0, end: buf.duration });
  const speech = segs.reduce((a, s) => a + (s.end - s.start), 0), syl = words.map((w) => Math.max(1, syllables(w)) + (/[,.;:!?…]$/.test(w) ? 0.6 : 0));
  const total = syl.reduce((a, b) => a + b, 0);
  // speech time -> clock time, skipping the pauses between segments
  const clock = (st) => { for (const s of segs) { const d = s.end - s.start; if (st <= d) return s.start + st; st -= d; } return segs.at(-1).end; };
  let acc = 0; const out = words.map((w, i) => { const a = acc; acc += syl[i]; return { w, s0: (a / total) * speech, s1: (acc / total) * speech }; });
  // a word that ends a clause and lands near a pause ends at it; the next word starts after it
  const bounds = segs.slice(0, -1).map((s, k) => ({ end: s.end, next: segs[k + 1].start }));
  for (const o of out) { o.t0 = clock(o.s0); o.t1 = clock(o.s1); }
  for (const b of bounds) {
    let best = -1, bd = 0.6;
    out.forEach((o, i) => { if (i < out.length - 1 && /[,.;:!?…]$/.test(o.w) && Math.abs(o.t1 - b.end) < bd) { bd = Math.abs(o.t1 - b.end); best = i; } });
    if (best >= 0) { out[best].t1 = b.end; out[best + 1].t0 = Math.max(out[best + 1].t0, b.next); }
  }
  return out.map(({ w, t0, t1 }) => ({ w, t0: +t0.toFixed(3), t1: +t1.toFixed(3) }));
}

// what's on screen together: phrases broken after punctuation, at most `max` words
export function chunks(words, max = 6) {
  const out = []; let cur = [];
  words.forEach((w, i) => { cur.push(i); if (/[,.;:!?…]$/.test(w.w) || cur.length >= max) { out.push(cur); cur = []; } });
  if (cur.length) out.push(cur);
  return out;
}

export function loadVoice(url, text) {
  if (!cache.has(url + '|' + text)) cache.set(url + '|' + text, (async () => {
    const ctx = new OfflineAudioContext(1, 1, 48000), buf = await ctx.decodeAudioData(await (await fetch(url)).arrayBuffer());
    return { buf, words: timeWords(text, buf), dur: buf.duration };
  })());
  return cache.get(url + '|' + text);
}
