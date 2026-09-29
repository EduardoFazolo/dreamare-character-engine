// Props you can drop into a scene from the editor's context menu. Same low-poly PS2 look as the scenario
// generator (canvas textures, old-console material), built independently of it (the village generator's
// random sequence stays untouched). Each builder returns { group, seats: [Object3D], update?(t), radius }.
// Seats are anchors where a sitting character's hips go; they may move (a rocking chair carries its sitter).
// Props face +Z, like characters.
import * as THREE from 'three';
import { oldMaterial } from './material.js';
import { rng, canvasTex, blotch, css, boxG, cylG, place, assemble, hash2 } from './util.js';
import { buildModel, buildModelMerged } from '../items/model.js';
import oilLantern from '../../items/oil-lantern.json';

let T = null; // textures, made once
function tex() {
  if (T) return T;
  const r = rng(4242);
  T = {
    wood: canvasTex(32, 64, (g, w, h) => { blotch(g, w, h, [112, 92, 72], 40, 22, r, 3); for (let x = 0; x < w; x += 3 + (r() * 4 | 0)) { g.fillStyle = 'rgba(30,20,14,.35)'; g.fillRect(x, 0, 1, h); } }),
    pale: canvasTex(32, 32, (g, w, h) => { blotch(g, w, h, [176, 168, 150], 36, 18, r, 3); for (let y = 0; y < h; y += 5) { g.fillStyle = 'rgba(40,34,28,.2)'; g.fillRect(0, y, w, 1); } }),
    metal: canvasTex(32, 32, (g, w, h) => { blotch(g, w, h, [120, 118, 112], 40, 30, r, 3); g.fillStyle = 'rgba(110,60,30,.25)'; for (let i = 0; i < 8; i++) g.fillRect(r() * w | 0, r() * h | 0, 4, 6); }),
    dark: canvasTex(8, 8, (g, w, h) => blotch(g, w, h, [22, 22, 24], 8, 6, r, 2)),
    paint: canvasTex(32, 32, (g, w, h) => { blotch(g, w, h, [70, 92, 80], 30, 16, r, 3); for (let i = 0; i < 14; i++) { g.fillStyle = css([150, 140, 120], 0.6); g.fillRect(r() * w | 0, r() * h | 0, 1 + (r() * 3 | 0), 1 + (r() * 2 | 0)); } }),
    red: canvasTex(16, 16, (g, w, h) => blotch(g, w, h, [128, 44, 40], 30, 14, r, 2)),
    rock: canvasTex(32, 32, (g, w, h) => blotch(g, w, h, [132, 128, 120], 60, 40, r, 4)),
    bark: canvasTex(16, 32, (g, w, h) => { blotch(g, w, h, [70, 64, 58], 30, 30, r, 2); for (let x = 0; x < w; x += 3) { g.fillStyle = 'rgba(0,0,0,.3)'; g.fillRect(x, 0, 1, h); } }),
    stem: canvasTex(16, 32, (g, w, h) => blotch(g, w, h, [214, 206, 186], 26, 16, r, 2)),
    spots: canvasTex(64, 32, (g, w, h) => { blotch(g, w, h, [150, 50, 44], 30, 20, r, 4); for (let i = 0; i < 24; i++) { g.fillStyle = 'rgba(250,246,236,.95)'; g.beginPath(); g.ellipse(r() * w, r() * h * 0.9, 2 + r() * 3, 1.5 + r() * 2, 0, 0, 7); g.fill(); } }),
    booth: canvasTex(64, 16, (g, w, h) => { g.fillStyle = '#d8dcc8'; g.fillRect(0, 0, w, h); g.fillStyle = '#2a302a'; g.font = 'bold 10px monospace'; g.textAlign = 'center'; g.fillText('TELEPHONE', w / 2, 12); }),
    phone: canvasTex(16, 32, (g, w, h) => { blotch(g, w, h, [46, 46, 48], 10, 8, r, 2); g.fillStyle = '#8a8a84'; for (let y = 0; y < 4; y++) for (let x = 0; x < 3; x++) g.fillRect(3 + x * 4, 14 + y * 4, 2, 2); }),
    lining: canvasTex(16, 32, (g, w, h) => { blotch(g, w, h, [210, 200, 170], 50, 14, r, 3); g.fillStyle = 'rgba(80,60,30,.3)'; g.fillRect(0, 0, w, 6); }),
    light: canvasTex(4, 4, (g) => { g.fillStyle = '#fff0c0'; g.fillRect(0, 0, 4, 4); }),
    facade: canvasTex(32, 64, (g, w, h) => { blotch(g, w, h, [150, 142, 132], 34, 16, r, 3); for (let y = 0; y < h; y += 4) { g.fillStyle = 'rgba(30,26,24,.18)'; g.fillRect(0, y, w, 1); } for (let i = 0; i < 10; i++) { g.fillStyle = 'rgba(40,36,30,.25)'; g.fillRect(r() * w | 0, r() * h | 0, 1, 3 + (r() * 8 | 0)); } }), // (streaked plaster, courses)
    // a sash window: a painted frame, a cross of glazing bars, four panes of dark glass with a faint sheen
    window: canvasTex(32, 64, (g, w, h) => { g.fillStyle = '#6a6258'; g.fillRect(0, 0, w, h); for (const [x, y] of [[3, 3], [17, 3], [3, 33], [17, 33]]) { const gr = g.createLinearGradient(x, y, x + 12, y + 28); gr.addColorStop(0, '#2c3238'); gr.addColorStop(0.5, '#15181c'); gr.addColorStop(1, '#22272c'); g.fillStyle = gr; g.fillRect(x, y, 12, 28); } g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(0, h - 3, w, 3); }),
    windowLit: canvasTex(32, 64, (g, w, h) => { g.fillStyle = '#3a3026'; g.fillRect(0, 0, w, h); for (const [x, y] of [[3, 3], [17, 3], [3, 33], [17, 33]]) { const gr = g.createRadialGradient(x + 6, y + 18, 2, x + 6, y + 14, 18); gr.addColorStop(0, '#fff2c8'); gr.addColorStop(1, '#d89a52'); g.fillStyle = gr; g.fillRect(x, y, 12, 28); } }),
    cobble: canvasTex(32, 32, (g, w, h) => { g.fillStyle = '#3a3836'; g.fillRect(0, 0, w, h); for (let y = 0; y < h; y += 4) for (let x = (y / 4) % 2 ? 2 : 0; x < w; x += 4) { const v = 70 + r() * 40; g.fillStyle = `rgb(${v},${v - 3},${v - 6})`; g.fillRect(x, y, 3, 3); } }),
    roof: canvasTex(32, 32, (g, w, h) => { blotch(g, w, h, [62, 60, 64], 26, 18, r, 3); for (let y = 0; y < h; y += 4) { g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(0, y, w, 1); } }),
    slab: canvasTex(32, 32, (g, w, h) => { blotch(g, w, h, [120, 116, 110], 24, 14, r, 3); g.fillStyle = 'rgba(20,18,16,.4)'; for (let k = 0; k < w; k += 16) { g.fillRect(k, 0, 1, h); g.fillRect(0, k, w, 1); } }),
    leather: canvasTex(16, 16, (g, w, h) => blotch(g, w, h, [92, 62, 44], 22, 12, r, 2)),
    mud: canvasTex(16, 16, (g, w, h) => { blotch(g, w, h, [128, 124, 122], 40, 30, r, 3); for (let i = 0; i < 12; i++) { g.fillStyle = 'rgba(60,58,62,.7)'; g.fillRect(r() * w | 0, r() * h | 0, 2, 1); } }),
    bus: canvasTex(32, 32, (g) => { g.fillStyle = '#c8c4b8'; g.beginPath(); g.arc(16, 16, 15, 0, 7); g.fill(); g.fillStyle = '#6a3a34'; g.beginPath(); g.arc(16, 16, 12, 0, 7); g.fill(); g.fillStyle = '#d8d4c8'; g.font = 'bold 9px monospace'; g.textAlign = 'center'; g.fillText('BUS', 16, 19); }),
  };
  for (const [k, t] of Object.entries(T)) t.name = k; // (its kind: the photo look swaps by it)
  return T;
}
const lit = (k, color) => oldMaterial({ map: tex()[k], color });
const glow = (k, c = [1, 1, 1]) => oldMaterial({ map: tex()[k], glow: true, color: c });
// a small brass plate with a name scratched in (dark cut, bright edge), w wide, facing +Z; tall: the name on two
// big lines (a close shot at the scene's low resolution smears one small line)
function namePlate(name, w, tall = false) {
  const c = document.createElement('canvas'); c.width = 192; c.height = tall ? 96 : 40; const x = c.getContext('2d');
  x.fillStyle = tall ? '#a88446' : '#8a6a34'; x.fillRect(0, 0, 192, c.height); x.strokeStyle = 'rgba(40,24,8,.8)'; x.lineWidth = tall ? 4 : 1; x.strokeRect(2, 2, 188, c.height - 4);
  x.textAlign = 'center'; x.textBaseline = 'middle';
  const words = name.split(' '), rows = tall && words.length > 1 ? [words.slice(0, Math.ceil(words.length / 2)).join(' '), words.slice(Math.ceil(words.length / 2)).join(' ')] : [name];
  x.font = tall ? 'bold 38px Georgia, serif' : 'italic bold 22px Georgia, serif';
  rows.forEach((r, i) => { const y = tall ? (rows.length > 1 ? 28 + i * 42 : 48) : 21; x.fillStyle = tall ? 'rgba(20,10,2,1)' : 'rgba(30,18,6,.95)'; x.fillText(r, 96, y, 180); x.fillStyle = 'rgba(255,230,170,.35)'; x.fillText(r, 96, y - 1, 180); });
  const tex = new THREE.CanvasTexture(c); tex.magFilter = tex.minFilter = THREE.NearestFilter;
  return new THREE.Mesh(new THREE.PlaneGeometry(w, (w * c.height) / 192), oldMaterial({ map: tex, glow: true, color: [0.95, 0.9, 0.8] }));
}
const seat = (parent, x, y, z) => { const s = new THREE.Object3D(); s.position.set(x, y, z); s.name = 'seat'; parent.add(s); return s; };
// a segment (thin box) from a to b
function bar(a, b, t = 0.04) { const o = new THREE.Object3D(); o.position.copy(a).lerp(b, 0.5); o.lookAt(b); o.updateMatrix(); return new THREE.BoxGeometry(t, t, a.distanceTo(b)).applyMatrix4(o.matrix); }
const V = (x, y, z) => new THREE.Vector3(x, y, z);

