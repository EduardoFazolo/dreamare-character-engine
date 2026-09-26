import * as THREE from 'three';
import { ps2Material } from './head.js';
import { paintSkinTile } from './skintile.js';
import { HEAD_PIVOT } from './headsculpt.js';

// Crude jointed humanoid in "head units" (face width = 1). Segments are low-poly lathes and
// cylinders; the look comes from photo textures + wrong proportions, same trick as the face.

const TILE = 0.9; // texture tile size in head units

export const OUTFITS = {
  suit: { top: 'Fabric039', bottom: 'Fabric039', shoes: 'Leather026', details: { buttons: true, belt: true } },
  undertaker: { top: 'Fabric042', bottom: 'Fabric042', shoes: 'Leather026', details: { buttons: true } },
  gunslinger: { top: 'Fabric042', bottom: 'Fabric022', shoes: 'Leather033C', details: { belt: true } },
  fur: { top: 'Carpet011', bottom: 'Carpet011', shoes: 'skin', hue: -35, sat: 1.5, girth: 1.25, fuzz: 0.12 },
  shag: { top: 'Carpet012', bottom: 'Carpet012', shoes: 'skin', girth: 1.2, fuzz: 0.12 },
  denim: { top: 'Fabric022', bottom: 'Fabric023', shoes: 'Leather033C', details: { buttons: true, belt: true } },
  knit: { top: 'Fabric040', bottom: 'Fabric025', shoes: 'Leather037' },
  sweater: { top: 'Fabric018', bottom: 'Fabric039', shoes: 'Leather026' },
  farmer: { top: 'Fabric054', bottom: 'Fabric023', shoes: 'Leather033C', details: { buttons: true, belt: true } },
  clown: { top: 'Fabric055', bottom: 'Fabric076', shoes: 'Leather037', feet: 1.7, details: { buttons: true } },
  prisoner: { top: 'Fabric071', bottom: 'Fabric071', shoes: 'Leather026' },
  velvet: { top: 'Fabric028', bottom: 'Fabric051', shoes: 'Leather026', details: { buttons: true } },
  naked: { top: 'skin', bottom: 'skin', shoes: 'skin' },
};

const HEAD_ON_NECK = [0.45, 0.5, 0.35]; // max head rotation on the neck (x nod, y turn, z tilt), radians

// joint rotations; A = character's right side (-x), B = left (+x). Signs: waist/neck/head x > 0 leans
// or looks down, shoulder x < 0 raises the arm forward, shoulder/hip z spreads (mirrored per side),
// elbow x < 0 bends, hip x < 0 lifts the thigh, knee x > 0 bends. rot: extra per-joint [x, y, z]
// (not mirrored), for the asymmetric poses; feet stay flat whatever the legs do.
// hand shapes: curl of the base, middle and tip finger segments (radians toward the palm), finger spread,
// and how much the fingers twitch in idle-type motions
export const HAND_SHAPES = {
  relaxed: { base: 0.25, mid: 0.35, tip: 0.25, spread: 0.11, twitch: 0.08 },
  claw: { base: -0.25, mid: 1.0, tip: 0.85, spread: 0.2, twitch: 0.22 },
  limp: { base: 0.5, mid: 0.6, tip: 0.45, spread: 0.06, twitch: 0.05 },
  fist: { base: 1.35, mid: 1.4, tip: 1.0, spread: 0.02, twitch: 0.03 },
  reach: { base: 0.05, mid: 0.12, tip: 0.1, spread: 0.24, twitch: 0.18 },
  spider: { base: 0.6, mid: 0.2, tip: -0.3, spread: 0.3, twitch: 0.3 },
};

