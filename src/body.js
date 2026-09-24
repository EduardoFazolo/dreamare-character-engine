import * as THREE from 'three';
import { ps2Material } from './head.js';

// Crude jointed humanoid in "head units" (face width = 1). Segments are low-poly lathes and
// cylinders; the look comes from photo textures + wrong proportions, same trick as the face.

const TILE = 0.9; // texture tile size in head units

export const OUTFITS = {
  suit: { top: 'Fabric039', bottom: 'Fabric039', shoes: 'Leather026' },
  undertaker: { top: 'Fabric042', bottom: 'Fabric042', shoes: 'Leather026' },
  gunslinger: { top: 'Fabric042', bottom: 'Fabric022', shoes: 'Leather033C' },
  fur: { top: 'Carpet011', bottom: 'Carpet011', shoes: 'skin', hue: -35, sat: 1.5, girth: 1.25 },
  shag: { top: 'Carpet012', bottom: 'Carpet012', shoes: 'skin', girth: 1.2 },
  denim: { top: 'Fabric022', bottom: 'Fabric023', shoes: 'Leather033C' },
  knit: { top: 'Fabric040', bottom: 'Fabric025', shoes: 'Leather037' },
  sweater: { top: 'Fabric018', bottom: 'Fabric039', shoes: 'Leather026' },
  farmer: { top: 'Fabric054', bottom: 'Fabric023', shoes: 'Leather033C' },
  clown: { top: 'Fabric055', bottom: 'Fabric076', shoes: 'Leather037', feet: 1.7 },
  prisoner: { top: 'Fabric071', bottom: 'Fabric071', shoes: 'Leather026' },
  velvet: { top: 'Fabric028', bottom: 'Fabric051', shoes: 'Leather026' },
  naked: { top: 'skin', bottom: 'skin', shoes: 'skin' },
};

