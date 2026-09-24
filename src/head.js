import * as THREE from 'three';

// ---------------- PS2-ish material: vertex snapping, gouraud, affine UVs, 15-bit dither, fog ----------------
export const PS2 = {
  snapRes: { value: new THREE.Vector2(160, 120) },
  affine: { value: 0.5 },
  fogColor: { value: new THREE.Color(0.35, 0.3, 0.45) },
  fogNear: { value: 4 }, fogFar: { value: 14 },
};

export function ps2Material({ map, color = [1, 1, 1], alphaTest = 0, side = THREE.FrontSide } = {}) {
  return new THREE.ShaderMaterial({
    side,
    uniforms: {
      ...PS2,
      map: { value: map || whiteTex() },
      color: { value: new THREE.Color(...color) },
      alphaTest: { value: alphaTest },
      hueShift: { value: 0 }, satMul: { value: 1 },
    },
    vertexShader: /* glsl */`
      #include <common>
      #include <skinning_pars_vertex>
      uniform vec2 snapRes; uniform float fogNear, fogFar;
      varying vec3 vUvw; varying vec2 vUvP; varying vec3 vLight; varying float vFog;
      void main(){
        #include <skinbase_vertex>
        #include <beginnormal_vertex>
        #include <skinnormal_vertex>
        #include <begin_vertex>
        #include <skinning_vertex>
        vec4 mv = modelViewMatrix * vec4(transformed, 1.);
        vec4 cp = projectionMatrix * mv;
        cp.xy = floor(cp.xy / cp.w * snapRes + .5) / snapRes * cp.w;
        gl_Position = cp;
        vec3 n = normalize(mat3(modelMatrix) * objectNormal);
        float key = max(dot(n, normalize(vec3(.6, .8, .7))), 0.);
        float rim = max(dot(n, normalize(vec3(-.8, .1, -.4))), 0.);
        vLight = vec3(.42, .38, .48) + vec3(1., .93, .8) * key * .85 + vec3(.3, .35, .6) * rim * .5;
        vUvw = vec3(uv * cp.w, cp.w); vUvP = uv;
        vFog = smoothstep(fogNear, fogFar, -mv.z);
      }`,
    fragmentShader: /* glsl */`
      uniform sampler2D map; uniform vec3 color, fogColor; uniform float affine, alphaTest, hueShift, satMul;
      varying vec3 vUvw; varying vec2 vUvP; varying vec3 vLight; varying float vFog;
      float bayer2(vec2 a){ a = floor(a); return fract(a.x / 2. + a.y * a.y * .75); }
      float bayer4(vec2 a){ return bayer2(.5 * a) * .25 + bayer2(a); }
      void main(){
        vec2 uv = mix(vUvP, vUvw.xy / vUvw.z, affine);
        vec4 t = texture2D(map, uv);
        if (t.a < alphaTest) discard;
        vec3 c = t.rgb;
        if (hueShift != 0. || satMul != 1.) {
          vec3 y = mat3(.299, .596, .211, .587, -.274, -.523, .114, -.322, .312) * c;
          float h = atan(y.z, y.y) + radians(hueShift), ch = length(y.yz) * satMul;
          c = mat3(1., 1., 1., .956, -.272, -1.106, .621, -.647, 1.703) * vec3(y.x, ch * cos(h), ch * sin(h));
        }
        c *= color * vLight;
        c = mix(c, fogColor, vFog);
        c = floor(clamp(c, 0., 1.) * 31. + bayer4(gl_FragCoord.xy)) / 31.;
        gl_FragColor = vec4(c, 1.);
      }`,
  });
}

let _white;
function whiteTex() {
  if (!_white) { _white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1); _white.needsUpdate = true; }
  return _white;
}

function canvasTex(w, h, draw, repeat) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.magFilter = t.minFilter = THREE.NearestFilter;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat, repeat); }
  return t;
}
const noiseFill = (base, spread) => (g, w, h) => {
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const n = (Math.random() - 0.5) * spread;
    g.fillStyle = `rgb(${base.map((b) => Math.max(0, Math.min(255, b + n * (0.6 + Math.random() * 0.8)))).join(',')})`;
    g.fillRect(x, y, 1, 1);
  }
};

// ---------------- head rig: face mask + back-of-head hull grown from the mask's boundary ----------------
const K = 7;

