// Captions for voice lines, from a pasted script (no speech recognition).
//  - segments(env): where speech is: the line split at its pauses (>= 0.35 s below 8% of the file's speech
//    loudness); a stretch longer than 8 s is cut again at its quietest moment
//  - phrases(script): the script's lines, then its sentences within each line
//  - align(script, env): matches phrases to segments in order. Each phrase is expected to last its syllable
//    count x this file's own speaking rate; dynamic programming picks the grouping whose durations fit best:
//    one phrase over several segments, several short phrases sharing one segment (split by syllables), or a
//    segment with no script at all (a laugh, a breath) left uncaptioned.
import { get, put } from '../store.js';

export function segments(env) {
  const { rms, fps } = env, thr = 0.08, minPause = Math.round(0.35 * fps), out = [];
  let start = -1, quiet = 0;
  for (let f = 0; f < rms.length; f++) {
    if (rms[f] > thr) { if (start < 0) start = f; quiet = 0; }
    else if (start >= 0 && ++quiet >= minPause) { out.push([start, f - quiet + 1]); start = -1; quiet = 0; }
  }
  if (start >= 0) out.push([start, rms.length]);
  const split = ([a, b]) => {
    if ((b - a) / fps <= 8) return [[a, b]];
    let best = a + ((b - a) >> 1), low = Infinity;
    for (let f = a + ((b - a) >> 2); f < b - ((b - a) >> 2); f++) { const v = rms[f] + (rms[f - 1] || 0) + (rms[f + 1] || 0); if (v < low) { low = v; best = f; } }
    return [...split([a, best]), ...split([best, b])];
  };
  return out.flatMap(split).filter(([a, b]) => b - a >= 0.15 * fps).map(([a, b]) => ({ start: a / fps, end: b / fps }));
}

