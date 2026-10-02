// Moving mist: the fog you can watch drift. The scene's fog is a colour that thickens with distance (nothing in
// it moves), so this adds banks of mist around the view: soft upright sheets standing on the ground, each a
// tileable noise sampled twice, scrolling at two speeds and directions so it churns rather than slides,
// tinted the fog's own colour, fading out close to the camera and into the distance. How thick: the scene's fog
// (haze). Driven by time alone: it drifts in a live slide and in an export, a snapped frame holds it.
// The sheets sit on a world grid round the camera (they stay where they are as the camera moves), turned to
// face it about the vertical only.
import * as THREE from 'three';
import { PS2 } from '../head.js';

function noiseTex() { // tileable fBm, 128 px
  const N = 128, c = Object.assign(document.createElement('canvas'), { width: N, height: N }), g = c.getContext('2d'), img = g.createImageData(N, N);
  const hash = (x, y, s) => { const v = Math.sin(x * 127.1 + y * 311.7 + s * 74.7) * 43758.5453; return v - Math.floor(v); };
  const val = (x, y, p, s) => { // value noise wrapping every p cells
    const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi, u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    const at = (i, j) => hash(((i % p) + p) % p, ((j % p) + p) % p, s);
    return (at(xi, yi) * (1 - u) + at(xi + 1, yi) * u) * (1 - v) + (at(xi, yi + 1) * (1 - u) + at(xi + 1, yi + 1) * u) * v;
  };
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let a = 0, amp = 0.5, tot = 0;
    for (let o = 0, p = 4; o < 5; o++, p *= 2) { a += val((x / N) * p, (y / N) * p, p, o) * amp; tot += amp; amp *= 0.5; }
    const k = Math.max(0, Math.min(255, ((a / tot - 0.35) / 0.5) * 255)), i = (y * N + x) * 4;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = 255; img.data[i + 3] = k;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = t.minFilter = THREE.LinearFilter;
  return t;
}