export class HeadRig {
  constructor(canon) {
    this.canon = canon;
    this.group = new THREE.Group();
    this.loop = boundaryLoop(canon.index);
    const L = this.loop.length;
    this.nVerts = 468 + L * K + 1;

    const idx = [...canon.index];
    const ring = (k, i) => (k === 0 ? this.loop[i % L] : 468 + (k - 1) * L + (i % L));
    const pole = 468 + L * K;
    for (let k = 0; k < K; k++) for (let i = 0; i < L; i++) {
      const a = ring(k, i), b = ring(k, i + 1), c = ring(k + 1, i), d = ring(k + 1, i + 1);
      if (k === K - 1) idx.push(a, b, pole); else idx.push(a, b, d, a, d, c);
    }
    this.hullStart = canon.index.length;
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.nVerts * 3), 3));
    this.geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(this.nVerts * 2), 2));
    this.geo.setIndex(idx);
    this.headMat = ps2Material();
    this.headMat.name = 'Head';
    this.head = new THREE.Mesh(this.geo, this.headMat);
    this.group.add(this.head);

    const hatMat = ps2Material({ map: canvasTex(16, 16, noiseFill([30, 26, 24], 25), 2) });
    hatMat.name = 'Hat';
    this.hats = {
      cowboy: hat(hatMat, 0.95, 0.4, 0.46, 0.42),
      bowler: hat(hatMat, 0.62, 0.43, 0.43, 0.38, true),
    };
    for (const h of Object.values(this.hats)) this.group.add(h);

    this.hairMat = ps2Material({ map: canvasTex(32, 64, drawHair), alphaTest: 0.5, side: THREE.DoubleSide });
    this.hairMat.name = 'Hair';
    this.hair = new THREE.Group();
    this.group.add(this.hair);
    this.flip = null;
  }

  update(P, tex, p) {
    const L = this.loop.length, uv0 = this.canon.uv;
    const pos = this.geo.attributes.position.array, uv = this.geo.attributes.uv.array;
    for (let i = 0; i < 468; i++) { pos.set(P[i], i * 3); uv.set(uv0[i], i * 2); }

    const C = [0, (P[10][1] + P[152][1]) / 2 + 0.05, (P[234][2] + P[454][2]) / 2 - 0.08];
    const depth = 0.62 * (1 + p.headDepth * 0.6);
    const cranium = 0.4 + p.cranium * 0.45;
    const skinUV = uv0[151];
    this.ringPts = [];
    for (let k = 1; k < K; k++) {
      const th = (k / K) * Math.PI / 2;
      for (let i = 0; i < L; i++) {
        const b = P[this.loop[i]];
        const rx = b[0] - C[0], ry = b[1] - C[1], rz = b[2] - C[2];
        const m = Math.hypot(rx, ry) || 1e-6, dx = rx / m, dy = ry / m;
        const radial = m * Math.pow(Math.cos(th), 0.6) * (1 + 0.28 * Math.sin(2 * th));
        const lift = cranium * Math.sin(th) * Math.pow(Math.max(0, dy), 2) * m;
        const q = [C[0] + dx * radial, C[1] + dy * radial + lift, C[2] + rz * Math.cos(th) - depth * Math.sin(th)];
        const o = 468 + (k - 1) * L + i;
        pos.set(q, o * 3);
        const m2 = Math.min(1, p.backUV * (0.4 + k / K));
        const j = (Math.sin(i * 12.9898 + k * 78.233) * 43758.5453) % 1 * 0.015;
        uv[o * 2] = uv0[this.loop[i]][0] * (1 - m2) + (skinUV[0] + j) * m2;
        uv[o * 2 + 1] = uv0[this.loop[i]][1] * (1 - m2) + (skinUV[1] - Math.abs(j)) * m2;
        this.ringPts.push({ k, q, dy, dx });
      }
    }
    pos.set([C[0], C[1] + cranium * 0.2, C[2] - depth], (468 + L * K) * 3);
    uv.set(skinUV, (468 + L * K) * 2);
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.uv.needsUpdate = true;
    this.geo.computeVertexNormals();
    this.geo.computeBoundingSphere();
    this.geo.computeBoundingBox();
    this.skinUV = skinUV;

    if (this.flip === null) {
      // make hull triangles face away from the head center
      const ix = this.geo.index.array, s = this.hullStart;
      const v = (n) => new THREE.Vector3().fromArray(pos, ix[s + n] * 3);
      const n = new THREE.Vector3().subVectors(v(1), v(0)).cross(new THREE.Vector3().subVectors(v(2), v(0)));
      const out = v(0).sub(new THREE.Vector3(...C));
      this.flip = n.dot(out) < 0;
      if (this.flip) {
        for (let t = s; t < ix.length; t += 3) { const tmp = ix[t + 1]; ix[t + 1] = ix[t + 2]; ix[t + 2] = tmp; }
        this.geo.index.needsUpdate = true;
        this.geo.computeVertexNormals();
      }
    }

    this.headMat.uniforms.map.value = tex;

    let top = -Infinity;
    for (let i = 0; i < this.nVerts; i++) top = Math.max(top, pos[i * 3 + 1]);
    for (const [name, h] of Object.entries(this.hats)) {
      h.visible = p.hat === name;
      h.position.set(0, top - 0.2, C[2] - 0.05);
      h.rotation.set(-0.12, 0, 0.06);
    }
    this.buildHair(p.hair === 'stringy', C);
  }

  buildHair(on, C) {
    this.hair.clear();
    if (!on) return;
    const cards = this.ringPts.filter((r) => r.k >= 1 && r.k <= 4 && r.dy > -0.35);
    for (let i = 0; i < cards.length; i += 2) {
      const r = cards[i];
      const len = 0.55 + (Math.sin(i * 3.7) * 0.5 + 0.5) * 0.45;
      const g = new THREE.PlaneGeometry(0.2, len, 1, 3);
      g.translate(0, -len / 2, 0);
      const m = new THREE.Mesh(g, this.hairMat);
      m.position.set(r.q[0] * 1.04, r.q[1] + 0.02, r.q[2] * 1.02 - 0.02);
      m.lookAt(m.position.x * 3, m.position.y, m.position.z + (m.position.z - C[2]) * 2);
      m.rotateX(-0.15);
      this.hair.add(m);
    }
  }
}

