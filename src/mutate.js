import { OUTFITS, POSES } from './body.js';

// Parameter schema + landmark-driven warps. The same deform() runs in UV space (2D, bakes into
// the texture) and on the 3D mesh, because both share MediaPipe's 468-landmark indexing.

export const SCHEMA = [
  { group: 'Face mutations', items: [
    ['grin', 'Grin', -1, 3, 0],
    ['mouth', 'Mouth size', -1, 2, 0],
    ['eyes', 'Eye size', -0.8, 2, 0],
    ['eyeSpread', 'Eye spread', -1, 2, 0],
    ['tilt', 'Eye tilt', -1, 1, 0],
    ['nose', 'Nose size', -0.8, 2.5, 0],
    ['noseLen', 'Nose droop', -1, 2, 0],
    ['chin', 'Chin length', -1, 2, 0],
    ['forehead', 'Forehead', -1, 2, 0],
    ['brow', 'Brow height', -1, 1.5, 0],
    ['browAngry', 'Brow anger', -1, 1.5, 0],
    ['asym', 'Asymmetry', -1, 1, 0],
    ['long', 'Face length', -0.6, 1.2, 0],
    ['wide', 'Face width', -0.6, 1, 0],
  ]},
  { group: 'Skull (3D only)', items: [
    ['snout', 'Snout', -1, 2, 0],
    ['cranium', 'Cranium', -0.8, 2.5, 0],
    ['headDepth', 'Head depth', -0.6, 1.5, 0],
  ]},
  { group: 'Body', items: [
    ['headScale', 'Head size', 0.6, 2.2, 1.1],
    ['neckLen', 'Neck length', 0.1, 2.5, 0.5],
    ['shoulderW', 'Shoulder width', 1.2, 4.5, 2.5],
    ['torsoLen', 'Torso length', 1.5, 5.5, 3],
    ['girth', 'Girth', 0.45, 2.2, 1],
    ['belly', 'Belly', -0.3, 2.2, 0],
    ['hunch', 'Hunch', -0.3, 1.5, 0.1],
    ['armLen', 'Arm length', 0.5, 2.2, 1],
    ['handSize', 'Hand size', 0.5, 2.8, 1],
    ['fingerLen', 'Finger length', 0.4, 3.5, 1],
    ['legLen', 'Leg length', 0.35, 1.9, 1],
    ['footSize', 'Foot size', 0.5, 2.5, 1],
  ]},
  { group: 'Body sculpt', items: [
    ['muscle', 'Muscle', -0.5, 2, 0.3],
    ['fat', 'Fat / padding', -0.5, 1.5, 0],
    ['hump', 'Hump', 0, 2, 0],
    ['lumps', 'Lumps / tumors', 0, 2, 0],
    ['clay', 'Clay lumpiness', 0, 2, 0.3],
    ['sag', 'Sag / melt', 0, 2, 0],
    ['sleeveLen', 'Sleeve length', 0, 1, 1],
    ['pantsLen', 'Pants / skirt length', 0, 1, 1],
    ['looseness', 'Clothes looseness', 0, 1, 0.15],
    ['bodyGrime', 'Body grime', 0, 1, 0.3],
    ['polyBudget', 'Poly budget (tris)', 400, 6000, 2200],
  ]},
  { group: 'Outfit color', items: [
    ['outfitHue', 'Outfit hue', -180, 180, 0],
    ['outfitSat', 'Outfit saturation', 0, 2, 1],
    ['outfitBright', 'Outfit brightness', 0.4, 1.6, 1],
  ]},
  { group: 'Where mutations apply', items: [
    ['texWarp', 'Texture warp', 0, 1.5, 1],
    ['geoWarp', '3D warp', 0, 1.5, 0.5],
  ]},
  { group: 'Grade', items: [
    ['hue', 'Hue shift', -180, 180, 0],
    ['sat', 'Saturation', 0, 2.5, 1.1],
    ['contrast', 'Contrast', 0.5, 2.5, 1.25],
    ['bright', 'Brightness', -0.3, 0.3, 0],
    ['pale', 'Pale / clown', 0, 1, 0],
    ['shadowHue', 'Shadow tint hue', 0, 360, 270],
    ['shadowAmt', 'Shadow tint', 0, 1, 0.35],
    ['highHue', 'Highlight tint hue', 0, 360, 50],
    ['highAmt', 'Highlight tint', 0, 1, 0.2],
    ['sharpen', 'Oversharpen', 0, 3, 1],
    ['grime', 'Grime', 0, 1, 0.2],
    ['levels', 'Color levels', 3, 32, 20],
  ]},
  { group: 'Makeup (painted in UV space)', items: [
    ['socket', 'Sunken eyes', 0, 1.5, 0.4],
    ['eyeVoid', 'Void eyes', 0, 1, 0],
    ['teeth', 'Painted teeth', 0, 1.5, 0],
    ['lips', 'Lip color', 0, 1.5, 0.3],
    ['noseRed', 'Red nose', 0, 1.5, 0],
    ['flush', 'Cheek flush', 0, 1, 0.2],
  ]},
  { group: 'Render', items: [
    ['jitter', 'Vertex jitter', 0, 1, 0.6],
    ['affine', 'Affine warp', 0, 1, 0.5],
    ['vhs', 'VHS', 0, 1, 0.6],
    ['backUV', 'Back of head: edge smear -> skin', 0, 1, 0.55],
  ]},
];

