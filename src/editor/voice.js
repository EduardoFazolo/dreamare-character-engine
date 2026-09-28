// Voice lines for scene characters: an audio file plays from the character's head in 3D (HRTF, distance loss,
// silence far away) and drives the mouth.
// Lip sync is precomputed per file (deterministic, locked to the audio clock): every 10 ms the loudness (RMS)
// and the zero-crossing rate. Loud -> jaw opens; hissy (s, f, sh: many zero crossings) -> the mouth widens,
// jaw half-closed; voiced but soft -> a slight pucker. Browsers start audio only after a user gesture (Play).
import * as THREE from 'three';
import { get, put, all, uid } from '../store.js';

// files in the project's assets folder (Vite lists them at build time)
const ASSETS = import.meta.glob('/assets/*.{wav,mp3,ogg,m4a,flac}', { query: '?url', import: 'default', eager: true });
export const assetList = () => Object.entries(ASSETS).map(([path, url]) => ({ src: `asset:${path}`, name: path.split('/').pop(), url }));
export async function importedList() { return (await all('audio')).sort((a, b) => b.created - a.created).map((a) => ({ src: `db:${a.id}`, name: a.name })); }
export async function importFile(file) { const id = uid(); await put('audio', id, { id, name: file.name, data: await file.arrayBuffer(), created: Date.now() }); return { src: `db:${id}`, name: file.name }; }

let ctx = null, master = null;
export function audioCtx() {
  if (!ctx) { ctx = new (window.AudioContext || window.webkitAudioContext)(); master = ctx.createGain(); master.gain.value = 1; master.connect(ctx.destination); }
  if (ctx.state !== 'running') ctx.resume();
  return ctx;
}
export async function rawBytes(src) {
  if (src.startsWith('asset:')) { const url = ASSETS[src.slice(6)]; if (!url) throw new Error(`missing asset ${src.slice(6)}`); return (await fetch(url)).arrayBuffer(); }
  if (src.startsWith('db:')) { const a = await get('audio', src.slice(3)); if (!a) throw new Error('missing imported audio'); return a.data.slice(0); }
  throw new Error(`unknown audio source ${src}`);
}

// decode + analyse once per source
const cache = new Map();
export function loadVoice(src) {
  if (!cache.has(src)) cache.set(src, (async () => {
    const buffer = await audioCtx().decodeAudioData(await rawBytes(src));
    return { buffer, env: analyse(buffer) };
  })());
  return cache.get(src);
}
function analyse(buffer) {
  const sr = buffer.sampleRate, hop = Math.round(sr * 0.01), win = hop * 2, n = Math.floor(buffer.length / hop);
  const ch = [...Array(buffer.numberOfChannels)].map((_, c) => buffer.getChannelData(c));
  const rms = new Float32Array(n), zcr = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let e = 0, z = 0, prev = 0; const a = f * hop, b = Math.min(buffer.length, a + win);
    for (let i = a; i < b; i++) { let v = 0; for (const c of ch) v += c[i]; v /= ch.length; e += v * v; if ((v >= 0) !== (prev >= 0)) z++; prev = v; }
    rms[f] = Math.sqrt(e / Math.max(1, b - a)); zcr[f] = z / Math.max(1, b - a);
  }
  // normalise loudness to this file's loud speech (95th percentile), so quiet and hot recordings move the same
  const sorted = [...rms].sort((x, y) => x - y), p95 = sorted[Math.floor(sorted.length * 0.95)] || 1, floor = sorted[Math.floor(sorted.length * 0.2)] || 0;
  for (let f = 0; f < n; f++) rms[f] = Math.max(0, (rms[f] - floor) / Math.max(1e-6, p95 - floor));
  return { rms, zcr, fps: 100, duration: buffer.duration };
}
// mouth shape at time t (seconds into the line)
export function mouthAt(env, t) {
  const f = Math.min(env.rms.length - 1, Math.max(0, Math.floor(t * env.fps)));
  const loud = Math.min(1.3, env.rms[f]), hiss = THREE.MathUtils.smoothstep(env.zcr[f], 0.12, 0.3);
  const open = THREE.MathUtils.smoothstep(loud, 0.06, 0.95);
  return { jawOpen: Math.min(0.85, open * (1 - hiss * 0.5)), mouthWide: Math.min(0.8, hiss * loud * 0.9), mouthPucker: Math.min(0.35, (1 - hiss) * THREE.MathUtils.smoothstep(loud, 0.05, 0.4) * (1 - open) * 0.8) };
}

