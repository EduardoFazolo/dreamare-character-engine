// The Dunes: a seeded outdoor scenario in the style of an old, empty RPG field (PS1/PS2 era).
// Overcast grass dunes that dissolve into fog, a worn path to a lone house, telephone poles walking off
// into the haze, a radio tower's red light, dark still water with a pier, and sometimes someone standing far off.
// generate(params) -> { group, height(x, z), spawn, palette, homeYaw, update(t) }. Deterministic in params.seed.
//
// Biomes (./biomes.js): params.biome says what the region is made of; VILLAGE (the default) is the original
// scene and is rebuilt exactly: every original feature keeps its place in the one random sequence, gated by a
// switch, and everything added since draws from its own random stream. params.neighbors = [{ u: [x, z], biome }]
// fades the terrain, ground and plants toward the regions beyond each edge.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PS2 } from '../head.js';
import { oldMaterial, SCENE } from './material.js';
import { VILLAGE } from './biomes.js';
import { rng, hash2, vnoise, fbm, smooth, lerp, mixC, rgb, canvasTex, css, blotch, tileUV, _q, _e, _one, place, boxG, cylG, assemble } from './util.js';
import { addFeatures, addNeighbourGrass } from './features.js';
export { rng };

// ---------- palette: muted time-of-day keys (grey dawn, overcast noon, bruised dusk, night) ----------
const KEYS = [
  { top: [118, 124, 132], fog: [168, 168, 160], sun: [0.78, 0.76, 0.72], amb: [0.46, 0.47, 0.5], sunY: 0.2 },
  { top: [140, 148, 150], fog: [178, 182, 176], sun: [0.72, 0.72, 0.68], amb: [0.55, 0.56, 0.56], sunY: 0.8 },
  { top: [62, 58, 72], fog: [132, 112, 106], sun: [0.8, 0.6, 0.5], amb: [0.36, 0.33, 0.38], sunY: 0.15 },
  { top: [10, 12, 16], fog: [26, 30, 34], sun: [0.16, 0.2, 0.28], amb: [0.14, 0.16, 0.2], sunY: 0.6 },
];
export function palette(time, hue) {
  const f = Math.min(0.9999, Math.max(0, time)) * 3, i = Math.floor(f), t = f - i, A = KEYS[i], B = KEYS[i + 1];
  const rot = (c) => { // hue rotation of an rgb 0..255 colour (the "sickly" dial)
    if (!hue) return c;
    const a = (hue * Math.PI) / 180, co = Math.cos(a), si = Math.sin(a), k = 1 / 3, q = Math.sqrt(k), m = [co + (1 - co) * k, k * (1 - co) - q * si, k * (1 - co) + q * si];
    return [c[0] * m[0] + c[1] * m[1] + c[2] * m[2], c[0] * m[2] + c[1] * m[0] + c[2] * m[1], c[0] * m[1] + c[1] * m[2] + c[2] * m[0]];
  };
  return {
    top: rot(mixC(A.top, B.top, t)), fog: rot(mixC(A.fog, B.fog, t)), sun: mixC(A.sun, B.sun, t), amb: mixC(A.amb, B.amb, t),
    sunY: lerp(A.sunY, B.sunY, t), night: smooth(0.72, 0.95, time), dusk: smooth(0.45, 0.66, time) * (1 - smooth(0.8, 0.95, time)),
  };
}

// ---------- terrain: grassy dunes, a low rise where you stand, a shore sinking into still water ----------
export const seaAngle = (p) => (p.seed * 2.39996) % (Math.PI * 2);
export const SEA_Y = -1.6;
// terrainFn(seed, biome, seaAngle): one biome's ground. The original dunes-and-shore when biome.water and no hills.
export function terrainFn(seed, B, sa) {
  const s = seed, H = B.duneHeight, wind = hash2(1, 2, s) * Math.PI, sx = Math.cos(sa), sz = Math.sin(sa);
  const cw = Math.cos(wind), sw = Math.sin(wind), ridge = (n) => 1 - Math.abs(n * 2 - 1);
  const hills = B.hills ? (x, z) => B.hills * smooth(0.25, 0.85, fbm(x * 0.007, z * 0.007, s + 50)) * lerp(0.2, 1, smooth(10, 60, Math.hypot(x, z))) : null;
  return (x, z) => {
    const u = x * cw + z * sw, v = -x * sw + z * cw; // dunes run across the wind
    const h = ridge(vnoise(u * 0.025, v * 0.011, s)) * 0.8 + fbm(x * 0.018, z * 0.018, s + 3) * 0.6;
    const d = Math.hypot(x, z), toSea = x * sx + z * sz;
    const mound = 1.2 * (1 - smooth(3, 22, d));
    let y;
    if (B.water) {
      const dunes = H * h * lerp(0.15, 1, smooth(6, 50, d)) * (1 - smooth(10, 45, toSea));
      y = dunes + mound + vnoise(x * 0.3, z * 0.3, s + 9) * 0.12 - smooth(15, 45, toSea) * 3 - Math.max(0, toSea - 40) * 0.06;
    } else y = H * h * lerp(0.15, 1, smooth(6, 50, d)) + mound + vnoise(x * 0.3, z * 0.3, s + 9) * 0.12;
    return hills ? y + hills(x, z) * (B.water ? 1 - smooth(10, 45, toSea) : 1) : y;
  };
}
// how much each neighbour owns a point: 0 inside the region, rising toward (and past) the shared edge
export const edgeWeight = (x, z, u) => smooth(45, 135, x * u[0] + z * u[1]);

// ---------- directives: composition rules a scene imposes on the generator ----------
// Resolved by the editor to world points (x, z):
//   converge  { at, count, from?, surface: 'stone' | 'trodden' }: roads that start out at the edge of the land
//             (count of them, spread around it) and all wander in toward `at`, as if every road led there;
//             stone: laid cobbles with kerbs (default), trodden: just a worn line in the grass
//   clearing  { at, radius }: the ground flattens there and nothing grows or stands in it
//   sightline { from, to }: nothing stands between the two (you can always see the thing)
//   causeways { at, count, heights: [min, max] }: stone walkways from every direction and height, stepping
//             down in flights of stairs to `at` (built in generate)
// Returns the extra paths; clearings and sightlines are marked as taken ground in `placed`.
function applyDirectives(D, placed, seed) {
  const paths = [];
  let stone = false;
  D.forEach((d, n) => {
    if (d.kind === 'converge' && d.at) {
      if ((d.surface ?? 'stone') === 'stone') stone = true;
      const r = rng(seed * 31 + 7 + n * 101), count = Math.max(1, Math.min(12, d.count ?? 4)), a0 = r() * Math.PI * 2, R = d.from ?? 115;
      for (let k = 0; k < count; k++) {
        const a = a0 + (k / count) * Math.PI * 2 + (r() - 0.5) * (Math.PI / count), sx = Math.cos(a) * R, sz = Math.sin(a) * R;
        const dx = d.at[0] - sx, dz = d.at[1] - sz, L = Math.hypot(dx, dz), m = Math.ceil(L / 2), px = -dz / L, pz = dx / L, wob = 3 + r() * 7, ph = r() * 6, bends = 1 + r() * 1.5;
        const pts = [];
        for (let i = 0; i <= m; i++) { const t = i / m, side = Math.sin(t * Math.PI * bends + ph) * wob * Math.sin(t * Math.PI); if (L * (1 - t) < 2.5) break; pts.push([sx + dx * t + px * side, sz + dz * t + pz * side]); }
        if (pts.length > 1) paths.push(pts);
      }
    }
    if (d.kind === 'clearing' && d.at) placed.push([d.at[0], d.at[1], d.radius ?? 5]);
    if (d.kind === 'sightline' && d.from && d.to) {
      const L = Math.hypot(d.to[0] - d.from[0], d.to[1] - d.from[1]);
      for (let s = 0; s <= L; s += 3) { const t = s / L; placed.push([d.from[0] + (d.to[0] - d.from[0]) * t, d.from[1] + (d.to[1] - d.from[1]) * t, 2.5]); }
    }
  });
  return { paths, stone };
}