// the script's lines are the units (one caption each); only a script pasted as a single paragraph is split into
// sentences. Splitting inside a line would invent boundaries that aren't pauses.
export function phrases(script) {
  const lines = script.split(/\r?\n/).map((l) => l.trim()).filter((l) => /[\p{L}\p{N}]/u.test(l));
  if (lines.length !== 1) return lines;
  return (lines[0].match(/[^.!?…]+(?:[.!?…]+["')\]]*|$)/g) || lines).map((p) => p.trim()).filter((p) => /[\p{L}\p{N}]/u.test(p));
}
// rough syllables: vowel groups per word (a silent final e dropped), numbers by digits; at least 1 per word
export function syllables(text) {
  return text.toLowerCase().split(/[^\p{L}\p{N}']+/u).filter(Boolean).reduce((n, w) => {
    if (/^\d+$/.test(w)) return n + w.length * 1.5;
    const g = w.replace(/e$/, '').match(/[aeiouyàâäéèêëîïôöùûüœ]+/g);
    return n + Math.max(1, g ? g.length : 1);
  }, 0);
}

// syllable nuclei in a stretch: peaks of the (lightly smoothed) loudness, at least 110 ms apart and standing
// clearly above the dips around them. Speech gives ~4-6 a second; a laugh or a held vowel doesn't match the script.
export function nuclei(env, start, end) {
  const { rms, fps } = env, a = Math.max(1, Math.floor(start * fps)), b = Math.min(rms.length - 1, Math.ceil(end * fps));
  const sm = (f) => (rms[f - 1] + 2 * rms[f] + rms[f + 1]) / 4;
  let n = 0, last = -1e9, valley = Infinity;
  for (let f = a; f < b; f++) {
    const v = sm(f); valley = Math.min(valley, v);
    if (v > 0.2 && v >= sm(f - 1) && v > sm(f + 1) && v - valley > 0.12 && f - last >= 0.11 * fps) { n++; last = f; valley = v; }
  }
  return n;
}
export const TUNING = { skip: 0.5, gap: 0.8, merge: 0.12, wPeaks: 0.8, wDur: 0.2, pause: 0.4 }; // grid-searched against hand-checked timings (28 of 31 phrase starts, 5 cases)
export function align(script, env, T = TUNING) {
  const segs = segments(env), ph = phrases(script);
  if (!ph.length || !segs.length) return { cues: [], segments: segs.length, phrases: ph.length };
  // as many lines as pauses found: line k is stretch k, exactly (the pauses are the ground truth)
  if (ph.length === segs.length) return { cues: segs.map((sg, k) => ({ start: sg.start, end: sg.end, text: ph[k] })), segments: segs.length, phrases: ph.length, cost: 0, exact: true };
  // stage directions — "(laughs)", "[static]" — aren't syllables: they take one whole stretch of audio, any length
  const isDir = ph.map((p) => /^[([].*[)\]]$/.test(p));
  const syl = ph.map((p, k) => (isDir[k] ? 1 : syllables(p))), dur = segs.map((s) => s.end - s.start), peaks = segs.map((s) => nuclei(env, s.start, s.end));
  const rate = dur.reduce((a, b) => a + b, 0) / Math.max(1, syl.reduce((a, b, k) => a + (isDir[k] ? 0 : b), 0)); // seconds per syllable, this speaker
  // how well a stretch of audio fits a piece of script: mostly its syllable peaks vs the script's syllables
  // (a laugh or a held vowel fails this), a little its length at this speaker's rate
  const fit = (seconds, nPeaks, syllableCount) => T.wPeaks * Math.abs(Math.log((nPeaks + 1) / (syllableCount + 1))) + T.wDur * Math.abs(Math.log(Math.max(0.05, seconds) / Math.max(0.05, syllableCount * rate)));
  const P = ph.length, S = segs.length, K = 4, SKIP_SEG = T.skip, SKIP_PH = 4, MERGE = T.merge, GAP = T.gap;
  const cost = Array.from({ length: P + 1 }, () => new Float64Array(S + 1).fill(Infinity)), from = Array.from({ length: P + 1 }, () => Array(S + 1).fill(null));
  cost[0][0] = 0;
  for (let i = 0; i <= P; i++) for (let j = 0; j <= S; j++) {
    const c = cost[i][j]; if (!isFinite(c)) continue;
    const relax = (ni, nj, add, move) => { if (ni <= P && nj <= S && c + add < cost[ni][nj]) { cost[ni][nj] = c + add; from[ni][nj] = { i, j, move }; } };
    // only the moves the counts call for: more stretches than lines -> a stretch can be left out or a line can
    // run over several; more lines than stretches -> lines can share a stretch. Never both.
    if (S > P) relax(i, j + 1, SKIP_SEG, 'skipSeg'); // audio with no script: a laugh, a breath, a noise
    if (P > S) relax(i + 1, j, SKIP_PH, 'skipPhrase'); // script with no audio (expensive)
    if (i < P && isDir[i]) { if (j < S) relax(i + 1, j + 1, 0.35, { p: 1, q: 1 }); continue; }
    for (let q = 1; q <= (S > P ? K : 1) && j + q <= S; q++) { // one phrase over q segments
      // speech time only (the pauses inside aren't syllables); long pauses inside one phrase are unlikely:
      // people rarely stop for more than ~0.4 s mid-sentence
      let d = 0, n = 0, gap = 0;
      for (let k = 0; k < q; k++) { d += dur[j + k]; n += peaks[j + k]; if (k) gap += Math.max(0, segs[j + k].start - segs[j + k - 1].end - T.pause); }
      relax(i + 1, j + q, fit(d, n, syl[i]) + MERGE * (q - 1) + GAP * gap, { p: 1, q });
    }
    for (let p = 2; p <= (P > S ? K : 1) && i + p <= P; p++) { // p phrases sharing one segment
      if (isDir.slice(i, i + p).some(Boolean)) break;
      let s = 0; for (let k = 0; k < p; k++) s += syl[i + k];
      relax(i + p, j + 1, fit(dur[j], peaks[j], s) + MERGE * (p - 1), { p, q: 1 });
    }
  }
  // walk back
  const cues = []; let i = P, j = S;
  while (i > 0 || j > 0) {
    const f = from[i][j]; if (!f) break;
    if (f.move === 'skipPhrase') cues.push({ start: segs[Math.min(f.j, S - 1)].start, end: segs[Math.min(f.j, S - 1)].start + 0.8, text: ph[f.i], guessed: true });
    else if (typeof f.move === 'object') {
      const { p, q } = f.move;
      if (p === 1) cues.push({ start: segs[f.j].start, end: segs[f.j + q - 1].end, text: ph[f.i] });
      else cues.push({ start: segs[f.j].start, end: segs[f.j].end, text: ph.slice(f.i, f.i + p).join(' ') }); // lines sharing one stretch: shown together (no time split inside a stretch)
    }
    i = f.i; j = f.j;
  }
  cues.sort((a, b) => a.start - b.start);
  return { cues, segments: segs.length, phrases: P, cost: cost[P][S] };
}

// cached captions for an audio source: { src, script, cues: [{ start, end, text }] }
export const loadCaptions = (src) => get('captions', src);
export const saveCaptions = (src, data) => put('captions', src, data);
// the cue on screen at time t (held a moment past its end, so short phrases can be read)
export function cueAt(caps, t) { return caps?.cues.find((c) => t >= c.start - 0.08 && t <= c.end + 0.45 && c.text) || null; }