export const POSES = {
  stand: { waist: 0.04, neck: 0.05, sh: [0.05, 0.1], el: -0.15, hip: [0, 0.04], knee: 0.05 },
  hunch: { hand: 'claw', waist: 0.5, neck: 0.45, sh: [-0.35, 0.12], el: -0.35, hip: [-0.25, 0.07], knee: 0.4 },
  crouch: { hand: 'claw', waist: 0.75, neck: 0.25, sh: [-1.05, 0.22], el: -0.2, hip: [-1.75, 0.28], knee: 2.2 },
  gunslinger: { handA: 'reach', waist: 0, neck: 0.02, sh: [0.05, 0.12], el: -0.2, shA: [-1.4, 0.15], elA: -0.05, hip: [0, 0.12], knee: 0.05 },
  zombie: { hand: 'reach', waist: 0.12, neck: 0.3, sh: [-1.45, 0.06], el: -0.1, hip: [0, 0.05], knee: 0.12 },
  // creepy ones
  broken: { hand: 'limp', waist: 0.1, neck: 0.15, sh: [0.1, 0.02], el: -0.05, hip: [0, 0.05], knee: 0.15, // neck snapped to one side, a shoulder dropped
    rot: { neck: [0, 0.2, 0.75], head: [0.1, 0.25, 0.45], waist: [0, 0, -0.12], shoulderA: [0.15, 0, 0.18], shoulderB: [-0.1, 0, -0.08], elbowB: [-0.35, 0, 0], kneeA: [0.25, 0, 0] } },
  lurker: { hand: 'claw', waist: 1.05, neck: 0.1, sh: [-0.95, 0.05], el: -0.08, hip: [-0.35, 0.16], knee: 0.65, // bent double, arms dangling straight down (sh ~ -waist), head craned up to stare
    rot: { head: [-0.55, 0, 0], neck: [-0.2, 0, 0], shoulderA: [0.1, 0, 0], shoulderB: [-0.15, 0, 0] } },
  puppet: { hand: 'limp', waist: -0.05, neck: 0.8, sh: [-2.35, 0.3], el: -0.25, hip: [0, 0.02], knee: 0.12, // marionette: strung up by the wrists, head lolling, a knee lifted
    rot: { head: [0.3, 0, 0.35], shoulderA: [0.25, 0, 0], shoulderB: [-0.15, 0, 0], waist: [0, 0, 0.08], kneeB: [0.55, 0, 0], hipB: [-0.35, 0, 0] } },
  stare: { hand: 'relaxed', waist: 0, neck: 0, sh: [0.02, -0.02], el: 0, hip: [0, 0.02], knee: 0, // square to the front, head turned hard, shoulders hiked
    rot: { neck: [0.05, 1.05, 0], head: [-0.08, 0.6, 0.12], shoulderA: [0, 0, -0.18], shoulderB: [0, 0, 0.18] } },
  crawler: { hand: 'spider', waist: 1.2, neck: -0.25, sh: [-1.7, 0.18], el: -0.35, hip: [-1.55, 0.3], knee: 2.1, // low on all fours-ish, hands near the ground, looking up
    rot: { head: [-0.7, 0, 0.15], shoulderA: [0.25, 0, 0], elbowA: [-0.3, 0, 0], kneeB: [0.15, 0, 0] } },
  mantis: { hand: 'fist', waist: 0.25, neck: 0.25, sh: [-0.75, -0.05], el: -2.25, hip: [0, 0.04], knee: 0.2, // arms folded up, hands under the chin, head cocked
    rot: { head: [0, -0.2, -0.5], shoulderA: [0.1, 0.25, 0], shoulderB: [0.1, -0.25, 0] } },
};

export class BodyRig {
  constructor() {
    this.root = new THREE.Group();
    this.parts = new THREE.Group();
    this.root.add(this.parts);
    this.loader = new THREE.TextureLoader();
    this.tex = {};
    this.mats = { top: ps2Material(), bottom: ps2Material(), shoes: ps2Material(), skin: ps2Material(), metal: ps2Material({ color: [0.62, 0.62, 0.66] }) };
    for (const [k, m] of Object.entries(this.mats)) m.name = k === 'metal' ? 'prop' : k; // material slots named by purpose
    this.headAnchor = new THREE.Group();
    this.headAnchor.userData.joint = 'head';
    this.j = { head: this.headAnchor };
  }