export const CHOICES = {
  atlasRes: { label: 'Texture res', options: [64, 128, 256, 512], def: 128 },
  renderH: { label: 'Render height', options: [224, 240, 320, 448], def: 240 },
  geoSource: { label: 'Head shape', options: ['canonical', 'photo'], def: 'canonical' },
  view: { label: 'Camera', options: ['full', 'medium', 'portrait'], def: 'full' },
  bodyStyle: { label: 'Body style', options: ['sculpted', 'segmented'], def: 'sculpted' },
  bodyRes: { label: 'Body texture res', options: [128, 256, 512, 1024], def: 512 },
  bottomType: { label: 'Bottom', options: ['pants', 'skirt'], def: 'pants' },
  pose: { label: 'Pose', options: Object.keys(POSES), def: 'stand' },
  anim: { label: 'Animation', options: ['idle', 'walk', 'pose'], def: 'idle' },
  exportMat: { label: 'Export materials', options: ['lit', 'unlit'], def: 'lit' },
  outfit: { label: 'Outfit', options: Object.keys(OUTFITS), def: 'suit' },
  hat: { label: 'Hat', options: ['none', 'cowboy', 'bowler'], def: 'none' },
  hair: { label: 'Hair', options: ['none', 'stringy'], def: 'none' },
};

export function defaults() {
  const p = {};
  for (const g of SCHEMA) for (const [k, , , , d] of g.items) p[k] = d;
  for (const [k, c] of Object.entries(CHOICES)) p[k] = c.def;
  p.seed = 1;
  return p;
}

const L = {
  mouthL: 61, mouthR: 291, chin: 152, top: 10, sideL: 234, sideR: 454, nose: [1, 2, 98, 327],
  mouth: [13, 14, 0, 17],
  eyeL: [33, 133, 159, 145], eyeR: [263, 362, 386, 374],
  browL: [70, 63, 105, 66, 107], browR: [300, 293, 334, 296, 336],
  cheekL: [50, 205], cheekR: [280, 425],
};
export const LANDMARKS = L;

const sub = (a, b) => a.map((x, i) => x - b[i]);
const add = (a, b) => a.map((x, i) => x + b[i]);
const mul = (a, s) => a.map((x) => x * s);
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const len = (a) => Math.sqrt(dot(a, a));
const norm = (a) => mul(a, 1 / (len(a) || 1));
export const centerOf = (P, idx) => {
  const ids = [].concat(idx);
  return mul(ids.reduce((s, i) => add(s, P[i]), P[ids[0]].map(() => 0)), 1 / ids.length);
};

