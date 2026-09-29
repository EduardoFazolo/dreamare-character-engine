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
    bus: canvasTex(32, 32, (g) => { g.fillStyle = '#c8c4b8'; g.beginPath(); g.arc(16, 16, 15, 0, 7); g.fill(); g.fillStyle = '#6a3a34'; g.beginPath(); g.arc(16, 16, 12, 0, 7); g.fill(); g.fillStyle = '#d8d4c8'; g.font = 'bold 9px monospace'; g.textAlign = 'center'; g.fillText('BUS', 16, 19); }),
  };
  return T;
}
const lit = (k, color) => oldMaterial({ map: tex()[k], color });
const glow = (k, c = [1, 1, 1]) => oldMaterial({ map: tex()[k], glow: true, color: c });
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
  lanternPost: {
    label: 'Lantern on a hook', category: 'Lights',
    build() {
      const g = assemble([[lit('wood'), [boxG(0.1, 2.2, 0.1, 0, 1.1, 0), boxG(0.6, 0.07, 0.07, 0.25, 2.12, 0)]]]);
      const hang = new THREE.Group(); hang.position.set(0.5, 2.08, 0); g.add(hang);
      const m = buildModelMerged(oilLantern.model).group; m.scale.setScalar(1.3); m.position.y = -0.62; hang.add(m, assemble([[lit('metal'), [bar(V(0, 0, 0), V(0, -0.3, 0), 0.01)]]]));
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
      const wall = lit('pale', [0.8, 0.76, 0.68]), W = 3, H = 2.6, D = 3, wy = 0.75, ww = 1.2, wh = 1.1, t = 0.12, p = [];
      p.push(boxG((W - ww) / 2, H, t, -(W + ww) / 4, H / 2, 0), boxG((W - ww) / 2, H, t, (W + ww) / 4, H / 2, 0), boxG(ww, wy, t, 0, wy / 2, 0), boxG(ww, H - wy - wh, t, 0, wy + wh + (H - wy - wh) / 2, 0));
      p.push(boxG(t, H, D, -W / 2, H / 2, -D / 2), boxG(t, H, D, W / 2, H / 2, -D / 2), boxG(W, H, t, 0, H / 2, -D), boxG(W, t, D, 0, H, -D / 2), boxG(W, 0.04, D, 0, 0.02, -D / 2));
      const frame = [boxG(ww, 0.05, 0.06, 0, wy + wh / 2, 0.02), boxG(0.05, wh, 0.06, 0, wy + wh / 2, 0.02), boxG(ww + 0.1, 0.07, 0.2, 0, wy - 0.02, 0.06)];
      const g = assemble([[wall, p], [lit('wood'), frame], [glow('light', [1.25, 1.0, 0.7]), [boxG(0.18, 0.22, 0.18, 0.95, 0.95, -2.5), boxG(0.4, 0.5, 0.4, 0.95, 0.5, -2.5).scale(1, 1, 1)]]]);
      const bed = PROPS.bed.build().group; bed.position.set(0.1, 0.04, -1.9); bed.rotation.y = Math.PI / 2; g.add(bed);
      return { group: g, seats: [], radius: 2 };
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
};
export const CATEGORIES = [...new Set(Object.values(PROPS).map((p) => p.category))];
// seeded: the same prop (by id) is built the same way every time, so a scene looks the same on every load
// (a slide that references it must match what was shot)
let rand = Math.random;
const seedOf = (str) => { let h = 2166136261; for (const ch of String(str)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return (h >>> 0) % 2147483646 + 1; };
export function buildProp(kind, seed) { const def = PROPS[kind]; if (!def) return null; rand = seed != null ? rng(seedOf(seed)) : Math.random; const b = def.build(); rand = Math.random; b.group.name = `prop-${kind}`; return b; }
