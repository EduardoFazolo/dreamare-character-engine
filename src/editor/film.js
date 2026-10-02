// Films: a scene that plays itself. scene.film = {
//   secs,                                   the length
//   shots: [{ shot, from, to }],            the scene's shots on a timeline (a shot's move runs from its `from`)
//   sounds: [{ src, start?, offset?, gain?, loop?, loopEnd?, lips?, ref?, near?,   audio files placed in the world:
//              at: [{ t, actor | 'camera', offset? }] }],           where it comes from, switching over time
//   beds: [{ id, gain, offset?, fade? }],  ambience (public/ambience) under everything, not placed
//   fog: [[t, k]], mist: [[t, amount]],    the fog's distances times k over time (k < 1: thicker), the mist's amount
//   hide: [{ actor, from, to? }] }         a character gone from that moment (swallowed by the fog)
// fade: [[t, level]] on a sound or a bed: its level over time, on top of everything else
// Sounds are 3D: an HRTF panner at the source (a character's head, or somewhere round the camera), a distance
// loss (ref: the distance at full level; far away it gets quieter, duller and wetter: a lowpass closing and a
// reverb send opening, so a voice across the dunes sounds across the dunes), and `near`: a sound that only
// exists up close (breathing). lips: the mouth of the character it comes from follows its loudness.
// One graph, driven two ways: live (the editor's audio context, updated each frame) and offline (an
// OfflineAudioContext with every frame's positions scheduled), so an export sounds exactly like the preview.
import * as THREE from 'three';
import { analyse, mouthAt } from './voice.js';

const bufCache = new Map();
async function fetchBuf(url) { if (!bufCache.has(url)) bufCache.set(url, fetch(url).then((r) => { if (!r.ok) throw new Error(`missing ${url}`); return r.arrayBuffer(); })); return (await bufCache.get(url)).slice(0); }
const envCache = new Map();
export async function loadFilm(film, ctx) {
  const out = { sounds: [], beds: [] };
  for (const s of film.sounds || []) {
    const buffer = await ctx.decodeAudioData(await fetchBuf(s.src));
    if (!envCache.has(s.src)) envCache.set(s.src, { ...analyse(buffer), vis: s.lips ? visemes(buffer) : null });
    out.sounds.push({ spec: s, buffer, env: envCache.get(s.src) });
  }
  for (const b of film.beds || []) out.beds.push({ spec: b, buffer: await ctx.decodeAudioData(await fetchBuf(`/ambience/${b.id}.mp3`)) });
  return out;
}

function impulse(ctx, secs = 4.2) { // a dark, open reverb: decaying noise, the highs dying first
  const n = Math.floor(ctx.sampleRate * secs), ir = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c); let lp = 0;
    for (let i = 0; i < n; i++) { const t = i / n; lp += (Math.random() * 2 - 1 - lp) * (0.5 - 0.42 * t); d[i] = lp * Math.pow(1 - t, 2.4); }
  }
  return ir;
}

// the graph: every sound -> gain -> lowpass -> panner -> dry / reverb send -> out
export function buildGraph(ctx, loaded, out, t0) {
  const verb = ctx.createConvolver(); verb.buffer = impulse(ctx); const wet = ctx.createGain(); wet.gain.value = 0.9; verb.connect(wet).connect(out);
  const nodes = loaded.sounds.map(({ spec, buffer, env }) => {
    const src = ctx.createBufferSource(); src.buffer = buffer;
    if (spec.loop) { src.loop = true; src.loopStart = spec.loopStart || 0; src.loopEnd = spec.loopEnd || buffer.duration; }
    const gain = ctx.createGain(), air = ctx.createBiquadFilter(), body = ctx.createBiquadFilter(), pan = new PannerNode(ctx, { panningModel: 'HRTF', distanceModel: 'linear', rolloffFactor: 0 });
    const dry = ctx.createGain(), send = ctx.createGain(); air.type = 'lowpass'; body.type = 'lowshelf'; body.frequency.value = 220;
    // (body: the bass that swells when a sound is right at your ear)
    gain.gain.value = 0; src.connect(gain).connect(air).connect(body).connect(pan); pan.connect(dry).connect(out); pan.connect(send).connect(verb);
    src.start(t0 + (spec.start || 0), spec.offset || 0); // (offset: where in the file it starts)
    return { spec, env, src, gain, air, body, pan, dry, send };
  });
  const beds = loaded.beds.map(({ spec, buffer }) => { const src = ctx.createBufferSource(); src.buffer = buffer; src.loop = true; const g = ctx.createGain(); g.gain.value = (spec.gain ?? 0.4) * kf(spec.fade, 0); src.connect(g).connect(out); src.start(t0, spec.offset || 0); return { spec, src, g }; });
  return { nodes, beds, stop: () => { for (const n of nodes) try { n.src.stop(); } catch { /* */ } for (const b of beds) try { b.src.stop(); } catch { /* */ } } };
}