export function deform(P, p, k) {
  const dim = P[0].length;
  const W = len(sub(P[L.sideR], P[L.sideL]));
  const up = norm(sub(P[L.top], P[L.chin]));
  const right = norm(sub(P[L.sideR], P[L.sideL]));
  const fwd = dim === 3 ? norm([right[1] * up[2] - right[2] * up[1], right[2] * up[0] - right[0] * up[2], right[0] * up[1] - right[1] * up[0]]) : null;
  const C = centerOf(P, [L.top, L.chin]);
  const ops = [];
  const T = (c, r, v) => ops.push({ c, r: r * W, v: mul(v, k * W) });
  const S = (c, r, f) => ops.push({ c, r: r * W, f: 1 + (f - 1) * k });

  const mouthC = centerOf(P, L.mouth);
  for (const [corner, cheek] of [[L.mouthL, L.cheekL], [L.mouthR, L.cheekR]]) {
    const out = norm(sub(P[corner], mouthC));
    T(P[corner], 0.13, add(mul(out, p.grin * 0.1), mul(up, p.grin * 0.05)));
    T(centerOf(P, cheek), 0.15, mul(up, p.grin * 0.03));
  }
  S(mouthC, 0.22, 1 + 0.5 * p.mouth);
  const eyeL = centerOf(P, L.eyeL), eyeR = centerOf(P, L.eyeR);
  S(eyeL, 0.13, 1 + 0.6 * p.eyes);
  S(eyeR, 0.13, 1 + 0.6 * p.eyes);
  T(eyeL, 0.15, mul(right, -p.eyeSpread * 0.07));
  T(eyeR, 0.15, mul(right, p.eyeSpread * 0.07));
  T(P[33], 0.07, mul(up, p.tilt * 0.05));
  T(P[263], 0.07, mul(up, p.tilt * 0.05));
  const noseC = centerOf(P, L.nose);
  S(noseC, 0.16, 1 + 0.6 * p.nose);
  T(P[1], 0.14, mul(up, -p.noseLen * 0.06));
  T(P[L.chin], 0.35, mul(up, -p.chin * 0.12));
  T(P[L.top], 0.45, mul(up, p.forehead * 0.12));
  T(centerOf(P, L.browL), 0.12, mul(up, p.brow * 0.05));
  T(centerOf(P, L.browR), 0.12, mul(up, p.brow * 0.05));
  T(P[107], 0.07, mul(up, -p.browAngry * 0.04));
  T(P[336], 0.07, mul(up, -p.browAngry * 0.04));
  T(eyeL, 0.14, mul(up, p.asym * 0.05));
  T(eyeR, 0.14, mul(up, -p.asym * 0.03));
  T(P[L.mouthL], 0.1, mul(up, p.asym * 0.04));
  if (fwd) T(P[1], 0.16, mul(fwd, p.snout * 0.12));

  return P.map((q0) => {
    let d = q0.map(() => 0);
    for (const o of ops) {
      const rel = sub(q0, o.c);
      const w = Math.exp(-dot(rel, rel) / (o.r * o.r));
      if (w < 1e-4) continue;
      d = add(d, o.v ? mul(o.v, w) : mul(rel, (o.f - 1) * w));
    }
    let q = add(q0, d);
    const rel = sub(q, C);
    q = add(q, mul(up, dot(rel, up) * p.long * 0.3 * k));
    q = add(q, mul(right, dot(rel, right) * p.wide * 0.3 * k));
    return q;
  });
}

// ---------- randomizer: mostly-normal faces with one or two "signature" deformities ----------
const rnd = (a, b) => a + Math.random() * (b - a);
const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const GRADES = [
  { name: 'sallow', hue: [15, 45], sat: [1.1, 1.6], shadowHue: [120, 170], shadowAmt: [0.3, 0.6], highHue: [50, 70], highAmt: [0.3, 0.6] },
  { name: 'bruise', hue: [-40, -10], sat: [1.0, 1.4], shadowHue: [240, 280], shadowAmt: [0.5, 0.9], pale: [0.1, 0.4], noseRed: [0.4, 1.2], socket: [0.6, 1.2] },
  { name: 'clown', pale: [0.6, 0.95], lips: [0.9, 1.4], noseRed: [0.8, 1.4], socket: [0.5, 1.1], contrast: [1.3, 1.8] },
  { name: 'sunburn', hue: [-15, 5], sat: [1.4, 2.0], flush: [0.6, 1], highAmt: [0.2, 0.5] },
  { name: 'corpse', sat: [0.3, 0.7], shadowHue: [190, 220], shadowAmt: [0.4, 0.8], socket: [0.9, 1.5], contrast: [1.4, 2] },
  { name: 'plain', sat: [0.9, 1.3] },
];

