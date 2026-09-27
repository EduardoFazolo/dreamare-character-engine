// Any audio file playing out of the phone booth's dangling receiver, on repeat, placed in 3D.
// Not wired by default: see PHONE_AUDIO in main.js.
//
// source -> phone speaker (band-limited 300-3.4k like a phone line, a plastic handset resonance,
//           a little small-speaker grit, faint line hiss)
//        -> booth occlusion (the solid back wall muffles; the open door doesn't)
//        -> air (highs fade with distance)
//        -> HRTF panner at the receiver (inverse-distance falloff)  -> dry
//                                                                  -> outdoor space (wetter when far)
// Browsers only start audio after a user gesture: call start() from a click / key handler.
import * as THREE from 'three';

function impulse(ctx, seconds, decay) { // a soft, open-air tail (no walls: short and diffuse)
  const n = Math.floor(ctx.sampleRate * seconds), b = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay); }
  return b;
}

export const falloff = (d) => Math.pow(1 / Math.max(d, 0.7), 1.6) * (1 - THREE.MathUtils.smoothstep(d, 12, 26));

export function createPhoneAudio(url) {
  let ctx = null, nodes = null, buffer = null, loading = null, muted = false, volume = 0.8;
  const inv = new THREE.Matrix4(), tmp = new THREE.Vector3(), fwd = new THREE.Vector3(), up = new THREE.Vector3(), local = new THREE.Vector3();

  async function build() {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    loading = fetch(url).then((r) => r.arrayBuffer()).then((a) => ctx.decodeAudioData(a));
    buffer = await loading;

    const src = ctx.createBufferSource(); src.buffer = buffer; src.loop = true;
    // normalise: the file may be mastered very quietly; bring its peak to -1 dBFS before the phone chain
    let peak = 1e-6;
    for (let c = 0; c < buffer.numberOfChannels; c++) { const d = buffer.getChannelData(c); for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > peak) peak = v; } }
    const mono = ctx.createGain(); mono.gain.value = Math.min(40, 0.89 / peak); mono.channelCount = 1; mono.channelCountMode = 'explicit'; mono.channelInterpretation = 'speakers';

    // phone line: steep band-pass 300 Hz - 3.4 kHz, with the tinny presence bump
    const hp1 = ctx.createBiquadFilter(), hp2 = ctx.createBiquadFilter(), lp1 = ctx.createBiquadFilter(), lp2 = ctx.createBiquadFilter(), bump = ctx.createBiquadFilter();
    hp1.type = hp2.type = 'highpass'; hp1.frequency.value = hp2.frequency.value = 320; hp1.Q.value = hp2.Q.value = 0.7;
    lp1.type = lp2.type = 'lowpass'; lp1.frequency.value = lp2.frequency.value = 3300; lp1.Q.value = lp2.Q.value = 0.8;
    bump.type = 'peaking'; bump.frequency.value = 1700; bump.Q.value = 1.4; bump.gain.value = 6;
    // plastic handset: a very short feedback comb (~1.3 ms) colours it like a small cavity
    const comb = ctx.createDelay(0.01), fb = ctx.createGain(), combMix = ctx.createGain();
    comb.delayTime.value = 0.0013; fb.gain.value = 0.32; combMix.gain.value = 1;
    // small speaker pushed a bit: soft clip
    const grit = ctx.createWaveShaper(), curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) { const x = (i / 1023) * 2 - 1; curve[i] = Math.tanh(x * 2.2) / Math.tanh(2.2); }
    grit.curve = curve; grit.oversample = '2x';
    const pre = ctx.createGain(); pre.gain.value = 1.4;

    // faint line hiss under the music
    const nb = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), nd = nb.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    const hiss = ctx.createBufferSource(); hiss.buffer = nb; hiss.loop = true;
    const hissBand = ctx.createBiquadFilter(); hissBand.type = 'bandpass'; hissBand.frequency.value = 2200; hissBand.Q.value = 0.6;
    const hissGain = ctx.createGain(); hissGain.gain.value = 0.012;

    const occl = ctx.createBiquadFilter(); occl.type = 'lowpass'; occl.frequency.value = 20000; occl.Q.value = 0.5;
    const occlGain = ctx.createGain();
    const air = ctx.createBiquadFilter(); air.type = 'lowpass'; air.frequency.value = 20000; air.Q.value = 0.5;

    // the panner only places it (HRTF); distance loss is ours (below), so it can reach true silence.
    // The earpiece is directional: loudest out of the open door, weaker to the sides and behind.
    const panner = new PannerNode(ctx, { panningModel: 'HRTF', distanceModel: 'inverse', rolloffFactor: 0, coneInnerAngle: 90, coneOuterAngle: 240, coneOuterGain: 0.4 });
    const dist = ctx.createGain();
    const dry = ctx.createGain(), wet = ctx.createGain(), verb = ctx.createConvolver(), master = ctx.createGain();
    verb.buffer = impulse(ctx, 1.6, 3);
    master.gain.value = 0;

    src.connect(mono).connect(hp1).connect(hp2).connect(bump).connect(pre).connect(grit).connect(combMix);
    grit.connect(comb).connect(fb).connect(comb); comb.connect(combMix);
    combMix.connect(lp1).connect(lp2);
    hiss.connect(hissBand).connect(hissGain).connect(lp2);
    lp2.connect(occl).connect(occlGain).connect(air).connect(panner);
    panner.connect(dist);
    dist.connect(dry).connect(master);
    dist.connect(verb).connect(wet).connect(master);
    master.connect(ctx.destination);
    const meter = ctx.createAnalyser(); meter.fftSize = 2048; master.connect(meter);
    const meterIn = ctx.createAnalyser(); meterIn.fftSize = 2048; lp2.connect(meterIn); // phone sound before space
    src.start(); hiss.start();
    nodes = { panner, dist, occl, occlGain, air, dry, wet, master, meter, meterIn };
    applyGain(2.5); // fade in
  }

  function applyGain(tau = 0.2) {
    if (nodes) nodes.master.gain.setTargetAtTime(muted ? 0 : volume, ctx.currentTime, tau / 3);
  }

  const set = (param, v, tau = 0.08) => param.setTargetAtTime(v, ctx.currentTime, tau);

  return {
    get started() { return !!ctx; },
    // call from a user gesture
    async start() {
      if (!ctx) await build();
      else if (ctx.state !== 'running') await ctx.resume();
    },
    // output loudness (RMS dBFS), for tests and meters
    level(which = 'meter') { if (!nodes) return -Infinity; const m = nodes[which], a = new Float32Array(m.fftSize); m.getFloatTimeDomainData(a); let e = 0; for (const v of a) e += v * v; return 10 * Math.log10(e / a.length + 1e-12); },
    // a MediaStream of what you hear (for recording); created once
    stream() { if (!nodes) return null; if (!nodes.rec) { nodes.rec = ctx.createMediaStreamDestination(); nodes.master.connect(nodes.rec); } return nodes.rec.stream; },
    setMuted(m) { muted = m; applyGain(); },
    setVolume(v) { volume = v; applyGain(); },
    // emitter: the receiver object (world position each frame); booth: its matrixWorld for occlusion
    update(camera, emitter, booth) {
      if (!nodes || !emitter) return;
      const { panner, dist, occl, occlGain, air, dry, wet } = nodes, L = ctx.listener, t = ctx.currentTime;
      // listener = camera
      camera.getWorldDirection(fwd); up.set(0, 1, 0).applyQuaternion(camera.quaternion);
      const p = camera.position;
      if (L.positionX) {
        L.positionX.setTargetAtTime(p.x, t, 0.02); L.positionY.setTargetAtTime(p.y, t, 0.02); L.positionZ.setTargetAtTime(p.z, t, 0.02);
        L.forwardX.setTargetAtTime(fwd.x, t, 0.02); L.forwardY.setTargetAtTime(fwd.y, t, 0.02); L.forwardZ.setTargetAtTime(fwd.z, t, 0.02);
        L.upX.setTargetAtTime(up.x, t, 0.02); L.upY.setTargetAtTime(up.y, t, 0.02); L.upZ.setTargetAtTime(up.z, t, 0.02);
      } else { L.setPosition(p.x, p.y, p.z); L.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z); }
      // emitter = the dangling receiver
      emitter.getWorldPosition(tmp);
      if (booth) { // the earpiece faces out of the open door (booth +z), tipped down a little
        const e = booth.matrixWorld.elements, ox = e[8], oy = e[9] - 0.3, oz = e[10];
        panner.orientationX.setTargetAtTime(ox, t, 0.05); panner.orientationY.setTargetAtTime(oy, t, 0.05); panner.orientationZ.setTargetAtTime(oz, t, 0.05);
      }
      panner.positionX.setTargetAtTime(tmp.x, t, 0.02); panner.positionY.setTargetAtTime(tmp.y, t, 0.02); panner.positionZ.setTargetAtTime(tmp.z, t, 0.02);
      const d = p.distanceTo(tmp);

      // booth walls: listener in booth space (+z is the open door, -z the solid back wall with the phone)
      let cut = 20000, g = 1;
      if (booth) {
        local.copy(p).applyMatrix4(inv.copy(booth.matrixWorld).invert());
        const inside = Math.abs(local.x) < 0.5 && Math.abs(local.z) < 0.5;
        if (!inside) {
          const ang = Math.atan2(local.x, local.z); // 0 = in front of the door, ±π = behind the back wall
          const behind = THREE.MathUtils.smoothstep(Math.abs(ang), 1.9, 2.8), side = THREE.MathUtils.smoothstep(Math.abs(ang), 0.8, 1.9);
          cut = THREE.MathUtils.lerp(THREE.MathUtils.lerp(20000, 5000, side), 900, behind); // panes let most through; the back wall doesn't
          g = THREE.MathUtils.lerp(1, 0.55, behind);
        } else g = 1.15; // in the booth, it's right by your ear
      }
      set(occl.frequency, cut); set(occlGain.gain, g);
      // air: highs thin out with distance, and far away you mostly hear it in the open space
      set(air.frequency, THREE.MathUtils.clamp(16000 / (1 + d * 0.25), 1000, 16000));
      // a small speaker doesn't carry: amplitude ~ d^-1.6 (2 m -10 dB, 5 m -22, 10 m -32), faded to silence 12-26 m
      set(dist.gain, falloff(d));
      set(dry.gain, 1); set(wet.gain, 0.06); // nearly dry, so it stays pinned to the receiver
    },
  };
}