// where a sound is at film time t: its `at` entry for t (an actor's head, or the camera plus an offset in the
// camera's own frame)
export function sourcePos(spec, t, actors, camera, out = new THREE.Vector3()) {
  const list = spec.at || [], i = list.findLastIndex((a) => t >= (a.t || 0)), at = list[i] || list[0];
  if (!at) return out.copy(camera.position);
  if (at.actor === 'camera') { // (round the camera; "glide": true on the next entry moves it there smoothly: a sound walking round your head)
    const o = new THREE.Vector3(...(at.offset || [0, 0, -1])), nx = list[i + 1];
    if (nx?.glide && nx.actor === 'camera') { const k = (t - (at.t || 0)) / ((nx.t || 0) - (at.t || 0) || 1), e = k * k * (3 - 2 * k); o.lerp(new THREE.Vector3(...(nx.offset || [0, 0, -1])), e); }
    return out.copy(o).applyQuaternion(camera.quaternion).add(camera.position);
  }
  const o = actors.get(at.actor); if (!o) return out.copy(camera.position);
  o.rig.bones.Head.getWorldPosition(out); if (at.offset) out.add(new THREE.Vector3(...at.offset));
  return out;
}
// the levels for a sound at distance d from the listener
export function levels(spec, d) {
  const ref = spec.ref ?? 2, g = spec.gain ?? 1;
  const loud = spec.near ? Math.pow(ref / Math.max(d, ref), 1.6) : Math.pow(ref / Math.max(d, ref), 0.5); // (a voice carries across the dunes; breathing doesn't)
  const far = d / (d + 8);
  return { gain: g * loud, lp: THREE.MathUtils.clamp(19000 / (1 + d * 0.22), 500, 19000), dry: 1 - 0.8 * far, wet: 0.02 + 1.4 * far * far, body: THREE.MathUtils.clamp(9 * (1 - d / 1.2), 0, 9) }; // (near: dry and bassy; far: dull and mostly echo)
}
// schedule one frame's state at audio time `at`: the listener at the camera, every sound where it is
export function schedule(ctx, graph, at, t, actors, camera, live = false) {
  const L = ctx.listener, p = camera.position, f = camera.getWorldDirection(new THREE.Vector3()), u = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
  const set = (param, v) => (live ? param.setTargetAtTime(v, at, 0.03) : param.setValueAtTime(v, at));
  if (L.positionX) { set(L.positionX, p.x); set(L.positionY, p.y); set(L.positionZ, p.z); set(L.forwardX, f.x); set(L.forwardY, f.y); set(L.forwardZ, f.z); set(L.upX, u.x); set(L.upY, u.y); set(L.upZ, u.z); }
  const v = new THREE.Vector3();
  for (const b of graph.beds) if (b.spec.fade) set(b.g.gain, (b.spec.gain ?? 0.4) * kf(b.spec.fade, t));
  for (const n of graph.nodes) {
    sourcePos(n.spec, t, actors, camera, v);
    const d = v.distanceTo(p), lv = levels(n.spec, d);
    set(n.pan.positionX, v.x); set(n.pan.positionY, v.y); set(n.pan.positionZ, v.z);
    set(n.gain.gain, lv.gain * kf(n.spec.fade, t)); // (fade: [[t, level]] on top of the distance) set(n.air.frequency, lv.lp); set(n.body.gain, lv.body); set(n.dry.gain, lv.dry); set(n.send.gain, lv.wet);
  }
}
// mouths: for every lips sound, its source character's mouth at film time t (by the file's loudness there)
export function mouths(film, loaded, t) {
  const out = new Map();
  for (const { spec, env } of loaded.sounds) {
    if (!spec.lips) continue;
    const at = [...(spec.at || [])].reverse().find((a) => t >= (a.t || 0)) || spec.at?.[0], lt = t - (spec.start || 0) + (spec.offset || 0);
    if (!at?.actor || at.actor === 'camera' || t < (spec.start || 0) || lt > env.duration || kf(spec.fade, t) < 0.05) continue;
    out.set(at.actor, env.vis ? visAt(env.vis, lt) : singMouth(env, lt));
  }
  return out;
}
// Lip shapes from the voice's spectrum (100 a second), for a low sung / hummed line where loudness hardly moves:
//   silence -> closed and slack; a hiss above 3 kHz (s, z) -> teeth together, lips a little wide; energy all
//   below 400 Hz -> a hum: lips pressed (M) early in a phrase, rounded (OO) in its last third; energy rising
//   above 400 Hz -> an open vowel, the jaw as far open as the shift, wide (EE) early, round late.
// Phrases: voiced stretches split by 0.3 s of quiet. Smoothed: a mouth takes ~60 ms to change shape.
function visemes(buf) {
  const sr = buf.sampleRate, d = buf.getChannelData(0), N = 1024, hop = Math.round(sr / 100), n = Math.floor((d.length - N) / hop);
  const re = new Float64Array(N), im = new Float64Array(N), win = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  const fft = () => { // in place, radix 2
    for (let i = 1, j = 0; i < N; i++) { let b = N >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
    for (let len = 2; len <= N; len <<= 1) { const a = (-2 * Math.PI) / len; for (let i = 0; i < N; i += len) for (let k = 0; k < len / 2; k++) { const c = Math.cos(a * k), si = Math.sin(a * k), xr = re[i + k + len / 2] * c - im[i + k + len / 2] * si, xi = re[i + k + len / 2] * si + im[i + k + len / 2] * c; re[i + k + len / 2] = re[i + k] - xr; im[i + k + len / 2] = im[i + k] - xi; re[i + k] += xr; im[i + k] += xi; } }
  };
  const bin = (f) => Math.round((f * N) / sr), b400 = bin(400), b3k = bin(3000);
  const E = new Float32Array(n), LO = new Float32Array(n), HI = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    for (let i = 0; i < N; i++) { re[i] = d[f * hop + i] * win[i]; im[i] = 0; } fft();
    let e = 0, lo = 0, hi = 0; for (let k = 1; k < N / 2; k++) { const p = re[k] * re[k] + im[k] * im[k]; e += p; if (k < b400) lo += p; else if (k > b3k) hi += p; }
    E[f] = 10 * Math.log10(e + 1e-12); LO[f] = lo / (e || 1); HI[f] = hi / (e || 1);
  }
  const peak = [...E].sort((a, b) => a - b)[Math.floor(n * 0.95)], voiced = (f) => E[f] > peak - 22;
  // phrases, for "early / late in the phrase"
  const sung = (f) => E[f] > peak - 9; // (phrases split where the singing drops, not just where it goes silent: the breath and reverb between lines stay within 20 dB)
  const phase = new Float32Array(n).fill(-1); let f0 = -1, quiet = 0;
  const close = (f1) => { for (let k = f0; k <= f1; k++) phase[k] = (k - f0) / Math.max(1, f1 - f0); };
  for (let f = 0; f < n; f++) { if (sung(f)) { if (f0 < 0) f0 = f; quiet = 0; } else if (f0 >= 0 && ++quiet > 25) { close(f - quiet); f0 = -1; } }
  if (f0 >= 0) close(n - 1);
  // the line is known ("re-meee-mber the duunes"): each phrase walks this script, its timing a fraction of the
  // phrase, the jaw scaled by how loud that moment is and opened a little more where the energy rises
  const SCRIPT = [ // [from, shape]
    [0.0, { mouthPucker: 0.5, jawOpen: 0.18 }], // R
    [0.05, { jawOpen: 0.5, mouthWide: 0.5 }], // EEEE
    [0.26, { mouthClose: 1 }], // M
    [0.31, { mouthClose: 1 }], // B
    [0.34, { jawOpen: 0.38, mouthPucker: 0.2 }], // ER
    [0.42, { jawOpen: 0.28, mouthWide: 0.3 }], // THE
    [0.5, { jawOpen: 0.12, mouthClose: 0.35 }], // D
    [0.55, { jawOpen: 0.22, mouthFunnel: 0.95 }], // UUUU
    [0.9, { jawOpen: 0.1, mouthClose: 0.5 }], // N
    [0.95, { jawOpen: 0.07, mouthWide: 0.45, mouthClose: 0.25 }], // Z
  ];
  const raw = Array.from({ length: n }, (_, f) => {
    const m = { jawOpen: 0, mouthWide: 0, mouthPucker: 0, mouthFunnel: 0, mouthClose: 0 };
    if (!voiced(f) || phase[f] < 0) { m.mouthClose = 0.6; return m; }
    const loud = Math.min(1, Math.max(0, (E[f] - (peak - 22)) / 18)), lift = Math.min(1, Math.max(0, (0.9 - LO[f]) / 0.55));
    let i = 0; while (i + 1 < SCRIPT.length && phase[f] >= SCRIPT[i + 1][0]) i++;
    for (const [k, v] of Object.entries(SCRIPT[i][1])) m[k] = v;
    m.jawOpen *= (0.65 + 0.35 * loud) * (1 + 0.5 * lift);
    return m;
  });
  const out = raw.map((m) => ({ ...m })), a = 0.35; // (a mouth can't jump: smoothed both ways)
  for (let f = 1; f < n; f++) for (const k in out[f]) out[f][k] = out[f - 1][k] + (raw[f][k] - out[f - 1][k]) * a;
  for (let f = n - 2; f >= 0; f--) for (const k in out[f]) out[f][k] = out[f + 1][k] + (out[f][k] - out[f + 1][k]) * (1 - a * 0.5);
  return out;
}
const visAt = (vis, t) => vis[Math.min(vis.length - 1, Math.max(0, Math.floor(t * 100)))];
// a sung line's mouth: loudness against its own half-second around (a held note kept the jaw pinned open: every
// syllable now opens and closes), scaled by how loud it is overall, a hiss (s, z) narrowing it, a soft dark vowel
// rounding it ("dunes": oo)
function singMouth(env, t) {
  const f = Math.floor(t * env.fps), W = Math.round(0.35 * env.fps), R = env.rms, n = R.length; if (f < 0 || f >= n) return { jawOpen: 0, mouthWide: 0, mouthPucker: 0 };
  let lo = Infinity, hi = 0; for (let i = Math.max(0, f - W); i < Math.min(n, f + W); i++) { lo = Math.min(lo, R[i]); hi = Math.max(hi, R[i]); }
  const x = R[f], rel = hi - lo > 0.05 ? (x - lo) / (hi - lo) : 0.5, loud = Math.min(1, x / 0.9), hiss = Math.min(1, Math.max(0, (env.zcr[f] - 0.12) / 0.18));
  const open = Math.pow(Math.min(1, Math.max(0, rel)), 1.3) * loud;
  return { jawOpen: Math.min(0.8, open * 0.85 * (1 - hiss * 0.6)), mouthWide: Math.min(0.7, hiss * loud * 0.8 + open * 0.2), mouthPucker: Math.min(0.5, (1 - hiss) * (1 - rel) * loud * 0.6) };
}
// a keyframed value at t: [[t, v], ...], linear between keys, held past the ends (none: 1)
export function kf(list, t, def = 1) {
  if (!list?.length) return def;
  if (t <= list[0][0]) return list[0][1];
  for (let i = 1; i < list.length; i++) if (t <= list[i][0]) { const [t0, v0] = list[i - 1], [t1, v1] = list[i], k = (t - t0) / (t1 - t0 || 1); return v0 + (v1 - v0) * k; }
  return list.at(-1)[1];
}
// the shot playing at film time t
export const shotAt = (film, t) => (film.shots || []).find((s) => t >= s.from && t < s.to) || film.shots?.at(-1);
