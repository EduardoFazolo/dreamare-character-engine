// Props you can drop into a scene from the editor's context menu. Same low-poly PS2 look as the scenario
// generator (canvas textures, old-console material), built independently of it (the village generator's
// random sequence stays untouched). Each builder returns { group, seats: [Object3D], update?(t), radius }.
// Seats are anchors where a sitting character's hips go; they may move (a rocking chair carries its sitter).
// Props face +Z, like characters.
import * as THREE from 'three';
import { oldMaterial } from './material.js';
import { rng, canvasTex, blotch, css, boxG, cylG, place, assemble, hash2 } from './util.js';

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
      const ph = Math.random() * 6;
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
      const r = rng(Math.floor(Math.random() * 1e6)), parts = [], up = V(0, 1, 0);
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
  rock: {
    label: 'Rock', category: 'Nature',
    build() {
      const g = new THREE.IcosahedronGeometry(1, 0).toNonIndexed(), pa = g.attributes.position, sd = Math.random() * 100;
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
      return { group: g, seats: [], radius: 0.7, update: (t) => { door.rotation.y = -0.9 + Math.sin(t * 0.3) * 0.05; } };
    },
  },
  swing: {
    label: 'Swing', category: 'Strange',
    build() {
      const H = 2.3, g = assemble([[lit('metal'), [bar(V(-1, 0, -0.6), V(-1, H, 0)), bar(V(-1, 0, 0.6), V(-1, H, 0)), bar(V(1, 0, -0.6), V(1, H, 0)), bar(V(1, 0, 0.6), V(1, H, 0)), bar(V(-1.05, H, 0), V(1.05, H, 0), 0.06)]]]);
      const sw = new THREE.Group(); sw.position.set(0, H, 0); g.add(sw);
      sw.add(assemble([[lit('metal'), [bar(V(-0.25, 0, 0), V(-0.25, -1.75, 0), 0.015), bar(V(0.25, 0, 0), V(0.25, -1.75, 0), 0.015)]], [lit('wood'), [boxG(0.6, 0.04, 0.22, 0, -1.78, 0)]]]));
      const s = seat(sw, 0, -1.74, 0.0), ph = Math.random() * 6;
      return { group: g, seats: [s], radius: 1.2, update: (t) => { sw.rotation.x = Math.sin(t * 0.9 + ph) * 0.07; } }; // barely moving, as if someone just got off
    },
  },
};
export const CATEGORIES = [...new Set(Object.values(PROPS).map((p) => p.category))];
export function buildProp(kind) { const def = PROPS[kind]; if (!def) return null; const b = def.build(); b.group.name = `prop-${kind}`; return b; }
