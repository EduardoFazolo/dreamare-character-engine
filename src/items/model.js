// Item models: a list of simple parts, each a primitive with a material and a colour, in the PS2 look.
// A part: { name, shape, material, color: '#rrggbb', pos: [x,y,z], rot: [x,y,z] (degrees), scale: [x,y,z], ...shape args }
//   box      size: [w, h, d]
//   cylinder radiusTop, radiusBottom, height, segments
//   cone     radius, height, segments
//   sphere   radius, segments (and optional phiLength / thetaLength in degrees for partial spheres)
//   torus    radius, tube, segments, arc (degrees)
//   lathe    points: [[radius, y], ...] spun around Y, segments  (lanterns, bottles, bells, vases)
// Materials: brass, iron, rust, silver, wood, bone, leather, cloth, paper, stone, dark, glass (lit from within), glow.
// Units are metres; the model sits on y = 0 and faces +Z.
import * as THREE from 'three';
import { oldMaterial } from '../scenario/material.js';
import { rng, canvasTex, blotch } from '../scenario/util.js';

export const SHAPES = ['box', 'cylinder', 'cone', 'sphere', 'torus', 'lathe'];
export const MATERIALS = ['brass', 'iron', 'rust', 'silver', 'wood', 'bone', 'leather', 'cloth', 'paper', 'stone', 'dark', 'glass', 'glow'];

let TEX = null;
function textures() {
  if (TEX) return TEX;
  const r = rng(777), grey = (k, spread = 40, grain = 24, cells = 4, extra) => canvasTex(64, 64, (g, w, h) => { blotch(g, w, h, [k, k, k], spread, grain, r, cells); extra?.(g, w, h); });
  TEX = {
    brass: grey(190, 60, 30, 5, (g, w, h) => { for (let i = 0; i < 40; i++) { g.fillStyle = 'rgba(40,30,10,.25)'; g.fillRect(r() * w | 0, r() * h | 0, 2 + (r() * 5 | 0), 1); } }),
    iron: grey(150, 50, 40, 5),
    rust: grey(160, 80, 50, 6, (g, w, h) => { for (let i = 0; i < 60; i++) { g.fillStyle = `rgba(${120 + r() * 60 | 0},${50 + r() * 30 | 0},20,.35)`; g.fillRect(r() * w | 0, r() * h | 0, 2 + (r() * 6 | 0), 2 + (r() * 4 | 0)); } }),
    silver: grey(215, 40, 20, 4),
    wood: grey(170, 40, 22, 3, (g, w, h) => { for (let x = 0; x < w; x += 3 + (r() * 4 | 0)) { g.fillStyle = 'rgba(40,25,10,.3)'; g.fillRect(x, 0, 1, h); } }),
    bone: grey(220, 30, 30, 5, (g, w, h) => { for (let i = 0; i < 30; i++) { g.fillStyle = 'rgba(90,80,60,.25)'; g.fillRect(r() * w | 0, r() * h | 0, 1, 2 + (r() * 6 | 0)); } }),
    leather: grey(160, 50, 40, 6),
    cloth: grey(190, 30, 50, 8, (g, w, h) => { for (let y = 0; y < h; y += 2) { g.fillStyle = 'rgba(0,0,0,.08)'; g.fillRect(0, y, w, 1); } }),
    paper: grey(225, 25, 18, 4),
    stone: grey(170, 70, 50, 5),
    dark: grey(60, 20, 16, 3),
    glass: grey(235, 20, 10, 3),
    glow: grey(250, 10, 6, 2),
  };
  return TEX;
}
const hex = (c) => new THREE.Color(c || '#ffffff');
const D = Math.PI / 180;

export function partGeometry(p) {
  const seg = Math.max(3, Math.round(p.segments || 8));
  switch (p.shape) {
    case 'box': return new THREE.BoxGeometry(...(p.size || [0.1, 0.1, 0.1]));
    case 'cylinder': return new THREE.CylinderGeometry(p.radiusTop ?? 0.05, p.radiusBottom ?? 0.05, p.height ?? 0.1, seg, 1, !!p.open);
    case 'cone': return new THREE.ConeGeometry(p.radius ?? 0.05, p.height ?? 0.1, seg);
    case 'sphere': return new THREE.SphereGeometry(p.radius ?? 0.05, seg, Math.max(2, Math.round(seg * 0.6)), 0, (p.phiLength ?? 360) * D, 0, (p.thetaLength ?? 180) * D);
    case 'torus': return new THREE.TorusGeometry(p.radius ?? 0.05, p.tube ?? 0.01, 5, seg, (p.arc ?? 360) * D);
    case 'lathe': return new THREE.LatheGeometry((p.points || [[0, 0], [0.05, 0], [0.05, 0.1], [0, 0.1]]).map(([x, y]) => new THREE.Vector2(x, y)), seg);
    default: return new THREE.BoxGeometry(0.05, 0.05, 0.05);
  }
}
export function partMaterial(p) {
  const T = textures(), m = p.material || 'iron', c = hex(p.color);
  const glowing = m === 'glass' || m === 'glow';
  const mat = oldMaterial({ map: T[m] || T.iron, color: [c.r * (glowing ? 1.2 : 1.35), c.g * (glowing ? 1.2 : 1.35), c.b * (glowing ? 1.2 : 1.35)], glow: glowing, side: p.shape === 'lathe' || p.open ? THREE.DoubleSide : THREE.FrontSide });
  return mat;
}
// the whole model as a group (flat-shaded parts), plus its size for framing
export function buildModel(model) {
  const g = new THREE.Group();
  for (const p of model?.parts || []) {
    let geo = partGeometry(p);
    geo = geo.index ? geo.toNonIndexed() : geo; geo.computeVertexNormals(); // faceted, like everything else
    const mesh = new THREE.Mesh(geo, partMaterial(p));
    mesh.name = p.name || p.shape;
    mesh.position.fromArray(p.pos || [0, 0, 0]);
    mesh.rotation.set(...(p.rot || [0, 0, 0]).map((v) => v * D), 'YXZ');
    mesh.scale.fromArray(p.scale || [1, 1, 1]);
    g.add(mesh);
  }
  const box = new THREE.Box3().setFromObject(g);
  return { group: g, box, size: box.isEmpty() ? new THREE.Vector3(0.2, 0.2, 0.2) : box.getSize(new THREE.Vector3()) };
}