// joint rotations; A = character's right side (-x), B = left (+x)
export const POSES = {
  stand: { waist: 0.04, neck: 0.05, sh: [0.05, 0.1], el: -0.15, hip: [0, 0.04], knee: 0.05 },
  hunch: { waist: 0.5, neck: 0.45, sh: [-0.35, 0.12], el: -0.35, hip: [-0.25, 0.07], knee: 0.4 },
  crouch: { waist: 0.75, neck: 0.25, sh: [-1.05, 0.22], el: -0.2, hip: [-1.75, 0.28], knee: 2.2 },
  gunslinger: { waist: 0, neck: 0.02, sh: [0.05, 0.12], el: -0.2, shA: [-1.4, 0.15], elA: -0.05, hip: [0, 0.12], knee: 0.05, gun: true },
  zombie: { waist: 0.12, neck: 0.3, sh: [-1.45, 0.06], el: -0.1, hip: [0, 0.05], knee: 0.12 },
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

  // small noisy tile in the face's skin tone, for hands, neck and bare skin
  skinTexture([r, g, b]) {
    if (!this.skinTex) {
      const c = document.createElement('canvas');
      c.width = c.height = 16;
      this.skinTex = new THREE.CanvasTexture(c);
      this.skinTex.wrapS = this.skinTex.wrapT = THREE.RepeatWrapping;
      this.skinTex.magFilter = this.skinTex.minFilter = THREE.NearestFilter;
    }
    const c = this.skinTex.image, ctx = c.getContext('2d');
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const n = 0.9 + Math.random() * 0.2;
      ctx.fillStyle = `rgb(${[r, g, b].map((v) => Math.min(255, v * n * 255) | 0).join(',')})`;
      ctx.fillRect(x, y, 1, 1);
    }
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
    head.position.set(0, 0.6 * p.headScale, 0.22 * p.headScale);
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

    const pelvis = joint('pelvis', this.parts, 0, 0, 0);
    const abdomen = mesh(lathe([[0.02, -0.28], [hipR * 0.85, -0.22], [hipR, 0.1], [waistR, waistY]], hipR), 'bottom', pelvis);
    abdomen.scale.z = DEPTH;
    belly(abdomen.geometry, p.belly * g, 0, waistY);

    const waist = joint('waist', pelvis, 0, waistY, 0);
    const filler = mesh(new THREE.SphereGeometry(waistR, 8, 6), 'top', waist);
    filler.scale.z = DEPTH;
    const chest = mesh(lathe([[waistR, 0], [chestR, chestH * 0.45], [sh * 0.92, chestH * 0.86], [neckR * 1.3, chestH], [0.02, chestH + 0.02]], sh), 'top', waist);
    chest.scale.z = DEPTH;
    belly(chest.geometry, p.belly * g, -waistY, waistY);

    const neck = joint('neck', waist, 0, chestH - 0.12, 0);
    mesh(new THREE.CylinderGeometry(neckR, neckR * 1.15, p.neckLen + 0.3, 7, 1, true).translate(0, (p.neckLen + 0.3) / 2, 0), 'skin', neck);
    this.headAnchor.position.set(0, p.neckLen + 0.2, 0);
    neck.add(this.headAnchor);

    const armLen = p.armLen, ua = 1.7 * armLen, fa = 1.55 * armLen;
    for (const [side, sx] of [['A', -1], ['B', 1]]) {
      const shoulder = joint('shoulder' + side, waist, sx * sh * 0.8, chestH * 0.8, 0);
      mesh(new THREE.SphereGeometry(0.27 * g, 7, 5), 'top', shoulder);
      mesh(limb(0.26 * g, 0.2 * g, ua), 'top', shoulder);
      const elbow = joint('elbow' + side, shoulder, 0, -ua, 0);
      mesh(new THREE.SphereGeometry(0.2 * g, 7, 5), 'top', elbow);
      mesh(limb(0.2 * g, 0.15 * g, fa), 'top', elbow);
      const wrist = joint('wrist' + side, elbow, 0, -fa, 0);
      this.hand(wrist, p, sx, mesh, side);
      if (side === 'A' && POSES[p.pose]?.gun) this.revolver(wrist, p.handSize, mesh);

      const hip = joint('hip' + side, pelvis, sx * hipR * 0.5, -0.1, 0);
      const th = 2.1 * p.legLen, shin = 2.0 * p.legLen;
      mesh(limb(0.36 * g, 0.26 * g, th), 'bottom', hip);
      const knee = joint('knee' + side, hip, 0, -th, 0);
      mesh(new THREE.SphereGeometry(0.26 * g, 7, 5), 'bottom', knee);
      mesh(limb(0.26 * g, 0.18 * g, shin), 'bottom', knee);
      const ankle = joint('ankle' + side, knee, 0, -shin, 0);
      const fs = p.footSize * (outfit.feet || 1);
      mesh(new THREE.BoxGeometry(0.36 * fs * Math.sqrt(g), 0.26, 0.85 * fs).translate(0, -0.1, 0.22 * fs), 'shoes', ankle, false);
    }
  }

  hand(wrist, p, sx, mesh, side) {
    const hs = p.handSize;
    const palm = new THREE.BoxGeometry(0.34 * hs, 0.42 * hs, 0.13 * hs).translate(0, -0.21 * hs, 0);
    mesh(palm, 'skin', wrist);
    const fl = 0.38 * p.fingerLen * hs;
    for (let i = 0; i < 4; i++) {
      const f = new THREE.Group();
      f.position.set((i - 1.5) * 0.085 * hs, -0.4 * hs, 0);
      f.rotation.set(-0.25 - i * 0.05, 0, (i - 1.5) * 0.06);
      f.userData.joint = `finger${side}${i}`;
      this.j[f.userData.joint] = f;
      mesh(limb(0.04 * hs, 0.03 * hs, fl * (i === 0 || i === 3 ? 0.85 : 1), 5), 'skin', f);
      wrist.add(f);
    }
    const thumb = new THREE.Group();
    thumb.position.set(-sx * 0.17 * hs, -0.18 * hs, 0.04 * hs);
    thumb.rotation.set(-0.5, 0, -sx * 0.6);
    thumb.userData.joint = `thumb${side}`;
    this.j[thumb.userData.joint] = thumb;
    mesh(limb(0.045 * hs, 0.035 * hs, fl * 0.7, 5), 'skin', thumb);
    wrist.add(thumb);
  }

  revolver(wrist, hs, mesh) {
    const gun = new THREE.Group();
    gun.position.set(0, -0.3 * hs, 0.12 * hs);
    mesh(new THREE.BoxGeometry(0.12, 0.34, 0.16).translate(0, 0, -0.04), 'metal', gun, false); // grip
    const barrel = mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.75, 6).translate(0, -0.3, 0), 'metal', gun, false);
    barrel.rotation.x = Math.PI / 2 - 0.1;
    barrel.position.set(0, 0.12, 0.05);
    const drum = mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.2, 7), 'metal', gun, false);
    drum.rotation.x = Math.PI / 2; drum.position.set(0, 0.12, 0.12);
    gun.rotation.x = -Math.PI / 2 + 0.1;
    wrist.add(gun);
  }

  // Poses/animations are written as driver-joint rotations; rig.js converts them to bone tracks.
  pose(p, poseName = p.pose, extra = {}) {
    const P = POSES[poseName] || POSES.stand, j = this.j;
    const out = 0.06 + p.girth * 0.05 + Math.max(0, p.belly) * 0.06;
    const set = (name, x, y = 0, z = 0) => {
      const e = extra[name] || [0, 0, 0];
      j[name].rotation.set(x + e[0], y + e[1], z + e[2]);
    };
    set('waist', P.waist + p.hunch * 0.5);
    set('neck', P.neck + p.hunch * 0.4);
    for (const [side, sx] of [['A', -1], ['B', 1]]) {
      const shp = (side === 'A' && P.shA) || P.sh, el = side === 'A' && P.elA !== undefined ? P.elA : P.el;
      set('shoulder' + side, shp[0], 0, sx * (shp[1] + out));
      set('elbow' + side, el);
      set('hip' + side, P.hip[0], 0, sx * P.hip[1]);
      set('knee' + side, P.knee);
      const e = (k) => (extra[k + side] || [0])[0];
      set('ankle' + side, -(P.hip[0] + e('hip') + P.knee + e('knee')));
    }
    // head keeps looking forward-ish
    set('head', -(j.waist.rotation.x + j.neck.rotation.x) * 0.85);
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
  idle: {
    duration: 4, fps: 15,
    fn: (body, p, t) => {
      const w = (2 * Math.PI * t) / 4;
      body.pose(p, p.pose, {
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