  preload() {
    const ids = new Set(Object.values(OUTFITS).flatMap((o) => [o.top, o.bottom, o.shoes]).filter((id) => id !== 'skin'));
    return Promise.all([...ids].map((id) => this.loader.loadAsync(`/textures/${id}.jpg`).then((t) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.magFilter = t.minFilter = THREE.NearestFilter;
      this.tex[id] = t;
    })));
  }

  // tile in the face's skin tone, for hands, neck and bare skin
  skinTexture([r, g, b]) {
    this.skinKey = [r, g, b].map((v) => v.toFixed(4)).join(',');
    if (!this.skinTex) {
      const c = document.createElement('canvas');
      this.skinTex = new THREE.CanvasTexture(c);
      this.skinTex.wrapS = this.skinTex.wrapT = THREE.RepeatWrapping;
      this.skinTex.magFilter = this.skinTex.minFilter = THREE.NearestFilter;
    }
    paintSkinTile(this.skinTex.image, [r, g, b]);
    this.skinTex.needsUpdate = true;
    return this.skinTex;
  }

  texture(id) {
    if (!this.tex[id]) {
      const t = this.loader.load(`/textures/${id}.jpg`);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.magFilter = t.minFilter = THREE.NearestFilter;
      this.tex[id] = t;
    }
    return this.tex[id];
  }

  update(p, skin, head) {
    const outfit = OUTFITS[p.outfit] || OUTFITS.suit;
    const skinTex = this.skinTexture(skin);
    this.mats.skin.uniforms.map.value = skinTex;
    for (const slot of ['top', 'bottom', 'shoes']) {
      const id = outfit[slot];
      const m = this.mats[slot];
      if (id === 'skin') { m.uniforms.map.value = skinTex; m.uniforms.hueShift.value = 0; m.uniforms.satMul.value = 1; }
      else {
        m.uniforms.map.value = this.texture(id);
        m.uniforms.hueShift.value = (outfit.hue || 0) + (slot === 'shoes' ? 0 : p.outfitHue);
        m.uniforms.satMul.value = (outfit.sat || 1) * (slot === 'shoes' ? 1 : p.outfitSat);
      }
      m.uniforms.color.value.setScalar(slot === 'shoes' || id === 'skin' ? 1 : p.outfitBright);
    }

    this.build(p, outfit);
    this.pose(p);

    head.scale.setScalar(p.headScale);
    head.position.set(0, -HEAD_PIVOT[1] * p.headScale, -HEAD_PIVOT[2] * p.headScale); // head joint at HEAD_PIVOT
    this.headAnchor.add(head);
    this.snap();
  }

  build(p, outfit) {
    this.headAnchor.removeFromParent(); // keep the head (and its geometry) out of the teardown
    for (const o of this.parts.children.slice()) { o.traverse((c) => c.geometry?.dispose()); this.parts.remove(o); }
    const g = p.girth * (outfit.girth || 1);
    const torso = p.torsoLen, waistY = torso * 0.42, chestH = torso - waistY;
    const hipR = 0.72 * g, waistR = 0.6 * g, chestR = 0.78 * g, sh = p.shoulderW / 2, neckR = 0.24 * Math.sqrt(g);
    const DEPTH = 0.62;
    const mesh = (geo, slot, parent, uvScale = true) => {
      const m = new THREE.Mesh(geo, this.mats[slot]);
      if (uvScale) tileUVs(geo);
      parent.add(m);
      return m;
    };
    const joint = (name, parent, x, y, z) => {
      const o = new THREE.Group();
      o.position.set(x, y, z);
      o.userData.joint = name;
      parent.add(o);
      this.j[name] = o;
      return o;
    };

    // Sculpt primitives (joint-local, head units): the sculpted style smooth-unions these into one
    // continuous surface. The segment meshes above/below stay as invisible proxies for ground snap.
    this.sculpt = { body: [], hands: { A: [], B: [] }, dims: { hipR, waistR, chestR, neckR } };
    const m = p.muscle, bb = Math.max(0, p.belly), L = 1.12; // sculpted limbs a bit chunkier than the proxies
    // group: limbs smooth-blend into the torso but never into each other (legs/feet stay separate)
    let grp = 'torso';
    const S = (j, prim) => this.sculpt.body.push({ joint: j, group: grp, ...prim });
    const E = (j, c, r, k, soft = true) => S(j, { type: 'ellipsoid', c, r, k, soft });
    const C = (j, a, b, r1, r2, k) => S(j, { type: 'cone', a, b, r1, r2, k });

    const pelvis = joint('pelvis', this.parts, 0, 0, 0);
    // pelvis ends just below the hip joints so it doesn't web the thighs together
    E(pelvis, [0, 0.04, -0.04 * g], [hipR * 1.02, 0.3 + 0.08 * g, hipR * 0.78], 0.25);
    for (const sx of [-1, 1]) E(pelvis, [sx * hipR * 0.42, -0.08, -hipR * 0.4], [hipR * 0.5, 0.3, hipR * 0.42].map((v) => v * (1 + 0.3 * m)), 0.2);
    E(pelvis, [0, waistY * 0.6, 0], [waistR * 1.02, waistY * 0.62 + 0.18, waistR * 0.74], 0.3);
    if (p.belly > -0.2) E(pelvis, [0, waistY * 0.5 - 0.12 * bb, waistR * (0.22 + 0.35 * bb)],
      [waistR * (0.8 + 0.45 * bb), (waistY * 0.45 + 0.2) * (1 + 0.45 * bb), waistR * (0.45 + 0.8 * bb)], 0.35 + 0.1 * bb);
    const abdomen = mesh(lathe([[0.02, -0.28], [hipR * 0.85, -0.22], [hipR, 0.1], [waistR, waistY]], hipR), 'bottom', pelvis);
    abdomen.scale.z = DEPTH;
    belly(abdomen.geometry, p.belly * g, 0, waistY);

    const waist = joint('waist', pelvis, 0, waistY, 0);
    const filler = mesh(new THREE.SphereGeometry(waistR, 8, 6), 'top', waist);
    filler.scale.z = DEPTH;
    const chest = mesh(lathe([[waistR, 0], [chestR, chestH * 0.45], [sh * 0.92, chestH * 0.86], [neckR * 1.3, chestH], [0.02, chestH + 0.02]], sh), 'top', waist);
    chest.scale.z = DEPTH;
    belly(chest.geometry, p.belly * g, -waistY, waistY);
    E(waist, [0, chestH * 0.48, 0], [chestR * 1.02, chestH * 0.56, chestR * 0.7], 0.35, false);
    for (const sx of [-1, 1]) E(waist, [sx * chestR * 0.42, chestH * 0.62, chestR * 0.4], [chestR * 0.42, chestH * 0.2, chestR * 0.28].map((v) => v * (0.6 + 0.7 * m)), 0.2);
    C(waist, [-sh * 0.8, chestH * 0.8, -0.02], [sh * 0.8, chestH * 0.8, -0.02], 0.25 * g * (1 + 0.3 * m), 0.25 * g * (1 + 0.3 * m), 0.25);
    for (const sx of [-1, 1]) C(waist, [sx * sh * 0.4, chestH * 0.84, -0.08], [0, chestH + 0.08, -0.05], 0.17 * g, 0.2 * g, 0.2);
    if (p.hump > 0) E(waist, [0, chestH * 0.78, -chestR * 0.62], [chestR * 0.6, chestH * 0.35, chestR * 0.45].map((v) => v * (0.5 + 0.7 * p.hump)), 0.3);

    const neck = joint('neck', waist, 0, chestH - 0.12, 0);
    mesh(new THREE.CylinderGeometry(neckR, neckR * 1.15, p.neckLen + 0.3, 7, 1, true).translate(0, (p.neckLen + 0.3) / 2, 0), 'skin', neck);
    C(neck, [0, -0.15, 0], [0, p.neckLen + 0.3, 0], neckR * 1.25, neckR, 0.15);
    this.sculpt.body.at(-1).neck = true; // the shirt's collar hole is fitted to this prim
    this.headAnchor.position.set(0, p.neckLen + 0.2, 0);
    neck.add(this.headAnchor);

    const armLen = p.armLen, ua = 1.7 * armLen, fa = 1.55 * armLen;
    // stance width: wide enough that thighs (with fat and clothing) and feet (with shoes) never overlap
    const fs0 = p.footSize * (outfit.feet || 1);
    const thighInner = Math.max(0.3 * g * L, 0.29 * g * L * (0.9 + 0.18 * m) - 0.06 * g);
    const pantsT = outfit.bottom !== 'skin' && p.bottomType !== 'skirt' ? 0.035 + 0.15 * p.looseness + 0.5 * (outfit.fuzz || 0) : 0;
    const hipX = Math.max(hipR * 0.56,
      thighInner + 0.4 * 0.28 * Math.max(0, p.fat) + pantsT + 0.05,
      0.18 * fs0 * Math.sqrt(g) + (outfit.shoes !== 'skin' ? 0.06 : 0) + 0.05);
    for (const [side, sx] of [['A', -1], ['B', 1]]) {
      const shoulder = joint('shoulder' + side, waist, sx * sh * 0.8, chestH * 0.8, 0);
      mesh(new THREE.SphereGeometry(0.27 * g, 7, 5), 'top', shoulder);
      mesh(limb(0.26 * g, 0.2 * g, ua), 'top', shoulder);
      grp = 'arm' + side;
      C(shoulder, [0, 0.05, 0], [0, -ua, 0], 0.26 * g * L, 0.2 * g * L, 0.18);
      E(shoulder, [0, -0.1, 0], [0.3 * g, 0.35, 0.3 * g].map((v) => v * L * (0.85 + 0.35 * m)), 0.2);
      E(shoulder, [0, -ua * 0.45, 0.05], [0.2 * g, ua * 0.28, 0.2 * g].map((v) => v * L * (0.8 + 0.55 * m)), 0.15);
      const elbow = joint('elbow' + side, shoulder, 0, -ua, 0);
      mesh(new THREE.SphereGeometry(0.2 * g, 7, 5), 'top', elbow);
      mesh(limb(0.2 * g, 0.15 * g, fa), 'top', elbow);
      C(elbow, [0, 0, 0], [0, -fa - 0.02, 0], 0.2 * g * L, 0.15 * g * L, 0.12);
      E(elbow, [0, -fa * 0.3, 0], [0.2 * g, fa * 0.3, 0.18 * g].map((v) => v * L * (0.85 + 0.35 * m)), 0.1);
      const wrist = joint('wrist' + side, elbow, 0, -fa, 0);
      this.hand(wrist, p, sx, mesh, side);

      const hip = joint('hip' + side, pelvis, sx * hipX, -0.1, 0);
      const th = 2.1 * p.legLen, shin = 2.0 * p.legLen;
      mesh(limb(0.36 * g, 0.26 * g, th), 'bottom', hip);
      grp = 'leg' + side;
      C(hip, [0, 0.1, 0], [0, -th, 0], 0.3 * g * L, 0.25 * g * L, 0.2);
      E(hip, [sx * 0.06 * g, -th * 0.35, 0.03], [0.29 * g, th * 0.35, 0.33 * g].map((v) => v * L * (0.9 + 0.18 * m)), 0.15);
      const knee = joint('knee' + side, hip, 0, -th, 0);
      mesh(new THREE.SphereGeometry(0.26 * g, 7, 5), 'bottom', knee);
      mesh(limb(0.26 * g, 0.18 * g, shin), 'bottom', knee);
      C(knee, [0, 0, 0], [0, -shin, 0], 0.26 * g * L, 0.18 * g * L, 0.1);
      E(knee, [0, -shin * 0.28, -0.07], [0.24 * g, shin * 0.28, 0.22 * g].map((v) => v * L * (0.8 + 0.5 * m)), 0.12);
      const ankle = joint('ankle' + side, knee, 0, -shin, 0);
      const fs = p.footSize * (outfit.feet || 1);
      mesh(new THREE.BoxGeometry(0.36 * fs * Math.sqrt(g), 0.26, 0.85 * fs).translate(0, -0.1, 0.22 * fs), 'shoes', ankle, false);
      // shaped foot: heel, arch, wider ball of the foot. Every piece stays inside the proxy's footprint
      // (ground snapping and contacts don't change) and reaches below the proxy's sole height (-0.23),
      // where the sculpt's ground plane cuts it flat. Each is placed so that cut crosses its surface at
      // 60 degrees: a sole merely touching the plane is tangent (slivers), a wall hitting it at 90 degrees
      // is a razor crease (teeth after decimation), and a shallower cut flattens the toes. Tops stay put.
      const fw = 0.18 * fs * Math.sqrt(g), SOLE = -0.23, CUT = 0.5; // cut CUT * r below the center: 60 deg
      const ell = (top, rx, rz, cz, k) => { const ry = (top - SOLE) / (1 + CUT); S(ankle, { type: 'ellipsoid', c: [0, top - ry, cz], r: [rx, ry, rz], k, rigid: true }); };
      ell(-0.03, fw * 0.72, 0.16, -0.02, 0.08); // heel
      const round = 0.08, bot = SOLE - (1 - CUT) * round; // arch: the cut crosses its rounded edge at 60
      S(ankle, { type: 'box', c: [0, (-0.03 + bot) / 2, 0.2 * fs], b: [fw * 0.8, (-0.03 - bot) / 2, 0.24 * fs], round, k: 0.1, rigid: true });
      ell(-0.07, fw, 0.2 * fs, 0.45 * fs, 0.1); // ball
      grp = 'torso';
    }
  }

  hand(wrist, p, sx, mesh, side) {
    const hs = p.handSize, g = p.girth;
    const palm = new THREE.BoxGeometry(0.34 * hs, 0.42 * hs, 0.13 * hs).translate(0, -0.21 * hs, 0);
    mesh(palm, 'skin', wrist);
    // Sculpted hand: palm (+ wrist) in the 'torso' group, each finger and the thumb in its own group, so
    // fingers join each other with a hard min (never fused into a mitten) and blend into the palm only.
    // Fingers fan out slightly so their gaps widen to several grid cells toward the tips; they are rigid
    // (fat swells the palm only: inflated fingers fused back into a mitten).
    const H = (j, prim) => this.sculpt.hands[side].push({ joint: j, ...prim });
    H(wrist, { type: 'box', c: [0, -0.21 * hs, 0], b: [0.17 * hs, 0.21 * hs, 0.065 * hs], round: 0.05 * hs, k: 0.04 * hs });
    H(wrist, { type: 'cone', a: [0, 0.25, 0], b: [0, -0.06 * hs, 0], r1: 0.15 * g, r2: 0.12 * hs, k: 0.06 });
    // the thumb sits on the +sx edge of the palm (where the T-pose aims it); fingers ordered from the
    // index (next to the thumb) to the pinky (shortest, far edge)
    const fl = 0.38 * p.fingerLen * hs, byRank = [0.92, 1, 0.94, 0.76];
    const LEN = [0, 1, 2, 3].map((i) => byRank[sx > 0 ? 3 - i : i]);
    for (let i = 0; i < 4; i++) {
      const f = new THREE.Group();
      f.position.set((i - 1.5) * 0.09 * hs, -0.39 * hs, 0);
      f.rotation.set(-0.25 - i * 0.05, 0, (i - 1.5) * 0.11);
      f.userData.joint = `finger${side}${i}`;
      this.j[f.userData.joint] = f;
      mesh(limb(0.04 * hs, 0.03 * hs, fl * LEN[i], 5), 'skin', f);
      this.fingerChain(f, `finger${side}${i}`, fl * LEN[i]);
      H(f, { type: 'cone', rigid: true, group: `finger${i}`, a: [0, 0.04 * hs, 0], b: [0, -fl * LEN[i], 0], r1: 0.038 * hs, r2: 0.03 * hs, k: 0.02 * hs });
      wrist.add(f);
    }
    const thumb = new THREE.Group();
    thumb.position.set(sx * 0.16 * hs, -0.14 * hs, 0.03 * hs);
    thumb.rotation.set(-0.5, 0, sx * 0.6);
    thumb.userData.joint = `thumb${side}`;
    this.j[thumb.userData.joint] = thumb;
    mesh(limb(0.045 * hs, 0.035 * hs, fl * 0.7, 5), 'skin', thumb);
    this.fingerChain(thumb, `thumb${side}`, fl * 0.7);
    H(thumb, { type: 'cone', rigid: true, group: 'thumb', a: [0, 0.03, 0], b: [0, -fl * 0.7, 0], r1: 0.048 * hs, r2: 0.036 * hs, k: 0.02 * hs });
    wrist.add(thumb);
  }

  // finger skeleton: a digit's joint gets two child joints (middle and tip segments) along its length, so
  // the finger can curl; the sculpted digit stays one smooth piece (it is straight in the bind pose)
  fingerChain(base, name, len) {
    const m = new THREE.Group(), t = new THREE.Group();
    m.position.set(0, -len * 0.45, 0); t.position.set(0, -len * 0.3, 0);
    m.userData.joint = name + 'm'; t.userData.joint = name + 't';
    this.j[name + 'm'] = m; this.j[name + 't'] = t;
    base.add(m); m.add(t);
  }


  // Poses/animations are written as driver-joint rotations; rig.js converts them to bone tracks.
  pose(p, poseName = p.pose, extra = {}) {
    const P = POSES[poseName] || POSES.stand, j = this.j, rot = P.rot || {};
    const out = 0.06 + p.girth * 0.05 + Math.max(0, p.belly) * 0.06;
    const set = (name, x, y = 0, z = 0) => {
      const e = extra[name] || [0, 0, 0], r = rot[name] || [0, 0, 0];
      j[name].rotation.set(x + e[0] + r[0], y + e[1] + r[1], z + e[2] + r[2]);
    };
    set('waist', P.waist + p.hunch * 0.5);
    set('neck', P.neck + p.hunch * 0.4);
    for (const [side, sx] of [['A', -1], ['B', 1]]) {
      const shp = (side === 'A' && P.shA) || P.sh, el = side === 'A' && P.elA !== undefined ? P.elA : P.el;
      set('shoulder' + side, shp[0], 0, sx * (shp[1] + out));
      set('elbow' + side, el);
      set('hip' + side, P.hip[0], 0, sx * P.hip[1]);
      set('knee' + side, P.knee);
      const e = (k) => (extra[k + side] || [0])[0] + (rot[k + side] || [0])[0];
      set('ankle' + side, -(P.hip[0] + e('hip') + P.knee + e('knee')));
    }
    // fingers: the pose's hand shape (base, middle, tip curl; curl bends toward the palm, negative bends
    // back) plus a slow, out-of-phase twitch from the motion (extra.fingers = time)
    // extra.fingers = [t, duration]: the twitch is whole sine cycles over the clip, so loops close exactly
    const HAND = HAND_SHAPES[P.hand || 'relaxed'], [tw, tdur] = extra.fingers || [], cyc = tw === undefined ? 0 : (2 * Math.PI * tw) / tdur;
    for (const [side, sx] of [['A', -1], ['B', 1]]) {
      const hs = (side === 'A' && P.handA) ? HAND_SHAPES[P.handA] : HAND;
      for (let i = 0; i < 4; i++) {
        const b = j[`finger${side}${i}`], m = j[`finger${side}${i}m`], t = j[`finger${side}${i}t`];
        if (!b || !m) continue;
        const tws = tw === undefined ? 0 : hs.twitch * Math.sin(cyc * (3 + (i % 2)) + i * 1.7 + (side === 'A' ? 0 : 2.1)) * (0.6 + 0.4 * Math.sin(cyc + i));
        b.rotation.set(-(hs.base + tws * 0.5) - i * 0.05, 0, (i - 1.5) * hs.spread);
        m.rotation.set(-(hs.mid + tws), 0, 0);
        t.rotation.set(-(hs.tip + tws * 0.8), 0, 0);
      }
      const th = j['thumb' + side], tm = j['thumb' + side + 'm'], tt = j['thumb' + side + 't'];
      if (th && tm) { th.rotation.set(-0.5 - hs.base * 0.3, 0, sx * 0.6); tm.rotation.set(-hs.mid * 0.5, 0, 0); tt.rotation.set(-hs.tip * 0.5, 0, 0); }
    }
    // head keeps looking forward-ish (plus the pose's own head rotation, from rot)
    const r = rot.waist?.[0] || 0, rn = rot.neck?.[0] || 0;
    set('head', -(j.waist.rotation.x - r + j.neck.rotation.x - rn) * 0.85);
    // The head is rigid (with a neck stub that hides the joint inside the body's neck): bent further on
    // the neck than a neck can, the stub swings out as a second neck. Cap the head-on-neck rotation and
    // hand the rest to the (smoothly skinned) neck joint: the head ends up facing the same way.
    const h = j.head.rotation, n = j.neck.rotation;
    for (const [ax, lim] of [['x', HEAD_ON_NECK[0]], ['y', HEAD_ON_NECK[1]], ['z', HEAD_ON_NECK[2]]]) {
      const c = Math.max(-lim, Math.min(lim, h[ax]));
      n[ax] += h[ax] - c; h[ax] = c;
    }
  }

  // Bind pose for export: VRM 1.0 T-pose. Standing straight toward +Z, arms along X, palms down
  // (-Y), four fingers straight along X, thumbs 45 degrees between X and +Z. Call with root yaw 0.
  tPose() {
    for (const o of Object.values(this.j)) o.rotation.set(0, 0, 0);
    this.j.shoulderA.rotation.z = -Math.PI / 2;
    this.j.shoulderB.rotation.z = Math.PI / 2;
    // palm faces local +z (fingers curl that way); twisting the wrist about the forearm turns it to -Y
    this.j.wristA.rotation.y = Math.PI / 2;
    this.j.wristB.rotation.y = -Math.PI / 2;
    this.root.updateMatrixWorld(true);
    const down = new THREE.Vector3(0, -1, 0), q = new THREE.Quaternion();
    for (const [side, sx] of [['A', -1], ['B', 1]]) {
      const thumb = this.j['thumb' + side];
      const target = new THREE.Quaternion().setFromUnitVectors(down, new THREE.Vector3(sx, 0, 1).normalize());
      thumb.quaternion.copy(thumb.parent.getWorldQuaternion(q).invert().multiply(target));
    }
    this.root.updateMatrixWorld(true);
  }

  // lowest point of the driver meshes -> ground
  snap() {
    this.parts.position.set(0, 0, 0);
    this.root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.parts, true);
    this.parts.position.y = -box.min.y;
    this.root.updateMatrixWorld(true);
  }
}