// ---------- the scenario ----------
export function generate(p) {
  const B = p.biome || { ...VILLAGE, duneHeight: p.duneHeight }, NB = (p.neighbors || []).filter((n) => n?.biome);
  const r = rng(p.seed), rOrig = r, pal = palette(p.time, p.skyHue), group = new THREE.Group(), W = p.wrongness;
  const sa = p.seaAngle ?? seaAngle(p), sx = Math.cos(sa), sz = Math.sin(sa);
  const anyWater = B.water || NB.some((n) => n.biome.water);
  const toSea = B.water ? (x, z) => x * sx + z * sz : () => -1e9; // no sea: nothing is ever "toward the water"
  // terrain: this region's ground, faded into each neighbour's (whose sea, if any, lies beyond that edge)
  const localH = terrainFn(p.seed, B, sa);
  const nbH = NB.map((n) => terrainFn(p.seed, n.biome, Math.atan2(n.u[1], n.u[0])));
  const weights = (x, z) => { const w = NB.map((n) => edgeWeight(x, z, n.u)); const t = 1 + w.reduce((a, b) => a + b, 0); return [1 / t, ...w.map((v) => v / t)]; };
  const heightRaw = NB.length ? (x, z) => { const w = weights(x, z); let y = w[0] * localH(x, z); for (let i = 0; i < NB.length; i++) y += w[i + 1] * nbH[i](x, z); return y; } : localH;
  // directives (composition rules from the scene, resolved to world points by the editor): see applyDirectives.
  // Without any, nothing below changes (the village stays exact).
  const D = p.directives || [];
  const clearings = D.filter((d) => d.kind === 'clearing' && d.at);
  const height = !clearings.length ? heightRaw : (() => { // the ground settles flat around each clearing's centre
    const levels = clearings.map((d) => heightRaw(d.at[0], d.at[1]));
    return (x, z) => { let y = heightRaw(x, z); clearings.forEach((d, i) => { const k = 1 - smooth(d.radius * 0.8, d.radius * 1.8, Math.hypot(x - d.at[0], z - d.at[1])); y += (levels[i] - y) * k; }); return y; };
  })();

  // light: low sun from the sea side, a pale overhead moon at night
  const sunA = sa + 0.9;
  SCENE.lightDir.value.set(Math.cos(sunA), Math.max(0.25, pal.sunY), Math.sin(sunA)).normalize();
  SCENE.lightCol.value.setRGB(...pal.sun);
  SCENE.ambient.value.setRGB(...pal.amb);
  PS2.fogColor.value.copy(rgb(pal.fog));
  PS2.fogNear.value = lerp(40, 2, p.haze);
  PS2.fogFar.value = lerp(200, 42, p.haze);

  const tr = rng(p.seed + 77);
  const lit = (tex, color) => oldMaterial({ map: tex, color });
  const T = {
    grass: canvasTex(64, 64, (g, w, h) => {
      blotch(g, w, h, [200, 200, 190], 70, 50, tr, 5);
      for (let i = 0; i < 260; i++) { g.fillStyle = css([150, 150, 140], 0.5); g.fillRect(tr() * w | 0, tr() * h | 0, 1, 2 + (tr() * 3 | 0)); } // blade flecks
    }),
    wood: canvasTex(32, 64, (g, w, h) => { blotch(g, w, h, [112, 104, 94], 40, 24, tr, 3); for (let x = 0; x < w; x += 4 + (tr() * 4 | 0)) { g.fillStyle = 'rgba(30,26,22,.35)'; g.fillRect(x, 0, 1, h); } }),
    wall: canvasTex(64, 64, (g, w, h) => {
      blotch(g, w, h, [168, 162, 148], 50, 18, tr, 4);
      for (let y = 0; y < h; y += 8) { g.fillStyle = 'rgba(40,36,30,.25)'; g.fillRect(0, y, w, 1); } // siding
      g.fillStyle = 'rgba(40,40,30,.35)'; g.fillRect(0, h - 10, w, 10); // damp base
      for (let i = 0; i < 6; i++) { g.fillStyle = 'rgba(60,54,44,.2)'; g.fillRect(tr() * w | 0, 0, 2, tr() * h); } // streaks
    }),
    roof: canvasTex(32, 32, (g, w, h) => { blotch(g, w, h, [74, 70, 72], 30, 20, tr, 3); for (let y = 0; y < h; y += 4) { g.fillStyle = 'rgba(0,0,0,.3)'; g.fillRect(0, y, w, 1); } }),
    metal: canvasTex(32, 32, (g, w, h) => { blotch(g, w, h, [120, 118, 112], 40, 30, tr, 3); g.fillStyle = 'rgba(110,60,30,.25)'; for (let i = 0; i < 8; i++) g.fillRect(tr() * w | 0, tr() * h | 0, 4, 6); }),
    dark: canvasTex(8, 8, (g, w, h) => blotch(g, w, h, [22, 22, 24], 8, 6, tr, 2)),
    bark: canvasTex(16, 32, (g, w, h) => { blotch(g, w, h, [70, 64, 58], 30, 30, tr, 2); for (let x = 0; x < w; x += 3) { g.fillStyle = 'rgba(0,0,0,.3)'; g.fillRect(x, 0, 1, h); } }),
    window: canvasTex(16, 16, (g, w, h) => { g.fillStyle = '#e8c890'; g.fillRect(0, 0, w, h); g.fillStyle = '#5a4a38'; g.fillRect(7, 0, 2, h); g.fillRect(0, 7, w, 2); g.fillStyle = 'rgba(120,80,40,.3)'; g.fillRect(0, 9, w, 7); }),
    paint: canvasTex(32, 32, (g, w, h) => { blotch(g, w, h, [70, 92, 80], 30, 16, tr, 3); for (let i = 0; i < 14; i++) { g.fillStyle = css([150, 140, 120], 0.6); g.fillRect(tr() * w | 0, tr() * h | 0, 1 + (tr() * 3 | 0), 1 + (tr() * 2 | 0)); } }), // chipped green
    booth: canvasTex(64, 16, (g, w, h) => { g.fillStyle = '#d8dcc8'; g.fillRect(0, 0, w, h); g.fillStyle = '#2a302a'; g.font = 'bold 10px monospace'; g.textAlign = 'center'; g.fillText('TELEPHONE', w / 2, 12); }),
    phone: canvasTex(16, 32, (g, w, h) => {
      blotch(g, w, h, [46, 46, 48], 10, 8, tr, 2); g.fillStyle = '#8a8a84';
      for (let y = 0; y < 4; y++) for (let x = 0; x < 3; x++) g.fillRect(3 + x * 4, 14 + y * 4, 2, 2); // keypad
      g.fillStyle = '#6a6a64'; g.fillRect(3, 4, 10, 2); g.fillStyle = '#101010'; g.fillRect(12, 8, 2, 4); // coin slot, empty hook
    }),
    sign: canvasTex(32, 32, (g, w, h) => { g.fillStyle = '#c8c4b8'; g.beginPath(); g.arc(16, 16, 15, 0, 7); g.fill(); g.fillStyle = '#6a3a34'; g.beginPath(); g.arc(16, 16, 12, 0, 7); g.fill(); g.fillStyle = '#d8d4c8'; g.font = 'bold 9px monospace'; g.textAlign = 'center'; g.fillText('BUS', 16, 19); }),
  };

  // ---- sky: overcast dome that meets the fog exactly at the horizon (nothing has an edge) ----
  {
    const sunU = ((Math.atan2(Math.sin(sunA), -Math.cos(sunA)) / (Math.PI * 2)) % 1 + 1) % 1;
    const sky = canvasTex(256, 128, (g, w, h) => {
      const s = Math.floor(tr() * 1000);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const el = 1 - y / h, up = smooth(0.5, 0.95, el); // 0 at the horizon (y = h/2) .. 1 overhead
        let c = mixC(pal.fog, pal.top, up);
        const cloud = fbm((x / w) * 12, y / 10, s) * smooth(0.5, 0.62, el); // low, streaky overcast
        c = mixC(c, mixC(pal.fog, [255, 255, 255], 0.15), (cloud - 0.35) * 0.9 * (1 - pal.night * 0.8));
        const du = Math.min(Math.abs(x / w - sunU), 1 - Math.abs(x / w - sunU)); // a smothered glow where the sun hides
        c = mixC(c, mixC(pal.fog, [255, 236, 210], 0.5), Math.exp(-(du * du) / 0.004 - ((el - 0.56) ** 2) / 0.004) * (0.6 - pal.night * 0.5));
        g.fillStyle = css(c); g.fillRect(x, y, 1, 1);
      }
    });
    const dome = new THREE.Mesh(new THREE.SphereGeometry(300, 24, 16), new THREE.MeshBasicMaterial({ map: sky, side: THREE.BackSide, fog: false, depthWrite: false }));
    dome.name = 'sky'; group.add(dome);
    if (pal.night > 0.1) {
      const sr = rng(p.seed + 5), pts = [];
      for (let i = 0; i < 120; i++) { const a = sr() * Math.PI * 2, e = 0.35 + sr() * 1.1; pts.push(Math.cos(a) * Math.cos(e) * 280, Math.sin(e) * 280, Math.sin(a) * Math.cos(e) * 280); }
      const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      group.add(new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xc8ccd0, size: 1, sizeAttenuation: false, transparent: true, opacity: pal.night * 0.5, fog: false })));
    }
  }

  // ---- layout first (terrain colours need to know where the path and the shadows are) ----
  const placed = [], shadows = [], solids = []; // solids: [x, z, r] circles you can't walk through
  const homeA = sa + Math.PI + (r() - 0.5) * 1.4, homeD = 55 + r() * 25;
  const home = [Math.cos(homeA) * homeD, Math.sin(homeA) * homeD];
  const path = [];
  {
    const n = Math.ceil(homeD / 2), px = -Math.sin(homeA), pz = Math.cos(homeA), wob = 4 + r() * 6, ph = r() * 6;
    for (let i = 0; i <= n; i++) {
      const t = i / n, side = Math.sin(t * Math.PI * 1.6 + ph) * wob * Math.sin(t * Math.PI); // meanders, meets both ends
      path.push([home[0] * t + px * side, home[1] * t + pz * side]);
    }
  }
  const segDist = (pts) => (x, z) => {
    let best = 1e9;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1], dx = bx - ax, dz = bz - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
      best = Math.min(best, Math.hypot(x - ax - dx * t, z - az - dz * t));
    }
    return best;
  };
  const basePathDist = !B.path ? () => 1e9 : segDist(path);
  const extra = applyDirectives(D, placed, p.seed);
  const extraDist = extra.paths.map(segDist);
  const pathDist = !extraDist.length ? basePathDist : (x, z) => { let d = basePathDist(x, z); for (const f of extraDist) d = Math.min(d, f(x, z)); return d; };
  const near = (x, z, gap) => placed.some(([px, pz, pr]) => Math.hypot(px - x, pz - z) < pr + gap);
  const spot = (minR, maxR, gap, offPath = 3) => {
    for (let k = 0; k < 80; k++) {
      const a = r() * Math.PI * 2, d = minR + r() * (maxR - minR), x = Math.cos(a) * d, z = Math.sin(a) * d;
      if (toSea(x, z) < 12 && pathDist(x, z) > offPath && !near(x, z, gap)) return [x, z];
    }
    return null;
  };
  const put = (obj, x, z, radius, { face = [0, 0], shadow = radius, sink = 0.05, tilt = 1, solid = 0 } = {}, r = rOrig) => {
    obj.position.set(x, height(x, z) - sink, z);
    obj.rotation.y = Math.atan2(face[0] - x, face[1] - z) + (r() - 0.5) * 0.3;
    obj.rotation.x += (r() - 0.5) * 0.4 * W * tilt; obj.rotation.z += (r() - 0.5) * 0.4 * W * tilt;
    if (r() < W * 0.25) obj.position.y += 0.3 + r() * 2.5 * W; // floating, just slightly
    placed.push([x, z, radius]); if (shadow) shadows.push([x, z, shadow]); if (solid) solids.push([x, z, solid]); group.add(obj);
    return obj;
  };

  // ---- props ----
  const M = { wood: lit(T.wood), wall: lit(T.wall), roof: lit(T.roof), metal: lit(T.metal), dark: lit(T.dark), bark: lit(T.bark) };
  const lampOn = Math.max(pal.dusk, pal.night, W > 0.6 ? 1 : 0);
  const glowK = lerp(0.35, 1.25, lampOn);
  const winMat = oldMaterial({ map: T.window, glow: true, color: [glowK, glowK * 0.95, glowK * 0.85] });

  // the house at the end of the path: siding, pitched roof, one warm window, a dark door
  const makeHouse = (r) => {
    const w = 6 + r() * 2, d = 5 + r() * 1.5, h = 3.2, roofH = 1.8 + r() * 0.8;
    const roof = new THREE.CylinderGeometry(1, 1, d + 0.6, 3, 1); roof.rotateX(-Math.PI / 2); // triangular prism, apex up
    roof.scale((w + 0.6) / Math.sqrt(3), roofH / 1.5, 1); roof.translate(0, h + roofH / 3 - 0.02, 0);
    const walls = tileUV(boxG(w, h, d, 0, h / 2), 2, 1);
    const house = assemble([
      [M.wall, [walls]], [M.roof, [roof]],
      [M.dark, [boxG(1, 2, 0.08, -w * 0.2, 1, d / 2 + 0.02), boxG(0.5, 0.5, 0.5, w * 0.3, h + roofH * 0.6, -d * 0.2)]],
      [winMat, [boxG(1.1, 0.9, 0.06, w * 0.22, 1.8, d / 2 + 0.03)]],
      [M.wood, [boxG(1.6, 0.15, 1.2, -w * 0.2, 0.08, d / 2 + 0.6)]],
    ]);
    house.name = 'house';
    return house;
  };
  if (B.house) put(makeHouse(r), home[0], home[1], 7, { shadow: 6, sink: 0.4, tilt: 0.3, solid: 3.6 });

  // telephone poles: a line crossing everything and walking off into the fog both ways
  if (B.poles) {
    const a = homeA + Math.PI / 2 + (r() - 0.5) * 0.6, off = 10 + r() * 15, dir = [Math.cos(a), Math.sin(a)], nrm = [-dir[1], dir[0]];
    const tops = [], poles = [], wires = [];
    for (let i = -9; i <= 9; i++) {
      const x = nrm[0] * off + dir[0] * i * 18, z = nrm[1] * off + dir[1] * i * 18, y = height(x, z);
      if (y < SEA_Y + 0.4) { tops.push(null); continue; } // the line stops at the water
      const lean = (r() - 0.5) * 0.08 * (1 + 3 * W), ry = -a;
      const geo = [cylG(0.1, 0.13, 8, 6).translate(0, 4, 0), boxG(2, 0.12, 0.12, 0, 7.4), boxG(1.3, 0.1, 0.1, 0, 6.8)];
      const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y - 0.3, z), _q.setFromEuler(_e.set(0, ry, lean, 'YXZ')), _one);
      for (const q of geo) poles.push(q.applyMatrix4(m));
      tops.push([-0.9, 0, 0.9].map((dx) => new THREE.Vector3(dx, 7.45, 0).applyMatrix4(m)));
      placed.push([x, z, 1]); shadows.push([x, z, 1.2]); solids.push([x, z, 0.3]);
    }
    for (let i = 0; i + 1 < tops.length; i++) for (let k = 0; k < 3 && tops[i] && tops[i + 1]; k++) {
      const A = tops[i][k], B = tops[i + 1][k], SEG = 6; let prev = A;
      for (let j = 1; j <= SEG; j++) {
        const t = j / SEG, P = A.clone().lerp(B, t); P.y -= Math.sin(Math.PI * t) * 1.5;
        const o = new THREE.Object3D(); o.position.copy(prev).lerp(P, 0.5); o.lookAt(P); o.updateMatrix();
        wires.push(new THREE.BoxGeometry(0.04, 0.04, prev.distanceTo(P)).applyMatrix4(o.matrix)); prev = P;
      }
    }
    const m = new THREE.Mesh(mergeGeometries([...poles, ...wires].map((q) => q.toNonIndexed())), M.wood); m.name = 'poles'; group.add(m);
  }

  // a radio tower far out in the fog; its red light blinks and cuts through the haze
  let beacon = null;
  if (B.tower) {
    const a = r() * Math.PI * 2, d = 110 + r() * 40, x = Math.cos(a) * d, z = Math.sin(a) * d, H = 38 + r() * 14, parts = [];
    for (const [ox, oz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) parts.push(place(cylG(0.15, 0.15, H, 4), ox * 1.2, H / 2, oz * 1.2, 0, oz * 0.02, -ox * 0.02));
    for (let y = 3; y < H; y += 4) for (const [w, dd] of [[2.6, 0.1], [0.1, 2.6]]) parts.push(boxG(w, 0.1, dd, 0, y, 0), boxG(w, 0.1, dd, 0, y, 0, 0, 0.6, 0));
    const tower = assemble([[M.metal, parts]]); tower.position.set(x, height(x, z) - 0.5, z); group.add(tower);
    beacon = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 1.2), new THREE.MeshBasicMaterial({ color: 0xff2a1a, fog: false }));
    beacon.position.set(x, tower.position.y + H + 0.6, z); beacon.name = 'beacon'; group.add(beacon);
  }

  // a bus stop beside the path, halfway; nobody is waiting
  if (B.busStop) {
    const [bx, bz] = path[Math.floor(path.length * (0.35 + r() * 0.25))], [nx, nz] = path[Math.floor(path.length * 0.5) + 1];
    const px = -(nz - bz), pz = nx - bx, pl = Math.hypot(px, pz) || 1, x = bx + (px / pl) * 3.2, z = bz + (pz / pl) * 3.2;
    const stop = assemble([
      [M.metal, [boxG(0.08, 2.4, 0.08, -1.4, 1.2, -0.5), boxG(0.08, 2.4, 0.08, 1.4, 1.2, -0.5), boxG(0.08, 2.4, 0.08, -1.4, 1.2, 0.6), boxG(0.08, 2.4, 0.08, 1.4, 1.2, 0.6), boxG(3.2, 0.08, 1.5, 0, 2.42, 0.05), cylG(0.04, 0.04, 2.6, 4).translate(2.2, 1.3, 0.7)]],
      [M.dark, [boxG(2.8, 1.6, 0.04, 0, 1.3, -0.52)]],
      [M.wood, [boxG(2.4, 0.06, 0.4, 0, 0.5, -0.25), boxG(0.06, 0.5, 0.3, -1, 0.25, -0.25), boxG(0.06, 0.5, 0.3, 1, 0.25, -0.25)]],
      [oldMaterial({ map: T.sign, alphaTest: 0.5, side: THREE.DoubleSide }), [new THREE.PlaneGeometry(0.7, 0.7).translate(2.2, 2.7, 0.72)]],
    ]);
    stop.name = 'busstop';
    put(stop, x, z, 2.5, { face: [bx, bz], shadow: 2 });
  }

  // an old phone booth off the path: small panes, a dim sign, a failing bulb, and the receiver
  // off the hook, hanging by its coiled cord inside, barely swaying
  let booth = null;
  if (B.booth) {
    const [bx, bz] = path[Math.floor(path.length * (0.15 + r() * 0.15))], side = r() < 0.5 ? -1 : 1;
    const [nx, nz] = path[Math.floor(path.length * 0.3) + 1], px = -(nz - bz), pz = nx - bx, pl = Math.hypot(px, pz) || 1;
    const x = bx + side * (px / pl) * (4 + r() * 3), z = bz + side * (pz / pl) * (4 + r() * 3);
    const w = 1, h = 2.3, frame = [], panels = [];
    for (const [cx, cz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) frame.push(boxG(0.09, h, 0.09, cx * w / 2, h / 2, cz * w / 2));
    frame.push(boxG(w + 0.14, 0.12, w + 0.14, 0, 0.06, 0), boxG(w + 0.16, 0.14, w + 0.16, 0, h + 0.07, 0), boxG(w * 0.6, 0.1, w * 0.6, 0, h + 0.19, 0));
    // four sides: a solid kick panel, then a grid of empty panes (the back wall is solid for the phone)
    for (let k = 0; k < 4; k++) {
      const ry = (k * Math.PI) / 2, o = w / 2, rot = (gx, gy, gz, bw, bh, bd) => place(new THREE.BoxGeometry(bw, bh, bd), gx * Math.cos(ry) + gz * Math.sin(ry), gy, -gx * Math.sin(ry) + gz * Math.cos(ry), ry);
      if (k === 2) { panels.push(rot(0, 1.1, o, w, 2.0, 0.03)); continue; } // back (−z after rotation)
      if (k === 0) continue; // the front is the door, built below
      panels.push(rot(0, 0.36, o, w, 0.52, 0.03));
      for (const gy of [0.62, 1.1, 1.6, 2.08]) frame.push(rot(0, gy, o, w, 0.05, 0.05));
      for (const gx of [-w / 6, w / 6]) frame.push(rot(gx, 1.5, o, 0.04, 1.2, 0.04));
    }
    const signs = [0, 1, 2, 3].map((k) => place(new THREE.PlaneGeometry(w * 0.8, 0.16), Math.sin((k * Math.PI) / 2) * (w / 2 + 0.085), h - 0.05, Math.cos((k * Math.PI) / 2) * (w / 2 + 0.085), (k * Math.PI) / 2));
    const signK = lerp(0.45, 1.1, lampOn), signMat = oldMaterial({ map: T.booth, glow: true, color: [signK, signK, signK * 0.9] });
    const bulbMat = oldMaterial({ glow: true, color: [1, 0.92, 0.7] });
    // the inside is lit by the bulb (faked: an unlit, stained cream lining that dims when the bulb stutters),
    // so the hanging cord and receiver read as a dark silhouette, and the booth glows at night
    const inK = lerp(0.55, 0.95, lampOn);
    const inside = oldMaterial({ map: canvasTex(16, 32, (g, w, h) => { blotch(g, w, h, [210, 200, 170], 50, 14, tr, 3); g.fillStyle = 'rgba(80,60,30,.3)'; g.fillRect(0, 0, w, 6); }), glow: true, color: [inK, inK * 0.96, inK * 0.85] });
    const paintMat = lit(T.paint);
    booth = assemble([
      [paintMat, [...frame, ...panels]],
      [signMat, signs],
      [lit(T.phone), [boxG(0.26, 0.4, 0.12, 0.12, 1.45, -w / 2 + 0.09)]],
      [bulbMat, [boxG(0.14, 0.06, 0.14, 0, h - 0.04, 0)]],
      [inside, [boxG(w - 0.04, 1.9, 0.02, 0, 1.12, -w / 2 + 0.03), boxG(w - 0.04, 0.02, w - 0.04, 0, h - 0.01, 0), boxG(w - 0.04, 0.02, w - 0.04, 0, 0.13, 0)]],
    ]);
    booth.name = 'phonebooth';
    // the receiver: pivots under the phone; coiled cord (a helix of short segments) down to the handset
    const hang = new THREE.Group(), cord = [], turns = 16, len = 0.42, rad = 0.022;
    let prev = new THREE.Vector3(rad, 0, 0);
    for (let i = 1; i <= turns * 6; i++) {
      const t = i / (turns * 6), a = t * turns * Math.PI * 2, P = new THREE.Vector3(Math.cos(a) * rad, -t * len, Math.sin(a) * rad);
      const o = new THREE.Object3D(); o.position.copy(prev).lerp(P, 0.5); o.lookAt(P); o.updateMatrix();
      cord.push(new THREE.BoxGeometry(0.008, 0.008, prev.distanceTo(P) + 0.004).applyMatrix4(o.matrix)); prev = P;
    }
    // handset hangs by the cord's end, tipped: earpiece down, the mouthpiece turned toward you
    const handset = [boxG(0.06, 0.24, 0.05, 0, -0.12, 0), boxG(0.09, 0.07, 0.08, 0, -0.02, 0.015), boxG(0.09, 0.07, 0.08, 0, -0.23, 0.015)]
      .map((q) => place(q, 0, -len, 0, 0.3, 0.25, 0.15));
    hang.add(assemble([[M.dark, [...cord, ...handset]]]));
    hang.position.set(0.1, 1.24, -w / 2 + 0.16);
    const receiver = new THREE.Object3D(); receiver.name = 'receiver'; receiver.position.set(0, -len - 0.12, 0); hang.add(receiver); // where the sound comes from
    booth.add(hang);
    // the door: same panes as the walls, hinged on the left front post, left standing open outward
    const dw = w - 0.06, dparts = [boxG(dw, 0.52, 0.03, dw / 2, 0.36, 0), boxG(0.06, 2.0, 0.05, 0.03, 1.1, 0), boxG(0.06, 2.0, 0.05, dw - 0.03, 1.1, 0), boxG(dw, 0.06, 0.05, dw / 2, 2.1, 0)];
    for (const gy of [0.62, 1.1, 1.6]) dparts.push(boxG(dw, 0.05, 0.05, dw / 2, gy, 0));
    for (const gx of [dw / 2 - w / 6, dw / 2 + w / 6]) dparts.push(boxG(0.04, 1.45, 0.04, gx, 1.36, 0));
    const door = assemble([[paintMat, dparts], [M.metal, [boxG(0.03, 0.22, 0.05, dw - 0.1, 1.05, 0.05)]]]);
    door.position.set(-w / 2 + 0.03, 0, w / 2);
    const doorOpen = -(1.25 + r() * 0.6); // 70-105 degrees, swung outward
    door.rotation.y = doorOpen; door.name = 'boothDoor';
    booth.add(door);
    booth.userData = { hang, bulbMat, inside, inK, door, doorOpen };
    put(booth, x, z, 1.5, { face: [0, 0], shadow: 1.1, tilt: 0.6 });
    // B.booth is a chance, rolled on its own stream. The booth was laid out either way (same random numbers
    // used, its spot stays reserved), so a missing booth moves nothing else in the scene.
    if (rng(p.seed * 53 + 11)() >= B.booth) {
      group.remove(booth); shadows.pop(); booth = null;
    }
  }

  // lamp posts along the path (on at dusk and night)
  for (let i = 0, n = B.lamps ? Math.round(1 + 2 * p.density) : 0; i < n; i++) {
    const [lx, lz] = path[Math.floor(path.length * (0.2 + 0.7 * (i + r() * 0.5) / n))], x = lx + 1.8, z = lz + 1.2;
    const lamp = assemble([[M.metal, [cylG(0.07, 0.1, 5, 5).translate(0, 2.5, 0), boxG(0.9, 0.08, 0.08, 0.4, 4.95)]], [winMat, [boxG(0.36, 0.14, 0.26, 0.8, 4.86)]]]);
    lamp.name = 'lamp'; put(lamp, x, z, 1, { face: [lx, lz], shadow: 0.8, solid: 0.25 });
  }

  // dead trees: bare, forked, never more than a few
  for (let i = 0, n = B.deadTrees ? Math.round(1 + 3 * p.density * r()) : 0; i < n; i++) {
    const s = spot(12, 70, 6); if (!s) continue;
    const parts = [], tr2 = rng(p.seed * 31 + i);
    const branch = (base, dir, len, rad, depth) => {
      const g = cylG(rad * 0.6, rad, len, 5).translate(0, len / 2, 0);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      parts.push(g.applyQuaternion(q).translate(base.x, base.y, base.z));
      if (depth === 0) return;
      const tip = base.clone().addScaledVector(dir, len);
      for (let k = 0, nk = 2 + (tr2() * 2 | 0); k < nk; k++) {
        const nd = dir.clone().add(new THREE.Vector3((tr2() - 0.5) * 1.6, 0.2 + tr2() * 0.5, (tr2() - 0.5) * 1.6)).normalize();
        branch(tip, nd, len * (0.5 + tr2() * 0.25), rad * 0.55, depth - 1);
      }
    };
    branch(new THREE.Vector3(0, -0.3, 0), new THREE.Vector3((tr2() - 0.5) * 0.2, 1, (tr2() - 0.5) * 0.2).normalize(), 3 + tr2() * 3, 0.28, 3);
    const tree = assemble([[M.bark, parts]]); tree.name = 'tree'; put(tree, ...s, 3, { shadow: 2.5, tilt: 0.5, solid: 0.45 });
  }

  // an old fence along part of the path, posts missing
  if (B.fence) {
    const parts = [], i0 = Math.floor(path.length * 0.1), i1 = Math.floor(path.length * (0.5 + r() * 0.3));
    let prevTop = null;
    for (let i = i0; i < i1; i++) {
      const [ax, az] = path[i], [bx, bz] = path[i + 1], dx = bx - ax, dz = bz - az, l = Math.hypot(dx, dz) || 1;
      const x = ax - (dz / l) * 1.6, z = az + (dx / l) * 1.6;
      if (r() < 0.2 + W * 0.3) { prevTop = null; continue; }
      const y = height(x, z), lean = (r() - 0.5) * 0.25;
      parts.push(boxG(0.12, 1.3, 0.12, x, y + 0.5, z, 0, lean, lean * 0.5));
      const top = new THREE.Vector3(x, y + 1.0, z);
      if (prevTop) { const o = new THREE.Object3D(); o.position.copy(prevTop).lerp(top, 0.5); o.lookAt(top); o.updateMatrix(); parts.push(new THREE.BoxGeometry(0.06, 0.1, prevTop.distanceTo(top)).applyMatrix4(o.matrix)); }
      prevTop = top; shadows.push([x, z, 0.5]);
    }
    if (parts.length) { const m = new THREE.Mesh(mergeGeometries(parts.map((q) => q.toNonIndexed())), M.wood); m.name = 'fence'; group.add(m); }
  }

  // the pier: grey planks from the shore out into the water, ending in the fog
  let pier = null;
  if (B.pier && B.water) {
    const off = (r() - 0.5) * 30, px = -sz, pz = sx, parts = [], ry = Math.atan2(sx, sz);
    let t0 = 10; while (t0 < 60 && height(sx * t0 + px * off, sz * t0 + pz * off) > SEA_Y + 0.9) t0 += 1;
    pier = { off, px, pz, a: t0 - 6, b: t0 + 40 };
    for (let t = t0 - 6; t < t0 + 40; t += 0.34) {
      if (r() < 0.05 * (1 + 4 * W)) continue;
      const x = sx * t + px * off, z = sz * t + pz * off, y = Math.max(height(x, z), SEA_Y + 0.4) + 0.4;
      parts.push(boxG(1.6, 0.07, 0.28, x, y, z, ry + (r() - 0.5) * 0.06));
      if (Math.round(t / 0.34) % 7 === 0) for (const sd of [-0.75, 0.75]) {
        const qx = x + Math.cos(ry) * sd, qz = z - Math.sin(ry) * sd, bottom = Math.min(height(qx, qz), SEA_Y) - 0.8;
        parts.push(boxG(0.14, y - bottom, 0.14, qx, (y + bottom) / 2, qz, ry));
      }
    }
    if (parts.length) { const m = new THREE.Mesh(mergeGeometries(parts.map((q) => q.toNonIndexed())), M.wood); m.name = 'pier'; group.add(m); }
  }

  // someone, far off at the edge of the fog, facing you. Wrongness makes it likelier (and closer).
  let figure = null;
  if (B.figure && r() < 0.15 + 0.85 * W) {
    const s = spot(lerp(40, 18, W), lerp(60, 30, W), 3, 1.5);
    if (s) {
      const body = cylG(0.22, 0.17, 1.35, 6).translate(0, 0.9, 0), head = new THREE.SphereGeometry(0.14, 6, 4).translate(0, 1.72, 0);
      const legs = [boxG(0.12, 0.35, 0.12, -0.09, 0.17, 0), boxG(0.12, 0.35, 0.12, 0.09, 0.17, 0)];
      const arms = [boxG(0.09, 0.8, 0.09, -0.28, 1.05, 0, 0, 0, 0.05), boxG(0.09, 0.8, 0.09, 0.28, 1.05, 0, 0, 0, -0.05)];
      figure = assemble([[M.dark, [body, head, ...legs, ...arms]]]); figure.name = 'figure';
      put(figure, ...s, 1, { shadow: 0.7, tilt: 0, solid: 0.35 });
      figure.position.y = height(...s) - 0.02; figure.rotation.set(0, Math.atan2(-s[0], -s[1]), 0);
    }
  }

  // ---- causeways: stone walkways converging on a point from every direction and height (Gunz's stairways).
  // Each starts broken off in the air far out, at its own height, runs level, then steps down in flights of
  // stairs, level again, down again... until it lands at the target. Parapets on both sides, square piers
  // down into the ground every few metres. Pale block stone; the fog swallows the far ends. ----
  const causeways = D.filter((d) => d.kind === 'causeways' && d.at);
  if (causeways.length) {
    const cr = rng(p.seed * 41 + 17);
    const stoneTex = canvasTex(64, 64, (g, w, h) => {
      blotch(g, w, h, [196, 194, 186], 40, 22, cr, 4);
      g.fillStyle = 'rgba(60,58,54,.55)';
      for (let y = 0; y < h; y += 16) { g.fillRect(0, y, w, 1); for (let x = ((y / 16) % 2) * 16; x < w; x += 32) g.fillRect(x, y, 1, 16); } // blocks
      for (let i = 0; i < 18; i++) { g.fillStyle = `rgba(${70 + cr() * 30 | 0},${90 + cr() * 30 | 0},60,.3)`; g.fillRect(cr() * w | 0, cr() * h | 0, 3 + cr() * 8 | 0, 1 + cr() * 3 | 0); } // moss, stains
    });
    const stone = oldMaterial({ map: stoneTex }), parts = [];
    const box = (len, hgt, wid, cx, cy, cz, yaw) => { const g = tileUV(boxG(wid, hgt, len, 0, 0, 0), Math.max(1, wid / 2), Math.max(1, len / 2)); g.rotateY(yaw); g.translate(cx, cy, cz); parts.push(g); };
    for (const d of causeways) {
      const count = Math.max(1, Math.min(14, d.count ?? 6)), a0 = cr() * Math.PI * 2, [hMin, hMax] = d.heights || [5, 32];
      for (let k = 0; k < count; k++) {
        let a = a0 + (k / count) * Math.PI * 2 + (cr() - 0.5) * (Math.PI / count);
        // (not from the spawn's side: the thing stays in view from where you arrive)
        const toSpawn = Math.atan2(-d.at[1], -d.at[0]); let da = Math.atan2(Math.sin(a - toSpawn), Math.cos(a - toSpawn));
        if (Math.abs(da) < 0.5) a = toSpawn + Math.sign(da || 1) * 0.5;
        const R = 45 + cr() * 55, land = d.land ?? 8; // they land in a ring round it, not on top of it
        const S = [d.at[0] + Math.cos(a) * R, d.at[1] + Math.sin(a) * R], E = [d.at[0] + Math.cos(a) * land, d.at[1] + Math.sin(a) * land];
        // plan: one soft bend (a quadratic through a side-shifted middle)
        const side = (cr() - 0.5) * R * 0.5, px = -Math.sin(a), pz = Math.cos(a), M = [(S[0] + E[0]) / 2 + px * side, (S[1] + E[1]) / 2 + pz * side];
        const at = (t) => [(1 - t) * (1 - t) * S[0] + 2 * (1 - t) * t * M[0] + t * t * E[0], (1 - t) * (1 - t) * S[1] + 2 * (1 - t) * t * M[1] + t * t * E[1]];
        const N = 400, pts = [...Array(N + 1).keys()].map((i) => at(i / N)), cum = [0];
        for (let i = 1; i <= N; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
        const L = cum[N], hE = height(...E) + 0.25;
        let h0 = height(...S) + hMin + cr() * (hMax - hMin);
        const RISE = 0.62; // stairs: rise per metre run
        if ((h0 - hE) / RISE > L * 0.7) h0 = hE + L * 0.7 * RISE;
        // the profile: flights spread along the way, level stretches between
        const nf = 2 + Math.floor(cr() * 3), drop = h0 - hE, runs = [];
        let rest = L - drop / RISE; const gaps = [...Array(nf + 1)].map(() => 0.3 + cr()), gs = gaps.reduce((x, y) => x + y, 0);
        let sAt = 0; const shares = [...Array(nf)].map(() => 0.5 + cr()), ss = shares.reduce((x, y) => x + y, 0);
        for (let f = 0; f < nf; f++) { sAt += (gaps[f] / gs) * rest; const len = (shares[f] / ss) * drop / RISE; runs.push([sAt, sAt + len, (shares[f] / ss) * drop]); sAt += len; }
        const hAt = (sd) => { let hh = h0; for (const [s0, s1, dd] of runs) { if (sd >= s1) hh -= dd; else if (sd > s0) { hh -= dd * (sd - s0) / (s1 - s0); break; } else break; } return hh; };
        const inFlight = (sd) => runs.some(([s0, s1]) => sd > s0 && sd < s1);
        const posAt = (sd) => { let i = 1; while (i < N && cum[i] < sd) i++; const t = (sd - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1); return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t, Math.atan2(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])]; };
        const W2 = 2.2 + cr() * 0.8, broken = 2 + cr() * 5;
        // deck: level pieces 1.5 m, stair steps 0.3 m (each step a block from its tread down to the slab's underside)
        for (let sd = 0; sd < L; ) {
          const flight = inFlight(sd + 0.01), step = flight ? 0.32 : 1.5, mid = sd + step / 2, [x, z, yaw] = posAt(mid);
          if (sd < broken && cr() < 0.6 * (1 - sd / broken)) { sd += step; continue; } // the far end, crumbled off in the air
          const top = flight ? hAt(sd + step) : hAt(mid), thick = flight ? 0.7 : 0.55;
          box(step + 0.02, thick, W2, x, top - thick / 2, z, yaw);
          for (const sgn of [-1, 1]) { // parapets
            const ox = Math.cos(yaw) * sgn * (W2 / 2 - 0.12), oz = -Math.sin(yaw) * sgn * (W2 / 2 - 0.12);
            if (cr() < 0.93) box(step + 0.02, 0.6, 0.24, x + ox, top + 0.3, z + oz, yaw);
          }
          sd += step;
        }
        // piers: every ~8 m, from below the ground up to the deck's underside (none where it's nearly on the ground)
        for (let sd = broken + 3 + cr() * 3; sd < L - 4; sd += 7 + cr() * 3) {
          const [x, z, yaw] = posAt(sd), top = hAt(sd) - 0.6, gy = height(x, z);
          if (top - gy < 1.5) continue;
          box(1.3, top - gy + 1, 1.3, x, (top + gy - 1) / 2, z, yaw);
          placed.push([x, z, 1.4]); shadows.push([x, z, 1.4]);
        }
      }
    }
    const cw = new THREE.Mesh(mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g))), stone); cw.name = 'causeways'; group.add(cw);
  }

  // ---- stone roads (converge, surface 'stone', the default): a cobbled ribbon laid on the ground along each
  // converging path, kerb stones down both edges; stones missing here and there, the road crumbling out at
  // the edge of the land and whole where it arrives ----
  if (extra.paths.length && extra.stone) {
    const sr = rng(p.seed * 13 + 3);
    const cobble = canvasTex(64, 64, (g, w, h) => {
      g.fillStyle = '#141210'; g.fillRect(0, 0, w, h); // grout
      for (let row = 0; row < 8; row++) for (let col = -1; col < 8; col++) {
        const x = col * 8 + (row % 2) * 4 + (sr() - 0.5) * 2, y = row * 8 + (sr() - 0.5) * 2, v = 62 + sr() * 58; // (dark, wet-looking setts: they must read against any ground)
        g.fillStyle = css([v * 1.08, v, v * 0.88]); g.beginPath(); g.ellipse(x + 4, y + 4, 3.4 + sr() * 0.6, 3.2 + sr() * 0.6, sr(), 0, 7); g.fill();
        g.fillStyle = 'rgba(255,240,220,.22)'; g.fillRect(x + 2, y + 2, 3, 1); // worn, catching the light
        if (sr() < 0.12) { g.fillStyle = 'rgba(70,90,50,.45)'; g.fillRect(x + 1, y + 6, 6, 2); } // moss in the joints
      }
    });
    const kerbTex = canvasTex(16, 16, (g, w, h) => blotch(g, w, h, [150, 146, 138], 50, 30, sr, 3));
    const roadMat = oldMaterial({ map: cobble }), kerbMat = oldMaterial({ map: kerbTex });
    const RW = 2.4, COLS = 4, pos = [], uv = [], idx = [], kerbs = [];
    for (const pts of extra.paths) {
      const n = pts.length, base = pos.length / 3; let dist = 0;
      for (let i = 0; i < n; i++) {
        const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)], tl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, nx = -(b[1] - a[1]) / tl, nz = (b[0] - a[0]) / tl;
        if (i) dist += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
        for (let c = 0; c <= COLS; c++) {
          const o = (c / COLS - 0.5) * RW, x = pts[i][0] + nx * o, z = pts[i][1] + nz * o;
          pos.push(x, height(x, z) + 0.06, z); uv.push((c / COLS) * (RW / 2.4), dist / 2.4);
        }
        // kerb stones every ~1.1 m, both sides, now and then one gone or knocked askew
        if (i % 1 === 0 && sr() < 0.85) for (const side of [-1, 1]) {
          if (sr() < 0.12) continue;
          const o = side * (RW / 2 + 0.12), x = pts[i][0] + nx * o, z = pts[i][1] + nz * o, g = boxG(0.28, 0.22, 0.95, 0, 0, 0);
          g.rotateY(Math.atan2(b[0] - a[0], b[1] - a[1]) + (sr() - 0.5) * 0.3 * (1 + W)); g.rotateZ((sr() - 0.5) * 0.25); g.translate(x, height(x, z) + 0.06, z); kerbs.push(g);
        }
      }
      for (let i = 0; i + 1 < n; i++) for (let c = 0; c < COLS; c++) {
        const t = i / (n - 1); // crumbling toward the outer end (t = 0), whole near the arrival
        if (sr() < 0.5 * (1 - smooth(0, 0.35, t)) + 0.03) continue;
        const a = base + i * (COLS + 1) + c, b2 = a + COLS + 1;
        idx.push(a, a + 1, b2, a + 1, b2 + 1, b2); // (wound to face up)
      }
    }
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); geo.setIndex(idx); geo.computeVertexNormals();
    const road = new THREE.Mesh(geo, roadMat); road.name = 'roads'; group.add(road);
    if (kerbs.length) { const k = new THREE.Mesh(mergeGeometries(kerbs.map((g) => g.index ? g.toNonIndexed() : g)), kerbMat); k.name = 'kerbs'; group.add(k); }
  }

  // ---- added features: each has its own random stream, so the original sequence above never shifts ----
  const shadows2 = []; // shadows of added things (applied after the original ones)
  const extras = addFeatures({ p, B, NB, weights, height, pathDist, path, home, near, placed, solids, shadows2, group, put, makeHouse, M, T, lit, tr: rng(p.seed + 991), anyWater, toSea });

  // ---- terrain: vertex-coloured grass / dirt / wet sand, dark hollows, blob shadows, the worn path ----
  {
    const S = 280, N = 140, geo = new THREE.PlaneGeometry(S, S, N, N); geo.rotateX(-Math.PI / 2);
    const pa = geo.attributes.position, col = new Float32Array(pa.count * 3);
    const pals = [B, ...NB.map((n) => n.biome)].map((b) => ({ grassA: rgb(mixC(b.grassA, pal.fog, 0.1)), grassB: rgb(b.grassB), dirt: rgb(b.dirt), sand: rgb(b.sand), wet: rgb(b.wet) }));
    const c = new THREE.Color(), q = new THREE.Color(), cb = new THREE.Color();
    const shade = (C, x, z, y, slope) => {
      const { grassA, grassB, dirt, sand, wet } = C;
      c.copy(grassA).lerp(grassB, fbm(x * 0.03, z * 0.03, p.seed + 40));
      c.lerp(sand, smooth(0.35, 0.8, slope)); // bare sand where the dunes are steep
      c.lerp(q.copy(sand), smooth(SEA_Y + 2.5, SEA_Y + 1, y)).lerp(wet, smooth(SEA_Y + 0.8, SEA_Y, y)); // beach -> wet edge
      if (extras.fieldAt) { const f = extras.fieldAt(x, z); if (f) c.lerp(q.copy(dirt).lerp(grassB, f.row), f.k * 0.8); } // ploughed rows
      c.lerp(dirt, (1 - smooth(0.6, 2.2, pathDist(x, z))) * 0.85); // the path
      if (extraDist.length) { // converging paths: trodden paler than any biome's dirt, so they show even where dirt ~ grass
        let d = 1e9; for (const f of extraDist) d = Math.min(d, f(x, z));
        c.lerp(q.copy(dirt).lerp(sand, 0.6).multiplyScalar(1.4), (1 - smooth(0.9, 3.2, d)) * 0.9);
      }
    };
    for (let i = 0; i < pa.count; i++) {
      const x = pa.getX(i), z = pa.getZ(i), y = height(x, z); pa.setY(i, y);
      const slope = Math.hypot(height(x + 1, z) - y, height(x, z + 1) - y);
      if (!NB.length) shade(pals[0], x, z, y, slope);
      else { // each biome's colour at this point, weighted by who owns it
        const w = weights(x, z); cb.setRGB(0, 0, 0);
        for (let j = 0; j < pals.length; j++) { if (w[j] < 1e-4) continue; shade(pals[j], x, z, y, slope); cb.r += c.r * w[j]; cb.g += c.g * w[j]; cb.b += c.b * w[j]; }
        c.copy(cb);
      }
      const avg = (height(x + 6, z) + height(x - 6, z) + height(x, z + 6) + height(x, z - 6)) / 4;
      let k = 1 + Math.max(-0.3, Math.min(0.12, (y - avg) * 0.12)); // hollows sit in shadow
      for (const [px, pz, pr] of shadows) { const d = Math.hypot(x - px, z - pz); if (d < pr * 1.6) k *= lerp(0.55, 1, smooth(pr * 0.5, pr * 1.6, d)); }
      if (shadows2.length) k *= extras.shadeAt(x, z);
      k *= 0.94 + hash2(x, z, p.seed) * 0.12; // PS1 vertex colour noise
      col[i * 3] = Math.min(1, c.r * k * 1.6); col[i * 3 + 1] = Math.min(1, c.g * k * 1.6); col[i * 3 + 2] = Math.min(1, c.b * k * 1.6); // glTF COLOR_0 stays in 0..1
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.computeVertexNormals();
    tileUV(geo, 80, 80); // the PS2 shader samples raw uvs, so tiling lives in the geometry
    const ground = new THREE.Mesh(geo, oldMaterial({ map: T.grass, vertexColors: true })); ground.name = 'terrain';
    group.add(ground);
  }

  // ---- still, dark water ----
  if (anyWater) {
    const base = mixC(pal.fog, [40, 52, 56], 0.55);
    const seaTex = canvasTex(64, 64, (g, w, h) => {
      blotch(g, w, h, base, 14, 6, tr, 4);
      for (let i = 0; i < 24; i++) { g.fillStyle = css(mixC(base, [255, 255, 255], 0.2), 0.5); g.fillRect(tr() * w | 0, tr() * h | 0, 4 + (tr() * 8 | 0), 1); }
    });
    const geo = new THREE.PlaneGeometry(900, 900, 10, 10); geo.rotateX(-Math.PI / 2); tileUV(geo, 110, 110);
    const sea = new THREE.Mesh(geo, oldMaterial({ map: seaTex })); sea.position.y = SEA_Y; sea.name = 'sea'; group.add(sea);
  }

  // ---- shore grass: tall, pale tufts; denser on the dune slopes ----
  {
    // a few separate 1-pixel blades (hard alpha, no antialiasing), so tufts read as grass, not slabs
    const grassTex = canvasTex(32, 32, (g, w, h) => {
      for (let i = 0; i < 9; i++) {
        const x0 = 2 + tr() * 28, hh = 8 + tr() * 22, lean = (tr() - 0.5) * 10; g.fillStyle = css(mixC(B.tuftA, B.tuftB, tr()));
        for (let y = 0; y < hh; y++) g.fillRect(Math.round(x0 + lean * (y / hh) ** 2), h - 1 - y, 1, 1);
      }
    });
    const parts = [], m = new THREE.Matrix4(), n = Math.round(420 * p.density * B.tufts);
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2, d = 3 + Math.sqrt(r()) * 90, x = Math.cos(a) * d, z = Math.sin(a) * d, y = height(x, z);
      if (y < SEA_Y + 1.2 || pathDist(x, z) < 1.5 || near(x, z, 0.5)) continue;
      if (NB.length && hash2(x, z, p.seed + 3) > weights(x, z)[0]) continue; // this biome's grass thins toward its edges
      const sc = 0.7 + r() * 0.8;
      for (const turn of [0, Math.PI / 2]) {
        const qd = new THREE.PlaneGeometry(1.1, 1.1).translate(0, 0.52, 0);
        m.compose(new THREE.Vector3(x, y - 0.08, z), _q.setFromEuler(_e.set(0, a + turn, 0)), new THREE.Vector3(sc, sc, sc));
        parts.push(qd.applyMatrix4(m));
      }
    }
    if (parts.length) { const g = new THREE.Mesh(mergeGeometries(parts), oldMaterial({ map: grassTex, alphaTest: 0.5, side: THREE.DoubleSide })); g.name = 'grass'; group.add(g); }
  }
  addNeighbourGrass({ p, NB, weights, height, pathDist, near, group, seed: p.seed });

  // camera starts facing up the path toward the house, a little off-axis
  const homeYaw = Math.atan2(-home[0], -home[1]) + 0.25;
  // walking: the ground you stand on (the pier deck over water), and where you may go
  const onPier = (x, z) => { if (!pier) return false; const t = toSea(x, z), l = x * pier.px + z * pier.pz - pier.off; return Math.abs(l) < 0.72 && t > pier.a && t < pier.b; };
  const floor = (x, z) => (onPier(x, z) ? Math.max(height(x, z), SEA_Y + 0.4) + 0.44 : height(x, z));
  const walkable = (x, z) => Math.hypot(x, z) < 125 && (onPier(x, z) || !anyWater || height(x, z) > SEA_Y + 0.35);
  let figureGone = false;
  const update = (t, eye) => {
    if (beacon) beacon.visible = (t % 2.4) < 0.5;
    // the figure is only ever at a distance: come within 9 m and it's simply not there any more
    if (figure && eye && !figureGone && Math.hypot(eye.x - figure.position.x, eye.z - figure.position.z) < 9) {
      figureGone = true; figure.visible = false;
      const i = solids.findIndex((c) => c[0] === figure.position.x && c[2] === 0.35); if (i >= 0) solids.splice(i, 1);
    }
    if (booth) {
      const { hang, bulbMat, inside, inK, door, doorOpen } = booth.userData;
      door.rotation.y = doorOpen + Math.sin(t * 0.45) * 0.035 + Math.sin(t * 1.3 + 2) * 0.01; // creaks in the wind
      hang.rotation.z = Math.sin(t * 0.9) * 0.05 + Math.sin(t * 0.37) * 0.03; // still swinging a little, as if just let go
      hang.rotation.x = Math.sin(t * 0.6 + 1) * 0.04;
      // the bulb mostly holds, then stutters (a hash of time slices, so it's irregular but cheap)
      const slice = Math.floor(t * 12), stutter = hash2(slice, 3, p.seed) < 0.12 || (Math.floor(t / 4) % 3 === 0 && hash2(slice, 7, p.seed) < 0.5);
      bulbMat.uniforms.color.value.setRGB(...(stutter ? [0.15, 0.14, 0.12] : [1, 0.92, 0.7]));
      const k = stutter ? inK * 0.3 : inK; inside.uniforms.color.value.setRGB(k, k * 0.96, k * 0.85);
    }
  };
  return { group, height, floor, walkable, solids, spawn: new THREE.Vector3(0, height(0, 0) + 1.7, 0), palette: pal, homeYaw, update, biome: B, roads: extra.paths }; // (roads: the converging paths, for directives placing things along them)
}