export function randomize(base) {
  const p = { ...base };
  const shape = SCHEMA[0].items.concat(SCHEMA[1].items);
  for (const [k, , mn, mx] of shape) p[k] = Math.max(mn, Math.min(mx, gauss() * 0.25 * (mx - mn) * 0.5));
  p.grin = rnd(0.3, 1.8);
  for (let i = 0; i < 1 + Math.floor(Math.random() * 2); i++) {
    const [k, , mn, mx] = pick(shape);
    p[k] = Math.random() < 0.8 ? rnd(mx * 0.6, mx) : rnd(mn, mn * 0.6);
  }
  const g = pick(GRADES);
  Object.assign(p, { hue: 0, sat: 1.1, contrast: rnd(1.1, 1.5), pale: 0, shadowAmt: 0.3, highAmt: 0.2, noseRed: 0, socket: rnd(0.2, 0.6), lips: rnd(0.1, 0.5), flush: rnd(0, 0.4), eyeVoid: Math.random() < 0.08 ? rnd(0.6, 1) : 0 });
  for (const [k, v] of Object.entries(g)) if (Array.isArray(v)) p[k] = rnd(v[0], v[1]);
  p.teeth = Math.random() < 0.6 ? rnd(0.5, 1.3) : 0;
  p.sharpen = rnd(0.6, 2);
  p.grime = rnd(0.1, 0.5);
  p.texWarp = rnd(0.7, 1.3);
  p.geoWarp = rnd(0.3, 0.9);
  const body = SCHEMA.find((g) => g.group === 'Body').items;
  for (const [k, , mn, mx, d] of body) p[k] = Math.max(mn, Math.min(mx, d + gauss() * 0.12 * (mx - mn)));
  if (Math.random() < 0.75) {
    const [k, , mn, mx, d] = pick(body);
    p[k] = Math.random() < 0.75 ? rnd(d + (mx - d) * 0.55, mx) : rnd(mn, d - (d - mn) * 0.55);
  }
  p.headScale = Math.max(p.headScale, rnd(0.95, 1.35));
  p.outfitHue = Math.random() < 0.3 ? rnd(-180, 180) : rnd(-15, 15);
  p.outfitSat = rnd(0.7, 1.4);
  p.outfitBright = rnd(0.75, 1.15);
  p.pose = pick(['stand', 'stand', 'stand', 'hunch', 'hunch', 'crouch', 'gunslinger', 'zombie']);
  p.outfit = pick(Object.keys(OUTFITS));
  // sculpt: mostly subtle, sometimes one thing goes very wrong
  p.seed = Math.floor(Math.random() * 1e9);
  p.muscle = rnd(-0.3, 0.9);
  p.fat = Math.random() < 0.2 ? rnd(0.4, 1.3) : rnd(-0.3, 0.25);
  p.hump = Math.random() < 0.15 ? rnd(0.6, 2) : 0;
  p.lumps = Math.random() < 0.15 ? rnd(0.5, 1.8) : 0;
  p.clay = rnd(0.1, 0.8);
  p.sag = Math.random() < 0.2 ? rnd(0.5, 1.8) : rnd(0, 0.3);
  p.sleeveLen = Math.random() < 0.7 ? 1 : pick([0.1, 0.35, 0.5]);
  p.bottomType = Math.random() < 0.15 ? 'skirt' : 'pants';
  // skirts mostly knee to mid-calf (a full-length robe reads as fused pants), robes stay possible
  p.pantsLen = p.bottomType === 'skirt' ? (Math.random() < 0.2 ? 1 : rnd(0.2, 0.65)) : Math.random() < 0.8 ? 1 : pick([0.25, 0.5]);
  p.looseness = Math.random() < 0.2 ? rnd(0.5, 1) : rnd(0, 0.3);
  p.bodyGrime = rnd(0.1, 0.7);
  p.hat = pick(['none', 'none', 'cowboy', 'bowler']);
  p.hair = p.hat === 'none' ? pick(['none', 'stringy']) : pick(['none', 'none', 'stringy']);
  return p;
}