// a speaking voice, placed at a world position each frame
export function playVoice({ buffer, env }, { loop = false, volume = 1 } = {}) {
  const c = audioCtx(), src = c.createBufferSource(); src.buffer = buffer; src.loop = loop;
  const gain = c.createGain(), dist = c.createGain(), air = c.createBiquadFilter();
  air.type = 'lowpass'; air.frequency.value = 20000;
  const panner = new PannerNode(c, { panningModel: 'HRTF', distanceModel: 'inverse', rolloffFactor: 0, coneInnerAngle: 140, coneOuterAngle: 300, coneOuterGain: 0.55 }); // speaking forward
  gain.gain.value = volume;
  src.connect(gain).connect(air).connect(panner).connect(dist).connect(master);
  const t0 = c.currentTime; src.start();
  const v = { env, loop, ended: false, smooth: { jawOpen: 0, mouthWide: 0, mouthPucker: 0 } };
  src.onended = () => { v.ended = true; };
  v.time = () => { const t = c.currentTime - t0; return loop ? t % buffer.duration : t; };
  v.stop = () => { try { src.stop(); } catch { /* already stopped */ } v.ended = true; };
  const set = (p, x) => p.setTargetAtTime(x, c.currentTime, 0.03);
  v.place = (pos, facing, listenerPos) => {
    set(panner.positionX, pos.x); set(panner.positionY, pos.y); set(panner.positionZ, pos.z);
    set(panner.orientationX, facing.x); set(panner.orientationY, facing.y); set(panner.orientationZ, facing.z);
    const d = pos.distanceTo(listenerPos);
    set(dist.gain, Math.pow(1 / Math.max(d, 1), 1.15) * (1 - THREE.MathUtils.smoothstep(d, 22, 42))); // a voice carries further than a phone, but not forever
    set(air.frequency, THREE.MathUtils.clamp(18000 / (1 + d * 0.12), 1800, 18000));
  };
  // mouth with a little attack / release smoothing (fast open, slower close)
  v.mouth = (dt) => {
    const m = mouthAt(env, v.time()), out = {};
    for (const k of Object.keys(m)) { const cur = v.smooth[k], target = v.ended ? 0 : m[k], rate = target > cur ? 28 : 12; out[k] = v.smooth[k] = cur + (target - cur) * Math.min(1, dt * rate); }
    return out;
  };
  return v;
}
// the mix bus voices (and ambience) play into
export function outputBus() { audioCtx(); return master; }
// everything the voices play, as a MediaStream (for recording video with sound)
let recDest = null;
export function voiceStream() { audioCtx(); if (!recDest) { recDest = ctx.createMediaStreamDestination(); master.connect(recDest); } return recDest.stream; }
export function setListener(camera) {
  if (!ctx) return;
  const L = ctx.listener, p = camera.position, f = camera.getWorldDirection(new THREE.Vector3()), u = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion), t = ctx.currentTime;
  if (L.positionX) {
    L.positionX.setTargetAtTime(p.x, t, 0.02); L.positionY.setTargetAtTime(p.y, t, 0.02); L.positionZ.setTargetAtTime(p.z, t, 0.02);
    L.forwardX.setTargetAtTime(f.x, t, 0.02); L.forwardY.setTargetAtTime(f.y, t, 0.02); L.forwardZ.setTargetAtTime(f.z, t, 0.02);
    L.upX.setTargetAtTime(u.x, t, 0.02); L.upY.setTargetAtTime(u.y, t, 0.02); L.upZ.setTargetAtTime(u.z, t, 0.02);
  } else { L.setPosition(p.x, p.y, p.z); L.setOrientation(f.x, f.y, f.z, u.x, u.y, u.z); }
}