function hat(mat, brimR, crownR1, crownR2, crownH, round) {
  const g = new THREE.Group();
  const brim = new THREE.Mesh(new THREE.CylinderGeometry(brimR, brimR * 0.98, 0.04, 14), mat);
  const crown = round
    ? new THREE.Mesh(new THREE.SphereGeometry(crownR1, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), mat)
    : new THREE.Mesh(new THREE.CylinderGeometry(crownR1 * 0.85, crownR2, crownH, 10), mat);
  crown.position.y = round ? 0 : crownH / 2;
  if (round) crown.scale.y = 1.3;
  g.add(brim, crown);
  return g;
}

function drawHair(g, w, h) {
  g.clearRect(0, 0, w, h);
  for (let x = 0; x < w; x++) {
    if (Math.random() < 0.45) continue;
    const end = h * (0.6 + Math.random() * 0.4);
    const v = 25 + Math.random() * 45;
    g.fillStyle = `rgb(${v + 20},${v + 8},${v})`;
    g.fillRect(x, 0, 1, end);
  }
}

function boundaryLoop(index) {
  const count = new Map();
  const key = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);
  for (let t = 0; t < index.length; t += 3)
    for (const [a, b] of [[index[t], index[t + 1]], [index[t + 1], index[t + 2]], [index[t + 2], index[t]]])
      count.set(key(a, b), (count.get(key(a, b)) || 0) + 1);
  const adj = new Map();
  for (const [k, c] of count) {
    if (c !== 1) continue;
    const [a, b] = k.split(',').map(Number);
    (adj.get(a) || adj.set(a, []).get(a)).push(b);
    (adj.get(b) || adj.set(b, []).get(b)).push(a);
  }
  const start = adj.keys().next().value;
  const loop = [start];
  let prev = -1, cur = start;
  for (;;) {
    const nx = adj.get(cur).find((n) => n !== prev && !loop.includes(n));
    if (nx === undefined) break;
    prev = cur; cur = nx; loop.push(cur);
  }
  return loop;
}

// ---------------- environment ----------------
export function buildEnvironment(scene) {
  scene.background = canvasTex(4, 64, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0, '#2f9aa0'); gr.addColorStop(0.55, '#8a7fb0'); gr.addColorStop(1, '#c98a6a');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
  });
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(240, 240, 24, 24),
    ps2Material({ map: canvasTex(32, 32, noiseFill([200, 120, 80], 40), 200) }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = 0;
  scene.add(ground);
  const duneMat = ps2Material({ map: canvasTex(32, 32, noiseFill([190, 110, 90], 60), 6) });
  for (const [x, z, s] of [[-30, -70, 22], [35, -90, 30], [-80, -40, 18]]) {
    const dune = new THREE.Mesh(new THREE.SphereGeometry(s, 10, 6), duneMat);
    dune.scale.set(2, 0.45, 1); dune.position.set(x, -s * 0.12, z);
    scene.add(dune);
  }
}