// Animation "sources": functions of time that pose the driver rig.
export const MOTIONS = {
  pose: { duration: 1, fps: 2, loop: false, fn: (body, p) => body.pose(p) },
  // talking: the idle body; the mouth shapes are face morph tracks (faceanim.js faceKeys)
  talk: {
    duration: 3, fps: 15,
    fn: (body, p, t) => {
      const w = (2 * Math.PI * t) / 3;
      body.pose(p, p.pose, { fingers: [t, 3], waist: [Math.sin(w) * 0.02, 0, 0], neck: [Math.sin(w * 2) * 0.04, Math.sin(w) * 0.08, 0] });
    },
  },
  idle: {
    duration: 4, fps: 15,
    fn: (body, p, t) => {
      const w = (2 * Math.PI * t) / 4;
      body.pose(p, p.pose, {
        fingers: [t, 4],
        waist: [Math.sin(w) * 0.02, 0, 0],
        neck: [0, Math.sin(w) * 0.12, 0],
        shoulderA: [Math.sin(w * 2) * 0.03, 0, 0],
        shoulderB: [Math.sin(w * 2 + 1) * 0.03, 0, 0],
      });
    },
  },
  walk: {
    duration: 1.1, fps: 20, snapEachFrame: true,
    fn: (body, p, t) => {
      const w = (2 * Math.PI * t) / 1.1, s = Math.sin(w), c = Math.cos(w);
      body.pose(p, 'stand', {
        hipA: [-0.5 * s, 0, 0], hipB: [0.5 * s, 0, 0],
        kneeA: [0.7 * Math.max(0, c), 0, 0], kneeB: [0.7 * Math.max(0, -c), 0, 0],
        shoulderA: [0.4 * s, 0, 0], shoulderB: [-0.4 * s, 0, 0],
        elbowA: [-0.2 - 0.2 * Math.max(0, s), 0, 0], elbowB: [-0.2 - 0.2 * Math.max(0, -s), 0, 0],
        waist: [0.04, 0.1 * s, 0], neck: [0, -0.08 * s, 0],
      });
    },
  },
};

function lathe(pts, maxR) {
  return new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(Math.max(0.001, r), y)), 8).scale(1, 1, 1);
}

function limb(r1, r2, len, seg = 7) {
  return new THREE.CylinderGeometry(r1, r2, len, seg, 2, true).translate(0, -len / 2, 0);
}

function belly(geo, amt, yOff, waistY) {
  if (!amt) return;
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) - yOff, z = pos.getZ(i);
    const w = Math.exp(-(((y - waistY * 0.75) / (waistY * 0.9 + 0.3)) ** 2));
    const front = Math.max(0, z) / (Math.hypot(pos.getX(i), z) || 1);
    pos.setZ(i, z + amt * 0.55 * w * front);
    pos.setX(i, pos.getX(i) * (1 + amt * 0.12 * w));
  }
  geo.computeVertexNormals();
}

function tileUVs(geo) {
  geo.computeBoundingBox();
  const s = new THREE.Vector3();
  geo.boundingBox.getSize(s);
  const around = Math.max(1, Math.round((Math.PI * Math.max(s.x, s.z)) / TILE));
  const along = Math.max(0.3, s.y / TILE);
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * around, uv.getY(i) * along);
}