export function createMist(scene) {
  const tex = noiseTex(), R = 3, sheets = [];
  const mat = new THREE.ShaderMaterial({
    uniforms: { map: { value: tex }, color: { value: new THREE.Color() }, amount: { value: 0 }, time: { value: 0 }, camPos: { value: new THREE.Vector3() }, far: { value: 60 }, reach: { value: 30 } },
    vertexShader: /* glsl */`
      attribute float seed; varying vec2 vUv; varying float vSeed; varying vec3 vW;
      void main(){ vUv = uv; vSeed = seed; vec4 w = modelMatrix * vec4(position, 1.); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */`
      uniform sampler2D map; uniform vec3 color, camPos; uniform float amount, time, far, reach; varying vec2 vUv; varying float vSeed; varying vec3 vW;
      void main(){
        vec2 a = vUv * vec2(2.2, 0.8) + vec2(time * 0.03 + vSeed, time * 0.006);
        vec2 b = vUv * vec2(1.3, 0.5) + vec2(-time * 0.019 + vSeed * 2.3, time * 0.01 + vSeed);
        float n = texture2D(map, a).a * texture2D(map, b).a * 2.4;
        float edge = smoothstep(0., .18, vUv.x) * smoothstep(1., .82, vUv.x) * smoothstep(0., .08, vUv.y) * smoothstep(1., .45, vUv.y); // (thickest low down, gone at the top)
        float d = distance(vW, camPos), near = smoothstep(2.5, 9., d), away = 1. - smoothstep(far * .55, far, d);
        away *= 1. - smoothstep(reach * .6, reach, length(vW.xz - camPos.xz)); // (fading out before the grid's edge: banks arriving or leaving never pop)
        gl_FragColor = vec4(color, clamp(n * edge * near * away * amount, 0., .85));
      }`,
    transparent: true, depthWrite: false, fog: false,
  });
  const geo = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
  for (let i = 0; i < (2 * R + 1) ** 2 * 2; i++) {
    const g = geo.clone(); g.setAttribute('seed', new THREE.Float32BufferAttribute(new Array(4).fill((i * 1.618) % 10), 1));
    const m = new THREE.Mesh(g, mat); m.frustumCulled = false; m.renderOrder = 5; m.visible = false; scene.add(m); sheets.push(m);
  }
  const hash = (x, z, k) => { const v = Math.sin(x * 12.9898 + z * 78.233 + k * 37.719) * 43758.5453; return v - Math.floor(v); };
  return {
    // amount: 0..1 (0 hides it); floor(x, z): the ground height there (world.floor)
    update(t, camera, amount, floor) {
      const on = amount > 0.01;
      for (const m of sheets) m.visible = on;
      if (!on) return;
      mat.uniforms.amount.value = amount; mat.uniforms.time.value = t; mat.uniforms.camPos.value.copy(camera.position);
      mat.uniforms.color.value.copy(PS2.fogColor.value).lerp(new THREE.Color(1, 1, 1), 0.12);
      mat.uniforms.far.value = Math.max(30, PS2.fogFar.value * 1.4);
      // the grid: finer near the ground, wider from up high (so the fog reaches as far as you can see)
      const high = camera.position.y - (floor ? floor(camera.position.x, camera.position.z) : 0) > 15, CELL = high ? 26 : 11;
      mat.uniforms.reach.value = R * CELL * 0.92;
      const ci = Math.round(camera.position.x / CELL), cj = Math.round(camera.position.z / CELL); let k = 0;
      for (let i = -R; i <= R; i++) for (let j = -R; j <= R; j++) for (let l = 0; l < 2; l++) {
        const m = sheets[k++], gi = ci + i, gj = cj + j, sd = m.geometry.attributes.seed, cs = hash(gi, gj, l + 31) * 10;
        if (sd.array[0] !== cs) { sd.array.fill(cs); sd.needsUpdate = true; } // (its pattern belongs to its cell, not to the mesh: a bank looks the same wherever the camera is)
        const x = (gi + hash(gi, gj, l) - 0.5) * CELL, z = (gj + hash(gi, gj, l + 5) - 0.5) * CELL;
        const w = 14 + hash(gi, gj, l + 9) * 16, h = 2.5 + hash(gi, gj, l + 13) * 4;
        // (seen from high up, the banks float between the rooftops, low and mid-height, bigger: fog you fly through)
        const g0 = floor ? floor(x, z) : 0, above = camera.position.y - g0, lift = high ? (l ? 0.45 + hash(gi, gj, 21) * 0.4 : 0.12 + hash(gi, gj, 23) * 0.3) * above : -0.3, big = high ? 2.4 : 1;
        m.position.set(x + Math.sin(t * 0.05 + gi) * 1.5, g0 + lift, z + Math.cos(t * 0.04 + gj) * 1.5); // (the banks themselves drift a little too)
        m.scale.set(w * big, h * big, 1); m.rotation.set(0, Math.atan2(camera.position.x - x, camera.position.z - z), 0);
      }
    },
  };
}

// Clouds: big banks drifting across the sky (and across the moon: they draw after it), dark with moonlit edges,
// on a ring far out round the camera. How much: terrain.clouds (0..1). Driven by time alone.
export function createClouds(scene) {
  const tex = noiseTex(), N = 14, banks = [];
  const mat = new THREE.ShaderMaterial({
    uniforms: { map: { value: tex }, dark: { value: new THREE.Color() }, lit: { value: new THREE.Color() }, amount: { value: 0 }, time: { value: 0 } },
    vertexShader: /* glsl */`attribute float seed; varying vec2 vUv; varying float vSeed; void main(){ vUv = uv; vSeed = seed; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
    fragmentShader: /* glsl */`
      uniform sampler2D map; uniform vec3 dark, lit; uniform float amount, time; varying vec2 vUv; varying float vSeed;
      void main(){
        vec2 a = vUv * vec2(1.6, 0.9) + vec2(time * 0.006 + vSeed, vSeed * 0.7), b = vUv * vec2(0.9, 0.5) + vec2(time * 0.0035 + vSeed * 1.9, 0.3);
        float n = texture2D(map, a).a * 0.65 + texture2D(map, b).a * 0.55, body = smoothstep(0.35, 0.8, n);
        float edge = smoothstep(0., .25, vUv.x) * smoothstep(1., .75, vUv.x) * smoothstep(0., .3, vUv.y) * smoothstep(1., .7, vUv.y);
        vec3 c = mix(lit, dark, smoothstep(0.45, 0.95, n)); // (thin parts catch the light, thick parts go dark)
        gl_FragColor = vec4(c, body * edge * amount);
      }`,
    transparent: true, depthWrite: false, fog: false,
  });
  const geo = new THREE.PlaneGeometry(1, 1);
  for (let i = 0; i < N; i++) {
    const g = geo.clone(); g.setAttribute('seed', new THREE.Float32BufferAttribute(new Array(4).fill((i * 2.39) % 10), 1));
    const m = new THREE.Mesh(g, mat); m.frustumCulled = false; m.renderOrder = 6; m.visible = false; scene.add(m); banks.push(m);
  }
  return {
    update(t, camera, amount) {
      const on = amount > 0.01;
      for (const m of banks) m.visible = on;
      if (!on) return;
      mat.uniforms.amount.value = Math.min(1, amount); mat.uniforms.time.value = t;
      mat.uniforms.dark.value.copy(PS2.fogColor.value).multiplyScalar(0.45); mat.uniforms.lit.value.copy(PS2.fogColor.value).lerp(new THREE.Color(1, 0.97, 0.9), 0.55);
      banks.forEach((m, i) => {
        const a0 = (i / N) * Math.PI * 2 + t * 0.004 * (i % 2 ? 1 : 0.7), r = 190 + (i % 3) * 25; // (the whole sky turning slowly past)
        const x = camera.position.x + Math.sin(a0) * r, z = camera.position.z + Math.cos(a0) * r, y = camera.position.y * 0.3 + 70 + (i % 4) * 22;
        m.position.set(x, y, z); m.scale.set(170 + (i % 5) * 30, 55 + (i % 3) * 20, 1);
        m.lookAt(camera.position.x, y, camera.position.z);
      });
    },
  };
}