// ---------------- the catalogue ----------------
const OUT_MAT = {}; // (shared: a gone-out lantern's dead glass and wick)
export const PROPS = {
  rockingChair: {
    label: 'Rocking chair', category: 'Furniture',
    build() {
      const rock = new THREE.Group(), wood = lit('wood'), parts = [];
      // curved runners: short segments along an arc (radius 1.1 m, lowest point at the pivot)
      for (const x of [-0.24, 0.24]) {
        let prev = null;
        for (let i = 0; i <= 8; i++) { const a = -0.42 + (i / 8) * 0.84, p = V(x, 1.1 - Math.cos(a) * 1.1 + 0.03, Math.sin(a) * 1.1); if (prev) parts.push(bar(prev, p, 0.05)); prev = p; }
      }
      parts.push(boxG(0.54, 0.05, 0.5, 0, 0.45, 0.02)); // seat
      for (const [x, z] of [[-0.24, 0.24], [0.24, 0.24], [-0.24, -0.2], [0.24, -0.2]]) parts.push(boxG(0.045, 0.43, 0.045, x, 0.23, z));
      for (const x of [-0.25, 0.25]) { parts.push(boxG(0.05, 0.9, 0.05, x, 0.9, -0.3, 0, -0.22)); parts.push(boxG(0.05, 0.05, 0.5, x, 0.68, 0.0)); parts.push(boxG(0.04, 0.22, 0.04, x, 0.57, 0.22)); } // back posts, armrests
      for (let k = 0; k < 5; k++) parts.push(boxG(0.03, 0.72, 0.02, -0.18 + k * 0.09, 0.95, -0.31, 0, -0.22)); // spindles
      parts.push(boxG(0.56, 0.06, 0.05, 0, 1.33, -0.4, 0, -0.22));
      rock.add(assemble([[wood, parts]]));
      const g = new THREE.Group(); g.add(rock);
      const s = seat(rock, 0, 0.5, 0.0);
      const ph = rand() * 6;
      return { group: g, seats: [s], radius: 0.6, update: (t) => { rock.rotation.x = Math.sin(t * 1.35 + ph) * 0.075; } }; // slow, soft: ~4.6 s a rock, ±4°
    },
  },
  chair: {
    label: 'Wooden chair', category: 'Furniture',
    build() {
      const p = [boxG(0.46, 0.05, 0.44, 0, 0.45, 0)];
      for (const [x, z] of [[-0.2, 0.19], [0.2, 0.19], [-0.2, -0.19], [0.2, -0.19]]) p.push(boxG(0.04, 0.45, 0.04, x, 0.225, z));
      p.push(boxG(0.04, 0.5, 0.04, -0.2, 0.72, -0.2), boxG(0.04, 0.5, 0.04, 0.2, 0.72, -0.2), boxG(0.44, 0.12, 0.03, 0, 0.9, -0.2), boxG(0.44, 0.05, 0.03, 0, 0.66, -0.2));
      const g = assemble([[lit('wood'), p]]);
      return { group: g, seats: [seat(g, 0, 0.5, 0.02)], radius: 0.4 };
    },
  },
  bench: {
    label: 'Park bench', category: 'Furniture',
    build() {
      const p = [];
      for (let k = 0; k < 3; k++) p.push(boxG(1.7, 0.035, 0.12, 0, 0.44, -0.14 + k * 0.14));
      for (let k = 0; k < 2; k++) p.push(boxG(1.7, 0.1, 0.03, 0, 0.62 + k * 0.16, -0.24, 0, -0.15));
      const m = [];
      for (const x of [-0.72, 0.72]) m.push(boxG(0.05, 0.44, 0.05, x, 0.22, 0.12), boxG(0.05, 0.44, 0.05, x, 0.22, -0.2), boxG(0.05, 0.5, 0.05, x, 0.7, -0.25, 0, -0.15), boxG(0.05, 0.05, 0.4, x, 0.6, -0.02));
      const g = assemble([[lit('wood'), p], [lit('metal'), m]]);
      return { group: g, seats: [-0.5, 0, 0.5].map((x) => seat(g, x, 0.49, -0.02)), radius: 0.9 };
    },
  },
  table: {
    label: 'Table', category: 'Furniture',
    build() {
      const p = [boxG(1.2, 0.05, 0.8, 0, 0.75, 0)];
      for (const [x, z] of [[-0.55, 0.35], [0.55, 0.35], [-0.55, -0.35], [0.55, -0.35]]) p.push(boxG(0.05, 0.75, 0.05, x, 0.375, z));
      return { group: assemble([[lit('wood'), p]]), seats: [], radius: 0.75 };
    },
  },
  phoneBooth: {
    label: 'Phone booth', category: 'Street',
    build() {
      const w = 1, h = 2.3, frame = [], panels = [];
      for (const [cx, cz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) frame.push(boxG(0.09, h, 0.09, cx * w / 2, h / 2, cz * w / 2));
      frame.push(boxG(w + 0.14, 0.12, w + 0.14, 0, 0.06, 0), boxG(w + 0.16, 0.14, w + 0.16, 0, h + 0.07, 0), boxG(w * 0.6, 0.1, w * 0.6, 0, h + 0.19, 0));
      for (let k = 1; k < 4; k++) {
        const ry = (k * Math.PI) / 2, o = w / 2, rot = (gx, gy, gz, bw, bh, bd) => place(new THREE.BoxGeometry(bw, bh, bd), gx * Math.cos(ry) + gz * Math.sin(ry), gy, -gx * Math.sin(ry) + gz * Math.cos(ry), ry);
        if (k === 2) { panels.push(rot(0, 1.1, o, w, 2.0, 0.03)); continue; }
        panels.push(rot(0, 0.36, o, w, 0.52, 0.03));
        for (const gy of [0.62, 1.1, 1.6, 2.08]) frame.push(rot(0, gy, o, w, 0.05, 0.05));
        for (const gx of [-w / 6, w / 6]) frame.push(rot(gx, 1.5, o, 0.04, 1.2, 0.04));
      }
      const signs = [0, 1, 2, 3].map((k) => place(new THREE.PlaneGeometry(w * 0.8, 0.16), Math.sin((k * Math.PI) / 2) * (w / 2 + 0.085), h - 0.05, Math.cos((k * Math.PI) / 2) * (w / 2 + 0.085), (k * Math.PI) / 2));
      const bulb = oldMaterial({ glow: true, color: [1, 0.92, 0.7] }), lining = oldMaterial({ map: tex().lining, glow: true, color: [0.8, 0.77, 0.68] }), paint = lit('paint');
      const g = assemble([
        [paint, [...frame, ...panels]], [glow('booth', [0.8, 0.8, 0.72]), signs], [lit('phone'), [boxG(0.26, 0.4, 0.12, 0.12, 1.45, -w / 2 + 0.09)]],
        [bulb, [boxG(0.14, 0.06, 0.14, 0, h - 0.04, 0)]],
        [lining, [boxG(w - 0.04, 1.9, 0.02, 0, 1.12, -w / 2 + 0.03), boxG(w - 0.04, 0.02, w - 0.04, 0, h - 0.01, 0), boxG(w - 0.04, 0.02, w - 0.04, 0, 0.13, 0)]],
      ]);
      // the receiver, off the hook, hanging on its coiled cord
      const hang = new THREE.Group(), cord = [], len = 0.42, rad = 0.022; let prev = V(rad, 0, 0);
      for (let i = 1; i <= 96; i++) { const t = i / 96, a = t * 16 * Math.PI * 2, P = V(Math.cos(a) * rad, -t * len, Math.sin(a) * rad); cord.push(bar(prev, P, 0.008)); prev = P; }
      const handset = [boxG(0.06, 0.24, 0.05, 0, -0.12, 0), boxG(0.09, 0.07, 0.08, 0, -0.02, 0.015), boxG(0.09, 0.07, 0.08, 0, -0.23, 0.015)].map((q) => place(q, 0, -len, 0, 0.3, 0.25, 0.15));
      hang.add(assemble([[lit('dark'), [...cord, ...handset]]])); hang.position.set(0.1, 1.24, -w / 2 + 0.16); g.add(hang);
      const dw = w - 0.06, dp = [boxG(dw, 0.52, 0.03, dw / 2, 0.36, 0), boxG(0.06, 2.0, 0.05, 0.03, 1.1, 0), boxG(0.06, 2.0, 0.05, dw - 0.03, 1.1, 0), boxG(dw, 0.06, 0.05, dw / 2, 2.1, 0)];
      for (const gy of [0.62, 1.1, 1.6]) dp.push(boxG(dw, 0.05, 0.05, dw / 2, gy, 0));
      const door = assemble([[paint, dp]]); door.position.set(-w / 2 + 0.03, 0, w / 2); g.add(door);
      const open = -1.5;
      return {
        group: g, seats: [], radius: 0.8,
        update: (t) => {
          door.rotation.y = open + Math.sin(t * 0.45) * 0.035; hang.rotation.z = Math.sin(t * 0.9) * 0.05 + Math.sin(t * 0.37) * 0.03; hang.rotation.x = Math.sin(t * 0.6 + 1) * 0.04;
          const stutter = hash2(Math.floor(t * 12), 3, 7) < 0.12; bulb.uniforms.color.value.setRGB(...(stutter ? [0.15, 0.14, 0.12] : [1, 0.92, 0.7])); lining.uniforms.color.value.setScalar(stutter ? 0.25 : 0.8);
        },
      };
    },
  },
  lamp: {
    label: 'Lamp post', category: 'Street',
    build() { return { group: assemble([[lit('metal'), [cylG(0.07, 0.1, 5, 5).translate(0, 2.5, 0), boxG(0.9, 0.08, 0.08, 0.4, 4.95)]], [glow('light', [1.2, 1.1, 0.9]), [boxG(0.36, 0.14, 0.26, 0.8, 4.86)]]]), seats: [], radius: 0.3 }; },
  },
  busStop: {
    label: 'Bus stop', category: 'Street',
    build() {
      const g = assemble([
        [lit('metal'), [boxG(0.08, 2.4, 0.08, -1.4, 1.2, -0.5), boxG(0.08, 2.4, 0.08, 1.4, 1.2, -0.5), boxG(0.08, 2.4, 0.08, -1.4, 1.2, 0.6), boxG(0.08, 2.4, 0.08, 1.4, 1.2, 0.6), boxG(3.2, 0.08, 1.5, 0, 2.42, 0.05), cylG(0.04, 0.04, 2.6, 4).translate(2.2, 1.3, 0.7)]],
        [lit('dark'), [boxG(2.8, 1.6, 0.04, 0, 1.3, -0.52)]],
        [lit('wood'), [boxG(2.4, 0.06, 0.4, 0, 0.5, -0.25), boxG(0.06, 0.5, 0.3, -1, 0.25, -0.25), boxG(0.06, 0.5, 0.3, 1, 0.25, -0.25)]],
        [oldMaterial({ map: tex().bus, alphaTest: 0.5, side: THREE.DoubleSide }), [new THREE.PlaneGeometry(0.7, 0.7).translate(2.2, 2.7, 0.72)]],
      ]);
      return { group: g, seats: [-0.7, 0, 0.7].map((x) => seat(g, x, 0.55, -0.26)), radius: 1.6 };
    },
  },
  mailbox: {
    label: 'Mailbox', category: 'Street',
    build() { return { group: assemble([[lit('wood'), [boxG(0.08, 1.1, 0.08, 0, 0.55, 0)]], [lit('metal'), [boxG(0.22, 0.24, 0.45, 0, 1.2, 0.05)]], [lit('red'), [boxG(0.03, 0.14, 0.03, 0.13, 1.28, 0.1)]]]), seats: [], radius: 0.3 }; },
  },
  deadTree: {
    label: 'Dead tree', category: 'Nature',
    build() {
      const r = rng(Math.floor(rand() * 1e6)), parts = [], up = V(0, 1, 0);
      const branch = (base, dir, len, rd, depth) => {
        parts.push(cylG(rd * 0.6, rd, len, 5).translate(0, len / 2, 0).applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, dir)).translate(base.x, base.y, base.z));
        if (!depth) return;
        const tip = base.clone().addScaledVector(dir, len);
        for (let k = 0, n = 2 + (r() * 2 | 0); k < n; k++) branch(tip, dir.clone().add(V((r() - 0.5) * 1.6, 0.2 + r() * 0.5, (r() - 0.5) * 1.6)).normalize(), len * (0.5 + r() * 0.25), rd * 0.55, depth - 1);
      };
      branch(V(0, -0.2, 0), V((r() - 0.5) * 0.2, 1, (r() - 0.5) * 0.2).normalize(), 2.5 + r() * 2, 0.24, 3);
      return { group: assemble([[lit('bark'), parts]]), seats: [], radius: 0.5 };
    },
  },
  // lanterns: the Items tab's Oil Lantern (items/oil-lantern.json), so editing the item changes these too
  lantern: {
    label: 'Lantern (on the ground)', category: 'Lights',
    build() { const g = new THREE.Group(), m = buildModelMerged(oilLantern.model).group; m.scale.setScalar(1.4); g.add(m); return { group: g, seats: [], radius: 0.25 }; },
  },
  lanternOut: {
    label: 'Lantern (gone out)', category: 'Lights',
    build() { const g = new THREE.Group(), m = buildModelMerged(oilLantern.model).group; m.scale.setScalar(1.4); m.traverse((o) => { if (o.material?.defines?.GLOW) o.material = OUT_MAT[o.name === 'glass' ? 'glass' : 'dark'] ||= oldMaterial({ color: [0.22, 0.22, 0.2], opacity: o.name === 'glass' ? 0.38 : 1 }); }); m.rotation.z = rand() < 0.3 ? 1.45 : 0; g.add(m); return { group: g, seats: [], radius: 0.25 }; }, // (now and then knocked over)
  },
  namedLantern: {
    label: 'Lantern with a name (swaying)', category: 'Lights',
    build(d = {}) {
      // a lit lantern on a cord from a crooked branch, swinging in a gusting wind, a brass plate on its base with
      // a name scratched in (data "engraving"); the plate faces +Z
      const g = new THREE.Group(), bark = lit('bark');
      g.add(assemble([[bark, [cylG(0.07, 0.12, 2.9, 6).translate(-0.9, 1.45, -0.3), bar(V(-0.9, 2.6, -0.3), V(0.1, 2.85, 0), 0.07), bar(V(0.1, 2.85, 0), V(0.35, 2.8, 0.05), 0.045)]]]));
      const swing = new THREE.Group(); swing.position.set(0.05, 2.84, 0); g.add(swing);
      const lamp = buildModelMerged(oilLantern.model).group; lamp.scale.setScalar(1.6); lamp.position.y = -1.05; swing.add(lamp, assemble([[lit('metal'), [bar(V(0, 0, 0), V(0, -0.52, 0), 0.01)]]]));
      const plate = namePlate(d.engraving || 'Albertine Gorse', 0.36); plate.position.set(0, -1.05 + 0.03, 0.13); swing.add(plate);
      const ph = rand() * 6;
      return { group: g, seats: [], radius: 0.4, update: (t) => { const gust = 0.5 + 0.5 * Math.sin(t * 0.37 + ph); swing.rotation.z = Math.sin(t * 1.4 + ph) * 0.16 * gust; swing.rotation.x = Math.sin(t * 1.05 + ph * 2) * 0.1 * gust; swing.rotation.y = Math.sin(t * 0.5) * 0.25; } };
    },
  },
  lanternPost: {
    label: 'Lantern on a hook', category: 'Lights',
    build(d = {}) {
      // data "engraving": a brass plate with that name on the lantern's base, turned "engravingTurn" radians
      // from +Z (so it can face the shot that reads it)
      const g = assemble([[lit('wood'), [boxG(0.1, 2.2, 0.1, 0, 1.1, 0), boxG(0.6, 0.07, 0.07, 0.25, 2.12, 0)]]]);
      const hang = new THREE.Group(); hang.position.set(0.5, 2.08, 0); g.add(hang);
      const m = buildModelMerged(oilLantern.model).group; m.scale.setScalar(1.3); m.position.y = -0.62; hang.add(m, assemble([[lit('metal'), [bar(V(0, 0, 0), V(0, -0.3, 0), 0.01)]]]));
      // (the plate sits on the fuel tank: radius 0.078, 0.036 tall, x1.3)
      if (d.engraving) { const turn = new THREE.Group(), plate = namePlate(d.engraving, 0.12, true); plate.position.set(0, -0.62 + 0.04, 0.1); plate.rotation.x = -0.25; turn.rotation.y = d.engravingTurn || 0; turn.add(plate); hang.add(turn); }
      const ph = rand() * 6;
      return { group: g, seats: [], radius: 0.4, update: (t) => { hang.rotation.z = Math.sin(t * 0.8 + ph) * 0.05; hang.rotation.x = Math.sin(t * 0.55 + ph) * 0.03; } };
    },
  },
  lanternTree: {
    label: 'Tree hung with lanterns', category: 'Lights',
    build() {
      // a dead tree whose branch tips each hold a lantern on a string, barely swaying; one lantern the bark has
      // grown around, still faintly lit
      const r = rng(Math.floor(rand() * 1e6)), parts = [], up = V(0, 1, 0), tips = [];
      const branch = (base, dir, len, rd, depth) => {
        parts.push(cylG(rd * 0.6, rd, len, 5).translate(0, len / 2, 0).applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, dir)).translate(base.x, base.y, base.z));
        const tip = base.clone().addScaledVector(dir, len);
        if (!depth) { if (tip.y > 2) tips.push(tip); return; }
        for (let k = 0, n = 2 + (r() * 2 | 0); k < n; k++) branch(tip, dir.clone().add(V((r() - 0.5) * 1.8, 0.1 + r() * 0.4, (r() - 0.5) * 1.8)).normalize(), len * (0.55 + r() * 0.2), rd * 0.55, depth - 1);
      };
      branch(V(0, -0.2, 0), V((r() - 0.5) * 0.2, 1, (r() - 0.5) * 0.2).normalize(), 2.6 + r() * 1.5, 0.26, 3);
      const g = assemble([[lit('bark'), parts]]), swings = [];
      tips.sort(() => r() - 0.5).slice(0, 3 + (r() * 3 | 0)).forEach((tip) => {
        const hang = new THREE.Group(); hang.position.copy(tip); g.add(hang);
        const len = 0.3 + r() * 0.6, m = buildModelMerged(oilLantern.model).group; m.scale.setScalar(1.2); m.position.y = -len - 0.52;
        hang.add(m, assemble([[lit('metal'), [bar(V(0, 0, 0), V(0, -len, 0), 0.008)]]]));
        swings.push([hang, r() * 6, 0.5 + r() * 0.5]);
      });
      // the swallowed one: half sunk into the trunk, glass still glowing through the bark
      const sunk = buildModelMerged(oilLantern.model).group; sunk.scale.setScalar(1.2); sunk.position.set(0.12, 1.1 + r() * 0.5, 0.1); sunk.rotation.z = 0.3; g.add(sunk);
      return { group: g, seats: [], radius: 0.5, update: (t) => { for (const [h, ph, sp] of swings) { h.rotation.z = Math.sin(t * sp + ph) * 0.06; h.rotation.x = Math.sin(t * sp * 0.7 + ph) * 0.04; } } };
    },
  },
  moths: {
    label: 'Moths (round a light)', category: 'Lights',
    build() {
      // a dozen small pale moths circling the spot (lift it to the lamp with "y"), each on its own lopsided orbit,
      // lurching up and down, wings beating; drawn as two flat triangles, like everything else
      const g = new THREE.Group(), wingMat = oldMaterial({ color: [0.92, 0.82, 0.64], glow: true, side: THREE.DoubleSide }) /* (lit by the lamp they circle) */, moths = [];
      const wingGeo = new THREE.BufferGeometry(); wingGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0.022, 0, 0, -0.025, 0.055, 0, -0.012], 3)); wingGeo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 0, 1, 1, 0.5], 2)); wingGeo.computeVertexNormals();
      for (let i = 0, n = 10 + Math.floor(rand() * 6); i < n; i++) {
        const m = new THREE.Group(), L = new THREE.Mesh(wingGeo, wingMat), R = new THREE.Mesh(wingGeo, wingMat); R.scale.x = -1; m.add(L, R); g.add(m);
        moths.push({ m, L, R, r: 0.18 + rand() * 0.5, sp: (0.9 + rand() * 1.6) * (rand() < 0.5 ? -1 : 1), ph: rand() * 6.3, h: rand() * 0.5 - 0.15, tilt: rand() * 0.8, flap: 18 + rand() * 10 });
      }
      return { group: g, seats: [], radius: 0.3, update: (t) => {
        for (const q of moths) {
          const a = t * q.sp + q.ph, r = q.r * (1 + 0.25 * Math.sin(t * 2.3 + q.ph)); // (lopsided, drawn in and flung out)
          q.m.position.set(Math.cos(a) * r, q.h + Math.sin(t * 3.1 + q.ph * 2) * 0.12 + Math.sin(a) * q.tilt * 0.2, Math.sin(a) * r);
          q.m.rotation.y = -a + (q.sp > 0 ? 0 : Math.PI);
          const f = Math.sin(t * q.flap + q.ph) * 1.1; q.L.rotation.z = f; q.R.rotation.z = -f;
        }
      } };
    },
  },
  boardwalk: {
    label: 'Plank walk (12 m)', category: 'Paths',
    build() {
      // grey planks across two stringers on posts, a board missing now and then, sagging a little; runs along +Z
      const L = 12, parts = [], posts = [], sag = (z) => -0.12 * Math.sin((z / L) * Math.PI);
      for (let z = -L / 2; z < L / 2; z += 0.32) { if (rand() < 0.08) continue; const g = boxG(1.2, 0.05, 0.26, 0, 0.55 + sag(z + L / 2) + (rand() - 0.5) * 0.03, z); g.rotateY((rand() - 0.5) * 0.06); parts.push(g); }
      for (const x of [-0.5, 0.5]) { parts.push(boxG(0.08, 0.08, L, x, 0.5, 0)); for (let z = -L / 2; z <= L / 2; z += 2) posts.push(boxG(0.1, 1.6, 0.1, x + (rand() - 0.5) * 0.05, -0.2, z)); }
      return { group: assemble([[lit('wood', [0.75, 0.75, 0.72]), [...parts, ...posts]]]), seats: [], radius: 0.8 };
    },
  },
  sack: {
    label: 'Sack', category: 'Strange',
    build() { const g = new THREE.SphereGeometry(0.28, 7, 5).scale(1, 1.25, 0.8).translate(0, 0.32, 0); return { group: assemble([[lit('pale', [0.62, 0.52, 0.4]), [g, cylG(0.07, 0.12, 0.14, 6).translate(0, 0.7, 0)]]]), seats: [], radius: 0.3 }; },
  },
  bed: {
    label: 'Bed', category: 'Furniture',
    build() {
      const wood = lit('wood'), p = [boxG(0.95, 0.3, 1.95, 0, 0.3, 0), boxG(0.95, 0.9, 0.06, 0, 0.45, -0.98), boxG(0.95, 0.55, 0.06, 0, 0.28, 0.98)];
      for (const [x, z] of [[-0.44, -0.94], [0.44, -0.94], [-0.44, 0.94], [0.44, 0.94]]) p.push(boxG(0.06, 0.3, 0.06, x, 0.15, z));
      const cloth = [boxG(0.88, 0.12, 1.8, 0, 0.5, 0.04), boxG(0.6, 0.1, 0.3, 0, 0.6, -0.72)];
      const g = assemble([[wood, p], [lit('pale', [0.95, 0.93, 0.88]), cloth]]);
      return { group: g, seats: [seat(g, 0, 0.55, 0.3)], radius: 1.1 };
    },
  },
  bedroom: {
    label: 'Bedroom seen through a window', category: 'Strange',
    build() {
      // a scrap of cottage: front wall with a four-pane window, a small room behind it lit by one warm lamp, a
      // made bed that nobody is in; the window faces +Z
      // (setLight(k): the lamp and the room it lights, 1 on .. 0 dark; the slides fade it out)
      const wall = lit('pale', [0.8, 0.76, 0.68]), inside = lit('pale', [0.8, 0.76, 0.68]), W = 3, H = 2.6, D = 3, wy = 0.75, ww = 1.2, wh = 1.1, t = 0.12, p = [], q = [];
      p.push(boxG((W - ww) / 2, H, t, -(W + ww) / 4, H / 2, 0), boxG((W - ww) / 2, H, t, (W + ww) / 4, H / 2, 0), boxG(ww, wy, t, 0, wy / 2, 0), boxG(ww, H - wy - wh, t, 0, wy + wh + (H - wy - wh) / 2, 0));
      q.push(boxG(t, H, D, -W / 2, H / 2, -D / 2), boxG(t, H, D, W / 2, H / 2, -D / 2), boxG(W, H, t, 0, H / 2, -D), boxG(W, t, D, 0, H, -D / 2)); const floor = [boxG(W, 0.04, D, 0, 0.02, -D / 2)]; // (the floor: bare boards, not the walls' plaster)
      const frame = [boxG(ww, 0.05, 0.06, 0, wy + wh / 2, 0.02), boxG(0.05, wh, 0.06, 0, wy + wh / 2, 0.02), boxG(ww + 0.1, 0.07, 0.2, 0, wy - 0.02, 0.06)];
      const lamp = glow('light', [1.25, 1.0, 0.7]);
      const boards = lit('wood', [0.8, 0.72, 0.64]);
      const g = assemble([[wall, p], [inside, q], [boards, floor], [lit('wood'), frame], [lamp, [boxG(0.18, 0.22, 0.18, 0.95, 0.95, -2.5), boxG(0.4, 0.5, 0.4, 0.95, 0.5, -2.5).scale(1, 1, 1)]]]);
      const bed = PROPS.bed.build().group; bed.position.set(0.1, 0.04, -1.9); bed.rotation.y = Math.PI / 2; g.add(bed);
      const dim = [lamp, inside, boards]; bed.traverse((o) => { if (o.material?.uniforms?.color && !dim.includes(o.material)) dim.push(o.material); });
      const base = dim.map((m) => m.uniforms.color.value.clone());
      let was = 1;
      const at = new THREE.Object3D(); at.position.set(0.95, 1.1, -2.3); g.add(at);
      const lights = [{ at, color: [1, 0.8, 0.55], power: 3.5, distance: 6, level: () => was }];
      const setLight = (k) => { if (k === was) return; was = k; dim.forEach((m, i) => m.uniforms.color.value.copy(base[i]).multiplyScalar(m === lamp ? 0.04 + 0.96 * k : 0.1 + 0.9 * k)); };
      return { group: g, seats: [], radius: 2, setLight, lights };
    },
  },
  rock: {
    label: 'Rock', category: 'Nature',
    build() {
      const g = new THREE.IcosahedronGeometry(1, 0).toNonIndexed(), pa = g.attributes.position, sd = rand() * 100;
      for (let v = 0; v < pa.count; v++) { const k = 0.75 + hash2(pa.getX(v) * 7, pa.getY(v) * 7 + pa.getZ(v) * 3, sd) * 0.5; pa.setXYZ(v, pa.getX(v) * k, pa.getY(v) * k, pa.getZ(v) * k); }
      g.scale(0.7, 0.45, 0.6).translate(0, 0.2, 0);
      return { group: assemble([[lit('rock'), [g]]]), seats: [], radius: 0.7 };
    },
  },
  mushroom: {
    label: 'Giant mushroom', category: 'Nature',
    build() {
      const h = 2.6, R = 1.6;
      return { group: assemble([[lit('stem'), [cylG(0.25, 0.38, h, 7).translate(0, h / 2, 0)]], [lit('spots'), [new THREE.SphereGeometry(R, 9, 4, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.55, 1).translate(0, h - 0.1, 0)]], [lit('pale'), [new THREE.CircleGeometry(R * 0.97, 9).rotateX(Math.PI / 2).translate(0, h - 0.08, 0)]]]), seats: [], radius: 0.5 };
    },
  },
  tv: {
    label: 'Old TV (static)', category: 'Strange',
    build() {
      const c = document.createElement('canvas'); c.width = 32; c.height = 24; const sg = c.getContext('2d');
      const screen = new THREE.CanvasTexture(c); screen.magFilter = screen.minFilter = THREE.NearestFilter;
      const draw = () => { const img = sg.createImageData(32, 24); for (let i = 0; i < img.data.length; i += 4) { const v = Math.random() * 200 + 40; img.data.set([v, v, v * 1.05, 255], i); } sg.putImageData(img, 0, 0); screen.needsUpdate = true; };
      draw();
      const g = assemble([[lit('wood'), [boxG(0.62, 0.5, 0.5, 0, 0.25, 0)]], [oldMaterial({ map: screen, glow: true, color: [1.1, 1.1, 1.1] }), [new THREE.PlaneGeometry(0.46, 0.34).translate(0, 0.27, 0.252)]], [lit('metal'), [bar(V(0, 0.5, -0.05), V(-0.22, 0.85, -0.05), 0.012), bar(V(0, 0.5, -0.05), V(0.25, 0.8, -0.05), 0.012)]]]);
      let last = 0;
      return { group: g, seats: [], radius: 0.45, update: (t) => { if (t - last > 0.06) { last = t; draw(); } } };
    },
  },
  doorway: {
    label: 'Lone doorway', category: 'Strange',
    build() {
      const wood = lit('wood'), g = assemble([[wood, [boxG(0.15, 2.3, 0.15, -0.5, 1.15, 0), boxG(0.15, 2.3, 0.15, 0.5, 1.15, 0), boxG(1.15, 0.15, 0.15, 0, 2.3, 0)]]]);
      const door = assemble([[lit('paint'), [boxG(0.85, 2.1, 0.06, 0.425, 1.05, 0)]]]); door.position.set(-0.43, 0.05, 0); g.add(door);
      const b = { group: g, seats: [], radius: 0.7, open: 0.9, update: (t) => { door.rotation.y = -b.open + Math.sin(t * 0.3) * 0.05 * Math.min(1, b.open * 3); } }; // (open: 0 = shut)
      return b;
    },
  },
  swing: {
    label: 'Swing', category: 'Strange',
    build() {
      const H = 2.3, g = assemble([[lit('metal'), [bar(V(-1, 0, -0.6), V(-1, H, 0)), bar(V(-1, 0, 0.6), V(-1, H, 0)), bar(V(1, 0, -0.6), V(1, H, 0)), bar(V(1, 0, 0.6), V(1, H, 0)), bar(V(-1.05, H, 0), V(1.05, H, 0), 0.06)]]]);
      const sw = new THREE.Group(); sw.position.set(0, H, 0); g.add(sw);
      sw.add(assemble([[lit('metal'), [bar(V(-0.25, 0, 0), V(-0.25, -1.75, 0), 0.015), bar(V(0.25, 0, 0), V(0.25, -1.75, 0), 0.015)]], [lit('wood'), [boxG(0.6, 0.04, 0.22, 0, -1.78, 0)]]]));
      const s = seat(sw, 0, -1.74, 0.0), ph = rand() * 6;
      return { group: g, seats: [s], radius: 1.2, update: (t) => { sw.rotation.x = Math.sin(t * 0.9 + ph) * 0.07; } }; // barely moving, as if someone just got off
    },
  },
  // ---- the city you reach asleep ----
  dreamStreet: {
    label: 'Street of tall houses', category: 'City',
    build(d = {}) {
      // a cobbled street running along Z (length "length", 60 m) between two rows of impossibly tall, narrow
      // houses, windows here and there lit; "gaps": [{ side: 'left' | 'right', at: z, w }] leave room for a
      // shop or an alley. Some houses lean a little, as if they were listening.
      // "width": the road (7 m; a lane at 3); "pavement": false for none (a square); "edge": true ends the far
      // (-Z) side in a stone balustrade over nothing, the city simply stopping there
      const L = d.length || 60, RW = d.width || 7, PW = d.pavement === false ? 0 : 2.2, half = RW / 2 + PW, D = 7, gaps = d.gaps || [];
      const road = [], pave = [], walls = [[], [], []], dark = [], warm = [], pale = [], roofs = [], doors = [];
      road.push(new THREE.PlaneGeometry(RW, L).rotateX(-Math.PI / 2).translate(0, 0.02, 0));
      if (PW) for (const sx of [-1, 1]) pave.push(boxG(PW, 0.14, L, sx * (RW / 2 + PW / 2), 0.07, 0), boxG(0.18, 0.2, L, sx * (RW / 2 + 0.09), 0.1, 0));
      if (d.edge) { // balusters under a heavy rail, a plinth under them
        pave.push(boxG(RW, 0.25, 0.7, 0, 0.125, -L / 2 + 0.35), boxG(RW, 0.16, 0.55, 0, 1.12, -L / 2 + 0.35));
        for (let x = -RW / 2 + 0.3; x < RW / 2; x += 0.42) pave.push(place(new THREE.CylinderGeometry(0.07, 0.11, 0.8, 6, 1), x, 0.65, -L / 2 + 0.35));
        for (let x = -RW / 2; x <= RW / 2; x += 6) pave.push(boxG(0.5, 1.5, 0.6, x, 0.75, -L / 2 + 0.35));
      }
      const uv = (geo, sx, sy) => { const a = geo.attributes.uv; for (let i = 0; i < a.count; i++) a.setXY(i, a.getX(i) * sx, a.getY(i) * sy); return geo; };
      road[0] = uv(road[0], RW / 2, L / 2);
      for (const side of [-1, 1]) {
        let z = -L / 2;
        while (z < L / 2 - 2) {
          const gap = gaps.find((g) => (g.side === 'left' ? -1 : 1) === side && Math.abs(g.at - (z + 2)) < (g.w || 4) / 2 + 1.5);
          if (gap) { z = gap.at + (gap.w || 4) / 2 + 0.1; continue; }
          const w = 3 + rand() * 2.2, H = rand() < 0.15 ? 38 + rand() * 14 : 13 + rand() * 20, x = side * (half + D / 2), cz = z + w / 2;
          const lean = (rand() - 0.5) * 0.05, grp = [], tone = walls[(rand() * 3) | 0];
          grp.push(uv(boxG(D, H, w - 0.08, 0, H / 2, 0), w / 4, H / 8)); // (D deep toward the street's side, w along it: the facade is the x face the windows sit on)
          // a narrow pitched roof, or a flat parapet
          if (rand() < 0.6) { const rg = new THREE.CylinderGeometry(0.01, (w / 2) * 1.35, 2.2 + rand() * 2.5, 4, 1); rg.rotateY(Math.PI / 4).scale(D / w, 1, 1).translate(0, H + 1.1, 0); roofs.push(place(rg, x, 0, cz, 0, 0, side * lean)); }
          else grp.push(boxG(D + 0.2, 0.5, w, 0, H + 0.25, 0));
          for (const q of grp) tone.push(place(q, x, 0, cz, 0, 0, side * lean));
          // windows on the street face: a tall narrow grid, most dark, a few lit
          const cols = w > 4.2 ? 2 : 1, fx = -side * (D / 2 + 0.03);
          for (let y = 3.2; y < H - 1.5; y += 2.6 + rand() * 0.4) for (let c = 0; c < cols; c++) {
            const wx = cols === 1 ? 0 : (c - 0.5) * w * 0.45, k = rand(), win = new THREE.BoxGeometry(0.9, 1.6, 0.14).rotateY(side * -Math.PI / 2).translate(fx + side * 0.08, y, wx); // (set into the wall, its face 2 cm proud: seen along a facade, nothing sticks out past its edge)
            (k < 0.1 ? warm : k < 0.14 ? pale : dark).push(place(win, x, 0, cz, 0, 0, side * lean));
          }
          const door = new THREE.BoxGeometry(1.1, 2.2, 0.14).rotateY(side * -Math.PI / 2).translate(fx + side * 0.08, 1.1, 0); doors.push(place(door, x, 0, cz));
          z += w;
        }
      }
      const tones = [[0.95, 0.92, 0.88], [0.78, 0.8, 0.84], [0.9, 0.84, 0.78]];
      const g = assemble([
        [oldMaterial({ map: tex().cobble }), road], [lit('slab'), pave], [lit('window'), dark], [lit('paint', [0.5, 0.45, 0.42]), doors], [lit('roof'), roofs],
        ...walls.map((q, i) => [lit('facade', tones[i]), q]),
        [glow('windowLit', [1.1, 1, 0.9]), warm], [glow('windowLit', [0.7, 0.8, 0.95]), pale],
      ]);
      return { group: g, seats: [], radius: half + D };
    },
  },
  leaningLamp: {
    label: 'Streetlamp (leaning to look)', category: 'City',
    build(d = {}) {
      // a tall iron lamp whose post bends over like a neck, its lit shade hanging at the end like a face looking
      // down at whoever is under it; "lean" 0 stands straight like an honest lamp (1..2.8: past ~2 it hangs its
      // head); it breathes a little
      const H = d.height || 6.5, lean = d.lean ?? 2.4, metal = lit('dark', [1.3, 1.3, 1.35]), lamp = glow('light', [1.4, 1.2, 0.85]), g = new THREE.Group();
      if (!lean) { // (the one that doesn't lean: a plain lamp post, head down, nothing wrong with it at all)
        g.add(assemble([[metal, [cylG(0.07, 0.11, H, 6).translate(0, H / 2, 0), cylG(0.16, 0.2, 0.3, 6).translate(0, 0.15, 0), cylG(0.3, 0.12, 0.35, 4).rotateY(Math.PI / 4).translate(0, H + 0.1, 0)]], [lamp, [boxG(0.3, 0.04, 0.3, 0, H - 0.08, 0)]]]));
        const at = new THREE.Object3D(); at.position.y = H - 0.3; g.add(at);
        return { group: g, seats: [], radius: 0.4, lights: [{ at, color: [1, 0.82, 0.55], power: 70, distance: 18 }] }; // (lights: where a real light goes, in the lit looks)
      }
      const base = H * 0.45, neck = new THREE.Group(); neck.position.y = base; g.add(assemble([[metal, [cylG(0.07, 0.12, base, 6).translate(0, base / 2, 0), cylG(0.17, 0.21, 0.3, 6).translate(0, 0.15, 0)]]]), neck);
      const segs = 14, len = (H - base) / segs, parts = []; let p = V(0, 0, 0), a = 0;
      for (let i = 0; i < segs; i++) { const k = i / (segs - 1); a += (lean / segs) * (0.4 + 1.2 * k); const q = p.clone().add(V(0, Math.cos(a) * len, Math.sin(a) * len)); parts.push(bar(p, q, 0.1 - k * 0.04)); p = q; } // (bending more toward the end, like a neck)
      const head = new THREE.Group(); head.position.copy(p); head.rotation.x = a; neck.add(assemble([[metal, parts]]), head);
      // the shade opens along the neck's direction; its lit face is what looks at you
      head.add(assemble([[metal, [cylG(0.3, 0.07, 0.42, 8).translate(0, 0.16, 0), cylG(0.31, 0.31, 0.03, 8).translate(0, 0.37, 0)]], [lamp, [cylG(0.26, 0.26, 0.02, 8).translate(0, 0.385, 0)]]])); // (a round lit face, rimmed)
      // it watches: the neck keeps its bend where it was put, only turning a touch toward the camera, and the
      // lit shade points straight at it (a little unsteady, like something pretending to be a lamp)
      const ph = rand() * 6, v = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0), wob = new THREE.Quaternion(), wobE = new THREE.Euler();
      const at = new THREE.Object3D(); at.position.y = 0.6; head.add(at); // (just in front of its lit face)
      return {
        group: g, seats: [], radius: 0.4, lights: [{ at, color: [1, 0.82, 0.55], power: 70, distance: 18 }],
        update: (t, cam) => {
          let yaw = 0;
          if (cam) { g.updateWorldMatrix(true, false); v.copy(cam.position); g.worldToLocal(v); { let dy = Math.atan2(v.x, v.z); dy = Math.atan2(Math.sin(dy), Math.cos(dy)); yaw = Math.max(-0.25, Math.min(0.25, dy * 0.15)) + Math.sin(t * 0.23 + ph) * 0.03; } }
          neck.rotation.set(Math.sin(t * 0.35 + ph) * 0.04, yaw, 0, 'YXZ');
          if (!cam) return;
          neck.updateWorldMatrix(true, false); v.copy(cam.position); neck.worldToLocal(v); v.sub(head.position).normalize();
          head.quaternion.setFromUnitVectors(UP, v).multiply(wob.setFromEuler(wobE.set(Math.sin(t * 0.5 + ph) * 0.06, 0, Math.sin(t * 0.31 + ph) * 0.08)));
        },
      };
    },
  },
  jarShop: {
    label: 'Shop of hours in jars', category: 'City',
    build(d = {}) {
      // a narrow tall shopfront: a big window, shelves of glass jars behind it, each with a small light
      // trapped inside, flickering on its own; a painted sign ("sign", optional). Faces +Z, 4.4 m wide.
      const W = 4.4, Hs = 3.8, D = 3, H = d.height || 18, wall = lit('facade', [0.86, 0.82, 0.78]), trim = lit('paint', [0.7, 0.62, 0.55]);
      const shell = [boxG(W, H - Hs, D + 4, 0, Hs + (H - Hs) / 2, -(D + 4) / 2), boxG(W, Hs, 0.2, 0, Hs / 2, -D), boxG(0.25, Hs, D, -W / 2 + 0.12, Hs / 2, -D / 2), boxG(0.25, Hs, D, W / 2 - 0.12, Hs / 2, -D / 2), boxG(W, 0.1, D, 0, 0.05, -D / 2)];
      const front = [boxG(W, 0.7, 0.2, 0, 0.35, 0), boxG(W, 0.5, 0.2, 0, Hs - 0.25, 0), boxG(0.3, Hs, 0.22, -W / 2 + 0.15, Hs / 2, 0), boxG(0.3, Hs, 0.22, W / 2 - 0.15, Hs / 2, 0), boxG(0.08, Hs - 1.2, 0.1, 0, 0.7 + (Hs - 1.2) / 2, 0.02)];
      const shelves = [], jars = [], lights = [[], [], []];
      for (let row = 0; row < 4; row++) {
        const y = 0.85 + row * 0.62; shelves.push(boxG(W - 0.6, 0.04, 0.5, 0, y, -0.9), boxG(W - 0.6, 0.04, 0.5, 0, y, -2.2));
        for (const zz of [-0.9, -2.2]) for (let x = -W / 2 + 0.45; x < W / 2 - 0.4; x += 0.2 + rand() * 0.08) {
          const r = 0.055 + rand() * 0.03, h = 0.13 + rand() * 0.12;
          jars.push(cylG(r, r, h, 6).translate(x, y + 0.02 + h / 2, zz + (rand() - 0.5) * 0.1), cylG(r * 0.7, r * 0.7, 0.03, 6).translate(x, y + 0.035 + h, zz));
          if (rand() < 0.9) lights[(rand() * 3) | 0].push(new THREE.IcosahedronGeometry(r * 0.7, 0).translate(x, y + 0.02 + h * (0.35 + rand() * 0.3), zz));
        }
      }
      const glass = oldMaterial({ glow: true, color: [0.55, 0.6, 0.58], opacity: 0.4 }), pane = oldMaterial({ color: [0.5, 0.55, 0.6], opacity: 0.12 });
      const cols = [[2, 1.5, 0.8], [1.1, 1.6, 1.8], [1.8, 1.1, 1.2]], lm = cols.map((c) => oldMaterial({ glow: true, color: c }));
      const parts = [[wall, shell], [trim, front], [lit('wood'), shelves], [glow('light', [0.34, 0.26, 0.18]), [boxG(W - 0.5, Hs - 0.3, 0.02, 0, Hs / 2, -D + 0.12)]], [glass, jars], [pane, [new THREE.PlaneGeometry(W - 0.6, Hs - 1.2).translate(0, 0.7 + (Hs - 1.2) / 2, 0.01)]], ...lights.map((q, i) => [lm[i], q])];
      // windows up the tall narrow house above, all dark but one
      const wins = [], lit1 = [];
      for (let y = Hs + 1.6; y < H - 1.5; y += 2.7) for (const x of [-0.9, 0.9]) (rand() < 0.06 ? lit1 : wins).push(new THREE.PlaneGeometry(0.8, 1.5).translate(x, y, 0.02));
      parts.push([lit('dark'), wins], [glow('light', [1.2, 0.95, 0.6]), lit1]);
      // the window display: three steps of big jars right behind the glass, each with an hour inside (a small
      // glowing clock face stopped at its own time; a few are still going), a paper tag tied round the neck
      const clock = canvasTex(64, 64, (x) => { x.fillStyle = '#e8dfc4'; x.beginPath(); x.arc(32, 32, 30, 0, 7); x.fill(); x.strokeStyle = '#5a4a36'; x.lineWidth = 2; x.stroke(); x.fillStyle = '#3a3026'; for (let k = 0; k < 12; k++) { const an = (k / 12) * Math.PI * 2; x.fillRect(32 + Math.sin(an) * 24 - 1.5, 32 - Math.cos(an) * 24 - 1.5, 3, k % 3 ? 3 : 6); } });
      const tagT = canvasTex(16, 24, (x) => { x.fillStyle = '#d8cfb4'; x.fillRect(0, 0, 16, 24); x.fillStyle = 'rgba(40,30,20,.7)'; for (let y = 6; y < 22; y += 4) x.fillRect(2, y, 6 + ((y * 7) % 7), 1); });
      const steps = [], big = [], faces = [], tags = [], hands = [], face = oldMaterial({ map: clock, glow: true, color: [1.25, 1.1, 0.85] }), handM = lit('dark');
      for (let row = 0; row < 3; row++) {
        const y = 0.72 + row * 0.42, z = -0.35 - row * 0.32; steps.push(boxG(W - 0.6, 0.06, 0.34, 0, y, z), boxG(W - 0.6, y, 0.04, 0, y / 2, z + 0.17));
        for (let k = 0, n = 8 - row; k < n; k++) {
          const x = -((n - 1) * 0.42) / 2 + k * 0.42 + (rand() - 0.5) * 0.06, r = 0.12 + rand() * 0.03, h = 0.3 + rand() * 0.06;
          big.push(cylG(r, r, h, 8).translate(x, y + 0.03 + h / 2, z), cylG(r * 0.75, r * 0.75, 0.04, 8).translate(x, y + 0.05 + h, z));
          const cy = y + 0.03 + h * 0.48; faces.push(new THREE.CircleGeometry(r * 0.72, 12).translate(x, cy, z + 0.02));
          tags.push(place(new THREE.PlaneGeometry(0.07, 0.1), x + r * 0.7, y + h - 0.02, z + r + 0.005, 0, 0, 0.25));
          for (const [len, wd, spin] of [[r * 0.4, 0.014, 1], [r * 0.6, 0.009, 12]]) { // hour and minute hands
            const m = new THREE.Mesh(new THREE.BoxGeometry(wd, len, 0.004).translate(0, len / 2, 0), handM); m.position.set(x, cy, z + 0.03 + spin * 0.0005);
            const t0 = rand() * 12, going = row === 1 && k % 3 === 1; m.rotation.z = -((t0 * spin) % 12) / 12 * Math.PI * 2; hands.push({ m, going, spin, t0 }); }
        }
      }
      parts.push([lit('wood', [0.5, 0.42, 0.36]), steps], [glass, big], [face, faces], [oldMaterial({ map: tagT, color: [0.95, 0.92, 0.85] }), tags]);
      const g = assemble(parts);
      for (const h of hands) g.add(h.m);
      if (d.sign) {
        const c = document.createElement('canvas'); c.width = 256; c.height = 40; const x = c.getContext('2d');
        x.fillStyle = '#2a2622'; x.fillRect(0, 0, 256, 40); x.font = 'italic bold 26px Georgia, serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillStyle = '#d8c48a'; x.fillText(d.sign, 128, 21, 240);
        const t = new THREE.CanvasTexture(c); t.magFilter = t.minFilter = THREE.NearestFilter;
        const sign = new THREE.Mesh(new THREE.PlaneGeometry(W - 0.4, (W - 0.4) * 40 / 256), oldMaterial({ map: t, glow: true, color: [0.9, 0.88, 0.84] })); sign.position.set(0, Hs + 0.35, 0.13); g.add(sign);
      }
      const ph = rand() * 6;
      const at = new THREE.Object3D(); at.position.set(0, 1.8, -0.6); g.add(at);
      return { group: g, seats: [], radius: W / 2, lights: [{ at, color: [1, 0.78, 0.5], power: 40, distance: 12 }], update: (t) => { for (const h of hands) if (h.going) h.m.rotation.z = -((h.t0 + t * 0.02 * h.spin) % 12) / 12 * Math.PI * 2; lm.forEach((m, i) => m.uniforms.color.value.setRGB(...cols[i]).multiplyScalar(0.75 + 0.25 * Math.sin(t * (1.3 + i * 0.7) + ph + i * 2) + (hash2(Math.floor(t * 9), i, 5) < 0.05 ? -0.4 : 0))); } };
    },
  },
  moon: {
    label: 'Moon (much too close)', category: 'City',
    build(d = {}) {
      // a huge pale moon, outside the fog (place it far away and lift it with the prop's "y"); "size": diameter in m.
      // Faces +Z: face it to the camera.
      const S = d.size || 90, c = document.createElement('canvas'); c.width = c.height = 256; const x = c.getContext('2d'), r = rng(77);
      const gr = x.createRadialGradient(118, 112, 20, 128, 128, 126); gr.addColorStop(0, '#f2ecdc'); gr.addColorStop(0.7, '#d6cfb9'); gr.addColorStop(1, '#8e8674');
      x.fillStyle = gr; x.beginPath(); x.arc(128, 128, 126, 0, 7); x.fill();
      x.save(); x.beginPath(); x.arc(128, 128, 125, 0, 7); x.clip();
      for (let i = 0; i < 9; i++) { const cx = 50 + r() * 156, cy = 50 + r() * 156, n = 30 + (r() * 30 | 0); for (let k = 0; k < n; k++) { const rr = 6 + r() * 22; x.fillStyle = `rgba(104,98,86,${0.05 + r() * 0.05})`; x.beginPath(); x.ellipse(cx + (r() - 0.5) * 60, cy + (r() - 0.5) * 50, rr, rr * (0.6 + r() * 0.4), r() * 3, 0, 7); x.fill(); } } // (seas: clusters of soft dark)
      for (let i = 0; i < 45; i++) { const cx = r() * 256, cy = r() * 256, cr = 1 + r() * r() * 8; x.fillStyle = 'rgba(96,90,80,.22)'; x.beginPath(); x.arc(cx, cy, cr, 0, 7); x.fill(); x.strokeStyle = 'rgba(250,246,232,.18)'; x.lineWidth = 1; x.beginPath(); x.arc(cx + cr * 0.15, cy + cr * 0.15, cr, 3.6, 5.8); x.stroke(); } // (craters, lit rims)
      x.restore();
      const t = new THREE.CanvasTexture(c); t.magFilter = t.minFilter = THREE.NearestFilter;
      const h = document.createElement('canvas'); h.width = h.height = 64; const hx = h.getContext('2d'), hg = hx.createRadialGradient(32, 32, 12, 32, 32, 32);
      hg.addColorStop(0, 'rgba(232,226,208,.35)'); hg.addColorStop(1, 'rgba(232,226,208,0)'); hx.fillStyle = hg; hx.fillRect(0, 0, 64, 64);
      const g = new THREE.Group();
      const disc = new THREE.Mesh(new THREE.CircleGeometry(S / 2, 32), new THREE.MeshBasicMaterial({ map: t, fog: false, transparent: true }));
      const halo = new THREE.Mesh(new THREE.PlaneGeometry(S * 2.2, S * 2.2), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(h), fog: false, transparent: true, depthWrite: false }));
      halo.position.z = -1; g.add(halo, disc);
      return { group: g, seats: [], radius: 0.1 };
    },
  },
  skyline: {
    label: 'Endless city (distant)', category: 'City',
    build(d = {}) {
      // the rest of the city, going on to the horizon: a field of tall narrow towers ("width" x "depth", from the
      // prop's position away along -Z), spires and flat tops, a window lit here and there; the fog swallows it
      // "front": the ground reaches that far forward (+Z, back to where the near city stops), with low rooftops
      // in between, so nothing floats: past the end of the land there is still street under every tower
      const W = d.width || 400, Dp = d.depth || 200, F = d.front || 0, walls = [], lit1 = [], spires = [], ground = [];
      ground.push(new THREE.PlaneGeometry(W + 200, Dp + F + 150).rotateX(-Math.PI / 2).translate(0, 0.03, (F - Dp - 150) / 2));
      // (the low rooftops: kept back from where the near city stops, and low)
      for (let i = 0, n = Math.round((F * W) / 160); i < n; i++) { const x = (rand() - 0.5) * W, z = rand() * F * 0.6, w = 4 + rand() * 6, dd = 5 + rand() * 7, h = 2 + rand() * 4; walls.push(boxG(w, h, dd, x, h / 2, z)); if (rand() < 0.5) spires.push(new THREE.ConeGeometry(Math.min(w, dd) * 0.7, 1.5 + rand() * 2.5, 4).rotateY(Math.PI / 4).translate(x, h + 0.9, z)); }
      for (let i = 0, n = d.count || 420; i < n; i++) {
        const x = (rand() - 0.5) * W, z = -rand() * Dp, w = 3 + rand() * 5, dd = 4 + rand() * 6, h = (d.height || 1) * (12 + rand() * rand() * 60);
        walls.push(boxG(w, h, dd, x, h / 2, z));
        if (rand() < 0.45) spires.push(new THREE.ConeGeometry(Math.min(w, dd) * 0.55, 3 + rand() * 8, 4).rotateY(Math.PI / 4).translate(x, h + 2.5, z));
        for (let k = 0, m = (h / 6) | 0; k < m; k++) if (rand() < 0.12) lit1.push(new THREE.PlaneGeometry(0.9, 1.4).translate(x + (rand() - 0.5) * (w - 1), 3 + rand() * (h - 5), z + dd / 2 + 0.05));
      }
      return { group: assemble([[oldMaterial({ map: tex().cobble, color: [0.8, 0.8, 0.84] }), ground], [lit('facade', [0.62, 0.62, 0.68]), walls], [lit('dark'), spires], [glow('light', [1.1, 0.9, 0.6]), lit1]]), seats: [], radius: 1 };
    },
  },
  prints: {
    label: 'Muddy footprints', category: 'Strange',
    build(d = {}) {
      // a trail of muddy prints along +Z ("length" m): "style" 'shoe' (a pair of shoes walking) or 'long' (bare,
      // too long, too narrow, the toes spread; a stride nobody has)
      const long = d.style === 'long', Lg = d.length || 3, c = document.createElement('canvas'); c.width = 32; c.height = 64; const x = c.getContext('2d');
      x.fillStyle = 'rgba(118,114,112,.9)'; // (the grey of that street, not any mud from here)
      if (long) { x.beginPath(); x.ellipse(16, 40, 6, 20, 0, 0, 7); x.fill(); for (let k = 0; k < 5; k++) { x.beginPath(); x.ellipse(7 + k * 4.5, 12 - Math.abs(k - 2) * 2, 1.6, 5, (k - 2) * 0.15, 0, 7); x.fill(); } }
      else { x.beginPath(); x.ellipse(16, 22, 10, 18, 0, 0, 7); x.fill(); x.beginPath(); x.ellipse(16, 52, 8, 9, 0, 0, 7); x.fill(); }
      const t = new THREE.CanvasTexture(c); t.magFilter = t.minFilter = THREE.NearestFilter;
      const w = long ? 0.11 : 0.1, l = long ? 0.42 : 0.27, step = long ? 0.95 : 0.6, q = [];
      for (let z = 0, k = 0; z < Lg; z += step / 2, k++) q.push(new THREE.PlaneGeometry(w, l).rotateX(-Math.PI / 2).rotateY(Math.PI + (rand() - 0.5) * 0.15).translate((k % 2 ? 1 : -1) * (long ? 0.09 : 0.1), 0.005 + k * 0.0003, z));
      return { group: assemble([[oldMaterial({ map: t, alphaTest: 0.5 }), q]]), seats: [], radius: 0.3 };
    },
  },
  shoes: {
    label: 'Shoes (muddy)', category: 'Furniture',
    build(d = {}) {
      // a pair of old leather shoes by the bed, one fallen on its side, caked in a grey mud that isn't from
      // anywhere near here: a real outline (round toe, narrow waist, heel), the vamp sloping to the toe, a dark
      // opening, laces, a thick sole
      const leather = lit('leather'), mud = lit('mud'), dark = lit('dark'), lace = lit('pale', [0.8, 0.76, 0.66]);
      const outline = (k) => { const sh = new THREE.Shape(); for (let i = 0; i <= 28; i++) { const a = (i / 28) * Math.PI * 2, z = 0.14 * Math.sin(a), w = (0.042 + 0.011 * Math.sin(a) - 0.008 * Math.cos(2 * a)) * k; const x = w * Math.cos(a); i ? sh.lineTo(x, -z) : sh.moveTo(x, -z); } return sh; };
      const prof = (z) => { const u = (z + 0.14) / 0.28; return u < 0.45 ? 0.085 - u * 0.02 : 0.076 - (u - 0.45) * 0.085; }; // (high at the heel, sloping down the vamp to the toe)
      const shoe = () => {
        const up = new THREE.ExtrudeGeometry(outline(1), { depth: 1, bevelEnabled: false, curveSegments: 1 }).rotateX(-Math.PI / 2), pa = up.attributes.position;
        for (let i = 0; i < pa.count; i++) if (pa.getY(i) > 0.5) pa.setY(i, prof(pa.getZ(i))); else pa.setY(i, 0.018);
        const sole = new THREE.ExtrudeGeometry(outline(1.06), { depth: 0.022, bevelEnabled: false, curveSegments: 1 }).rotateX(-Math.PI / 2);
        const heel = boxG(0.075, 0.03, 0.06, 0, 0.012, -0.105);
        const hole = new THREE.CircleGeometry(1, 10).scale(0.034, 0.05, 1).rotateX(-Math.PI / 2 + 0.12).translate(0, prof(-0.075) + 0.004, -0.075);
        const laces = []; for (let k = 0; k < 4; k++) { const z = -0.03 + k * 0.022; laces.push(boxG(0.05, 0.005, 0.007, 0, prof(z) + 0.004, z, 0, 0.3, (k % 2 ? 1 : -1) * 0.25)); }
        const clumps = []; for (let k = 0; k < 14; k++) { const z = (rand() - 0.35) * 0.26, sx = rand() < 0.5 ? -1 : 1, rr = 0.012 + rand() * 0.012; clumps.push(new THREE.IcosahedronGeometry(rr, 0).scale(0.45, 0.8, 1.4).translate(sx * (0.043 + 0.011 * Math.sin((z / 0.14) * Math.PI / 2) - rr * 0.3), 0.01 + rand() * 0.02, z)); } // (smeared flat along the sides, low)
        return { L: [up], M: [sole, heel, ...clumps], D: [hole], S: laces };
      };
      const parts = { L: [], M: [], D: [], S: [] };
      [[-0.07, 0, 0.12, 0], [0.09, 0.02, -0.35, 1.45]].forEach(([x, z, ry, rz]) => { // (the second one knocked over on its side, sole showing)
        const s1 = shoe(), lift = rz ? 0.05 : 0;
        for (const k of Object.keys(parts)) for (const q of s1[k]) parts[k].push(place(q, x, lift, z, ry, 0, rz));
      });
      return { group: assemble([[leather, parts.L], [mud, parts.M], [dark, parts.D], [lace, parts.S]]), seats: [], radius: 0.25 };
    },
  },

};
export const CATEGORIES = [...new Set(Object.values(PROPS).map((p) => p.category))];
// seeded: the same prop (by id) is built the same way every time, so a scene looks the same on every load
// (a slide that references it must match what was shot)
let rand = Math.random;
const seedOf = (str) => { let h = 2166136261; for (const ch of String(str)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return (h >>> 0) % 2147483646 + 1; };
export function buildProp(kind, seed, data = {}) { const def = PROPS[kind]; if (!def) return null; rand = seed != null ? rng(seedOf(seed)) : Math.random; const b = def.build(data); rand = Math.random; b.group.name = `prop-${kind}`; return b; }
