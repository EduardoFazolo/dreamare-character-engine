// Meadow: a bright, empty, endless green place under a deep blue sky (terrain.kind 'meadow').
// The opposite of the dunes: no fog to hide in, nothing built, just rolling saturated hills to a far horizon
// and big puffy clouds, their undersides tinted lilac and pink. Depth comes from colour, not from props:
// warm yellow-green on the sunlit slopes, cool blue-green in the hollows and shadows (a blue sky fill),
// a pale blue haze that the far hills sink into, clouds at several distances, and a fine grass texture
// that blurs toward the horizon.
// generate(p) -> the same world shape as gen.js generate. Deterministic in p.seed.
//   p.haze     0..1 how soon the far hills turn blue (default 0.3)
//   p.hills    metres, how tall the rolling hills get (default 7)
//   p.sun      the sun's bearing (radians round y; 0.9 lights things facing the spawn)
//   p.home     [x, z, radius]: one house grown out of the hill, its door and windows a face; the door stands half open on a dim room (p.doorOpen radians)
//   p.puffs    how many clouds (default 28; terrain.clouds is the night cloud banks in mist.js)
import * as THREE from 'three';
import { PS2 } from '../head.js';
import { oldMaterial, SCENE } from './material.js';
import { rng, fbm, vnoise, smooth, lerp, mixC, rgb, canvasTex, css } from './util.js';
import { surfaceNets } from '../sdf.js';

const SKY_TOP = [18, 44, 178], SKY_MID = [44, 112, 228], SKY_LOW = [150, 206, 255];
const SUNLIT = [150, 200, 40], LUSH = [52, 140, 34], HOLLOW = [18, 78, 62], DRY = [178, 172, 52];

export function generate(p) {
  const s = p.seed ?? 1, r = rng(s), group = new THREE.Group();
  const H = p.hills ?? 7, haze = p.haze ?? 0.3;
  const pal = { top: SKY_TOP, fog: SKY_LOW, sun: [0.98, 0.9, 0.74], amb: [0.36, 0.38, 0.6], sunY: 0.7, night: 0, dusk: 0 };

  // light: a high warm sun a little behind the right shoulder, a strong blue sky fill (blue shadows)
  const sunA = p.sun ?? 0.9;
  SCENE.lightDir.value.set(Math.cos(sunA) * 0.6, 0.75, Math.sin(sunA) * 0.6).normalize();
  SCENE.lightCol.value.setRGB(...pal.sun);
  SCENE.ambient.value.setRGB(...pal.amb);
  PS2.fogColor.value.copy(rgb(SKY_LOW));
  PS2.fogNear.value = lerp(140, 30, haze);
  PS2.fogFar.value = lerp(520, 220, haze);

  // ground: long rolling swells, a gentle rise where you stand, the hills growing with distance
  const field = (x, z) => {
    const d = Math.hypot(x, z);
    const big = fbm(x * 0.004, z * 0.004, s) * 2 - 1, roll = fbm(x * 0.014, z * 0.014, s + 7) * 2 - 1, knoll = fbm(x * 0.05, z * 0.05, s + 9) - 0.5;
    const near = smooth(3, 14, d); // flat-ish where you stand, rows of hills rising behind each other further out
    return H * 3.5 * Math.max(big, -0.3) * smooth(60, 380, d) + roll * H * lerp(0.4, 1, smooth(20, 120, d)) * near + knoll * 1.6 * near + 0.8 * (1 - near) + vnoise(x * 0.4, z * 0.4, s + 3) * 0.06;
  };
  // the home (p.home = [x, z, radius]): one house like the children's-TV one: a grass dome, round windows under
  // grassy hoods, and the way in a tunnel: an arched opening at ground level running into the hill. Dropped on the
  // plain field (see houseSolid)
  const home = p.home ? { x: p.home[0], z: p.home[1], r: p.home[2] || 7 } : null;
  const homeDir = home ? new THREE.Vector2(-home.x, -home.z).normalize() : null; // (the door faces the spawn)
  // the floor: just over the highest ground under the rooms (the room in the middle, the passage out to the door),
  // so the plain field never rises into them
  const homeFloor = home ? (() => { let m = -Infinity; for (let i = -12; i <= 12; i++) for (let j = -12; j <= 12; j++) { const x = (i / 12) * home.r * 1.15, z = (j / 12) * home.r * 1.15; if (Math.hypot(x, z) <= home.r * 1.15) m = Math.max(m, field(home.x + x, home.z + z)); } return m + 0.05; })() : 0; // (the house is dropped on the ground: its floor just over the highest ground under it, so the plain field never rises into its rooms and needs no cutting; the dome banks down to the ground all round)
  const domeH = home ? home.r * 0.5 : 0;
  const domeAt = (rho) => homeFloor + domeH * Math.pow(Math.max(0, 1 - rho * rho), 0.7);
  const height = !home ? field : (x, z) => { const rho = Math.hypot(x - home.x, z - home.z) / home.r; return rho < 1 ? Math.max(field(x, z), domeAt(rho)) : field(x, z); };

  const tr = rng(s + 77);
  const grass = canvasTex(128, 128, (g, w, h) => { // blades: high contrast up close, so it shimmers to a blur far off
    g.fillStyle = css([170, 170, 170]); g.fillRect(0, 0, w, h);
    for (let i = 0; i < 2200; i++) { const v = 110 + tr() * 145; g.fillStyle = css([v, v, v], 0.8); g.fillRect(tr() * w | 0, tr() * h | 0, 1, 2 + (tr() * 4 | 0)); }
    for (let i = 0; i < 40; i++) { g.fillStyle = css([255, 255, 230], 0.9); g.fillRect(tr() * w | 0, tr() * h | 0, 1, 1); }
  });
  grass.name = 'grass';

  const colorAt = (x, z) => {
    const y = height(x, z);
    const sl = (height(x + 1, z) - height(x - 1, z)) * Math.cos(sunA) + (height(x, z + 1) - height(x, z - 1)) * Math.sin(sunA); // facing the sun or away
    const hollow = smooth(0.6, -1.6, y - (height(x + 6, z) + height(x - 6, z) + height(x, z + 6) + height(x, z - 6)) / 4 + 0.4);
    let c = mixC(LUSH, SUNLIT, smooth(0.3, 0.75, fbm(x * 0.03, z * 0.03, s + 11)));
    c = mixC(c, DRY, smooth(0.5, 0.72, fbm(x * 0.012, z * 0.012, s + 13)) * 0.85);
    c = mixC(c, HOLLOW, smooth(0.55, 0.75, fbm(x * 0.02, z * 0.02, s + 17)) * 0.6); // dark patches: cloud shadow and rough grass
    c = mixC(c, SUNLIT, smooth(0, -0.8, sl) * 0.5);
    c = mixC(c, HOLLOW, Math.max(hollow * 0.8, smooth(0, 0.9, sl) * 0.55));
    const grit = 0.7 + vnoise(x * 0.3, z * 0.3, s + 21) * 0.45 + (fbm(x * 0.07, z * 0.07, s + 23) - 0.5) * 0.4; // breaks the photo's repeat
    return c.map((v) => (v / 255) * grit * 1.3); // (brighter than drawn: the sun is kept low enough not to clip pale skin)
  };
  const groundMat = oldMaterial({ map: grass, vertexColors: true });
  const sheet = (cx, cz, S, N, drop, hf = height) => { // a square of ground: S metres, N cells a side
    const geo = new THREE.PlaneGeometry(S, S, N, N); geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position, uv = geo.attributes.uv, col = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + cx, z = pos.getZ(i) + cz;
      pos.setXYZ(i, x, hf(x, z) - drop(x, z), z);
      uv.setXY(i, (x * 0.83 + z * 0.56) / 1.9, (z * 0.83 - x * 0.56) / 1.9); // (turned off the view axis, so the photo's repeat doesn't line up into stripes)
      col.set(colorAt(x, z), i * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3)); geo.computeVertexNormals();
    return geo;
  };
  // the field; under the home it sinks a little, out of the way of a finer sheet that carries the dome's shape
  // the field: the plain ground, untouched; the house is dropped on it (see homeFloor)
  const buildGround = () => { const ground = new THREE.Mesh(sheet(0, 0, 900, 300, () => 0, field), groundMat); ground.name = 'terrain'; group.add(ground); };
  // The house as one solid, meshed: the mound, the canopies over the door and the windows smoothly grown out of it
  // (arches: a half-round top on straight sides, down into the ground), and the hollow carved out of all of it (the
  // door's tunnel and the room inside, a shallow recess behind each window). A signed distance field on a grid,
  // polygonised by surface nets (sdf.js): one watertight surface, nothing poking through anything. Past its rim the
  // mound carries on down under the ground, so it meets the field without a gap whichever way the ground runs.
  // Coloured like the field round it.
  const arch = (x, y, r, h) => (y < h ? Math.abs(x) - r : Math.hypot(x, y - h) - r); // (an arch's profile, flat sides below h)
  const houseSolid = (hoods, door) => {
    const R = home.r, cell = 0.08, HB = R * 1.25 + 0.6;
    const ox = home.x - HB, oz = home.z - HB, nx = Math.ceil((HB * 2) / cell) + 1, nz = nx;
    let gLo = Infinity, gHi = -Infinity;
    for (let k = 0; k < nz; k += 4) for (let i = 0; i < nx; i += 4) { const g = field(ox + i * cell, oz + k * cell); gLo = Math.min(gLo, g); gHi = Math.max(gHi, g); }
    const o = { x: ox, y: Math.min(homeFloor, gLo) - 1.2, z: oz };
    const ny = Math.ceil((Math.max(homeFloor + domeH, gHi) + 0.8 - o.y) / cell) + 1;
    const drop = homeFloor - gLo + 0.8; // (how far the mound must go on down past its rim: under the lowest ground near it)
    const local = hoods.map((h) => h.inv.elements);
    const sminK = (a, b, k) => { const hh = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - hh * hh * k * 0.25; };
    const val = new Float32Array(nx * ny * nz);
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const x = o.x + i * cell, y = o.y + j * cell, z = o.z + k * cell;
      const rho = Math.hypot(x - home.x, z - home.z) / R;
      const top = rho < 1 ? domeAt(rho) : homeFloor - drop * smooth(1, 1.14, rho) - (rho - 1) * 4;
      let solid = Math.max((y - top) * 0.6, o.y + cell - y);
      let hole = 1e3;
      hoods.forEach((h, n) => {
        const e = local[n], lx = e[0] * x + e[4] * y + e[8] * z + e[12], ly = e[1] * x + e[5] * y + e[9] * z + e[13], lz = e[2] * x + e[6] * y + e[10] * z + e[14];
        if (h.round) { const rr = Math.hypot(lx, ly); solid = sminK(solid, Math.max(rr - h.a * 1.3, lz - h.front, h.back - lz), 0.35); hole = Math.min(hole, Math.max(rr - h.a * 0.96, lz - (h.front + 1), h.front - 0.1 - lz)); return; } // (a window's round hood and its recess)
        const ry = h.ramp ? ly - h.ramp(lz) : ly; // (the tunnel's floor ramps down to the ground at its mouth)
        solid = sminK(solid, Math.max(arch(lx, ry, h.r + h.wall, h.h), lz - h.front, h.back - lz), 0.45); // (the tunnel's mouth, its front cut flat)
        if (h.kind === 'door') {
          hole = Math.min(hole, Math.max(arch(lx, ry, h.r, h.h), -0.05 - ry, lz - (h.front + 1), door.z0 - 0.02 - lz)); // (the tunnel)
          const bx = Math.abs(lx) - (door.W / 2 + 0.06), by = Math.max(-0.06 - ly, ly - (door.Hr + 0.06)), bz = Math.max(lz - (door.z0 + 0.03), door.z0 - door.D - 0.06 - lz);
          hole = Math.min(hole, Math.max(bx, by, bz)); // (the room)
        } else hole = Math.min(hole, Math.max(arch(lx, ly, h.r, h.h), -0.05 - ly, lz - (h.front + 1), h.front - 0.3 - lz)); // (the window's recess)
      });
      val[i + nx * (j + ny * k)] = Math.max(solid, -hole);
    }
    const mesh = surfaceNets({ nx, ny, nz, o, cell }, val, null);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3)); geo.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    { // normals from the field itself (its gradient: outward everywhere, smooth across the grid), not the faceted mesh's
      const gv = (x, y, z) => { const fi = (x - o.x) / cell, fj = (y - o.y) / cell, fk = (z - o.z) / cell, i = Math.max(0, Math.min(nx - 2, Math.floor(fi))), j = Math.max(0, Math.min(ny - 2, Math.floor(fj))), k = Math.max(0, Math.min(nz - 2, Math.floor(fk))), u = fi - i, v = fj - j, w = fk - k, at = (a, b, c) => val[(i + a) + nx * ((j + b) + ny * (k + c))];
        return at(0, 0, 0) * (1 - u) * (1 - v) * (1 - w) + at(1, 0, 0) * u * (1 - v) * (1 - w) + at(0, 1, 0) * (1 - u) * v * (1 - w) + at(1, 1, 0) * u * v * (1 - w) + at(0, 0, 1) * (1 - u) * (1 - v) * w + at(1, 0, 1) * u * (1 - v) * w + at(0, 1, 1) * (1 - u) * v * w + at(1, 1, 1) * u * v * w; };
      const pa0 = geo.attributes.position, nrm = new Float32Array(pa0.count * 3), hh = cell;
      for (let v = 0; v < pa0.count; v++) { const x = pa0.getX(v), y = pa0.getY(v), z = pa0.getZ(v); const g = [gv(x + hh, y, z) - gv(x - hh, y, z), gv(x, y + hh, z) - gv(x, y - hh, z), gv(x, y, z + hh) - gv(x, y, z - hh)], l = Math.hypot(...g) || 1; nrm.set(g.map((c) => c / l), v * 3); }
      geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
      // and the triangles wound to face along it (surface nets' winding depends on the sign convention)
      const ix = geo.index.array, a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
      let agree = 0; for (let t = 0; t < ix.length; t += 3) { a.fromBufferAttribute(pa0, ix[t]); b.fromBufferAttribute(pa0, ix[t + 1]); c.fromBufferAttribute(pa0, ix[t + 2]); const fnm = b.sub(a).cross(c.sub(a)); agree += Math.sign(fnm.x * nrm[ix[t] * 3] + fnm.y * nrm[ix[t] * 3 + 1] + fnm.z * nrm[ix[t] * 3 + 2]); }
      if (agree < 0) for (let t = 0; t < ix.length; t += 3) { const q = ix[t + 1]; ix[t + 1] = ix[t + 2]; ix[t + 2] = q; }
    }
    const pa = geo.attributes.position, nr = geo.attributes.normal, uv = new Float32Array(pa.count * 2), col = new Float32Array(pa.count * 3);
    for (let v = 0; v < pa.count; v++) {
      const x = pa.getX(v), y = pa.getY(v), z = pa.getZ(v), ax = Math.abs(nr.getX(v)), ay = Math.abs(nr.getY(v)), az = Math.abs(nr.getZ(v));
      const [u, w] = ay >= ax && ay >= az ? [(x * 0.83 + z * 0.56) / 1.9, (z * 0.83 - x * 0.56) / 1.9] : ax >= az ? [z / 1.9, y / 1.9] : [x / 1.9, y / 1.9]; // (the field's own mapping on top, boxed on the canopies' sides)
      uv[v * 2] = u; uv[v * 2 + 1] = w; col.set(colorAt(x, z), v * 3);
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const m = new THREE.Mesh(geo, groundMat); m.name = 'terrain-home';
    return m;
  };
  let roomFloor = () => null; // (inside the home's room and passage: their floor)
  if (home) {
    // where things stand round the mound: az (radians from the door's direction), on the ground at the rim
    const at = (az) => { const c = Math.cos(az), sn = Math.sin(az), dx = homeDir.x * c - homeDir.y * sn, dz = homeDir.x * sn + homeDir.y * c; return [home.x + dx * home.r, home.z + dz * home.r, Math.atan2(dx, dz)]; };
    const rim = oldMaterial({ map: grass, color: [0.85, 0.86, 0.9] });
    const fanTex = canvasTex(64, 64, (g) => { // a round fan window: pale slats spreading from a hub, dark glass between
      g.fillStyle = '#1a2440'; g.fillRect(0, 0, 64, 64); g.translate(32, 32);
      for (let i = 0; i < 14; i++) { g.save(); g.rotate((i / 14) * Math.PI * 2); g.fillStyle = '#e8eef4'; g.beginPath(); g.moveTo(-1.5, 3); g.lineTo(-4, 30); g.lineTo(4, 30); g.lineTo(1.5, 3); g.fill(); g.restore(); }
      g.fillStyle = '#c8d0d8'; g.beginPath(); g.arc(0, 0, 4, 0, 7); g.fill();
    });
    fanTex.magFilter = fanTex.minFilter = THREE.LinearFilter;
    const archPath = (r, h, n = 24) => { const pts = [new THREE.Vector3(r, 0, 0), new THREE.Vector3(r, h, 0)]; for (let i = 1; i < n; i++) { const t = (i / n) * Math.PI; pts.push(new THREE.Vector3(Math.cos(t) * r, h + Math.sin(t) * r, 0)); } pts.push(new THREE.Vector3(-r, h, 0), new THREE.Vector3(-r, 0, 0)); return pts; };
    const archShape = (r, h) => { const sh = new THREE.Shape(); sh.moveTo(-r, 0); sh.lineTo(r, 0); sh.lineTo(r, h); sh.absarc(0, h, r, 0, Math.PI, false); sh.lineTo(-r, 0); return sh; };
    // the canopies: part of the solid (built below); these are their frames: where they sit, the painted rim, the glass
    const hoods = [];
    const hood = (az, r, h, wall, front, back, kind) => {
      const [x, z, yaw] = at(az);
      const g = new THREE.Group(); g.position.set(x, homeFloor, z); g.rotation.y = yaw; group.add(g);
      g.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(archPath(r + 0.03, h).map((v) => v.setZ(front + 0.02)), false, 'catmullrom', 0.05), 48, 0.08, 6, false), rim));
      g.updateMatrixWorld(true);
      const hd = { g, r, h, wall, front, back, kind, inv: g.matrixWorld.clone().invert() }; hoods.push(hd);
      return hd;
    };
    // the door: an arched door at ground level, left half open on a tunnel to a little room in the middle of the
    // mound (real walls, so it moves right as you pass): stained wallpaper, dark boards, a bare bulb, and whoever
    // lives there (an actor placed inside stands on its floor)
    const dr = 1.15, dh = 1.0, door = hood(0, dr, dh, 0.5, 1.1, -home.r * 0.75, 'door');
    const mouthDrop = (() => { const w = door.g.localToWorld(new THREE.Vector3(0, 0, door.front + 0.3)); return Math.max(0, homeFloor - field(w.x, w.z) - 0.02); })(); // (how far below the room's floor the ground is at the tunnel's mouth)
    {
      const W = 3, Hr = 2.4, D = 3.6, z0 = -home.r + D / 2;
      const N = 24, gmax = new Float32Array(N + 1); // (the highest ground across the tunnel along its length, under the floor's own frame)
      for (let n = 0; n <= N; n++) { const lz = z0 + ((door.front + 0.2 - z0) * n) / N; let m = -Infinity; for (let lx = -dr * 1.15; lx <= dr * 1.15; lx += dr * 0.23) { const w = door.g.localToWorld(new THREE.Vector3(lx, 0, lz)); m = Math.max(m, field(w.x, w.z) - homeFloor); } gmax[n] = m + 0.04; }
      const gAt = (lz) => { const f2 = Math.max(0, Math.min(N, ((lz - z0) / (door.front + 0.2 - z0)) * N)), n = Math.min(N - 1, Math.floor(f2)), u = f2 - n; return gmax[n] * (1 - u) + gmax[n + 1] * u; };
      const ramp = (lz) => Math.min(0, Math.max(-mouthDrop * smooth(z0, door.front, lz), gAt(lz))); door.ramp = ramp; const mY = ramp(door.front); // (the tunnel floor: ramping down to the mouth, but never under the ground beneath it, so no grass rises into the tunnel)
      door.g.children[0].position.y = mY; // (the painted arch round the mouth) // (in the door's frame: +z out, y up from the floor; the room's middle under the mound's)
      const paper = canvasTex(128, 128, (g, w, h) => { // faded wallpaper: a mustard floral repeat, damp stains
        g.fillStyle = '#8a7a52'; g.fillRect(0, 0, w, h);
        for (let y = 0; y < h; y += 32) for (let x = (y / 32) % 2 ? 16 : 0; x < w; x += 32) { g.fillStyle = 'rgba(60,46,30,.55)'; for (let k = 0; k < 5; k++) { g.beginPath(); g.ellipse(x + 8 + Math.cos(k * 1.26) * 5, y + 10 + Math.sin(k * 1.26) * 5, 3, 1.6, k * 1.26, 0, 7); g.fill(); } g.fillStyle = 'rgba(120,40,30,.45)'; g.beginPath(); g.arc(x + 8, y + 10, 2, 0, 7); g.fill(); }
        for (let x = 0; x < w; x += 8) { g.fillStyle = 'rgba(40,30,20,.12)'; g.fillRect(x, 0, 1, h); }
        for (let i = 0; i < 9; i++) { const sx = tr() * w, sy = tr() * h, rr = 6 + tr() * 22, gr = g.createRadialGradient(sx, sy, 1, sx, sy, rr); gr.addColorStop(0, 'rgba(50,40,20,.45)'); gr.addColorStop(1, 'rgba(50,40,20,0)'); g.fillStyle = gr; g.fillRect(0, 0, w, h); }
      });
      const boards = canvasTex(64, 64, (g, w, h) => { g.fillStyle = '#3a2a1e'; g.fillRect(0, 0, w, h); for (let x = 0; x < w; x += 8) { g.fillStyle = `rgba(${20 + tr() * 30},${14 + tr() * 20},10,.6)`; g.fillRect(x, 0, 7, h); g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(x + 7, 0, 1, h); } });
      const ceil = canvasTex(32, 32, (g, w, h) => { g.fillStyle = '#9a8e70'; g.fillRect(0, 0, w, h); for (let i = 0; i < 40; i++) { g.fillStyle = 'rgba(70,60,40,.25)'; g.fillRect(tr() * w, tr() * h, 3, 2); } });
      for (const t of [paper, boards, ceil]) t.name = 'room'; // (not a photo kind: the drawn textures stay in every look)
      const room = new THREE.Group(); door.g.add(room);
      const dim = [0.6, 0.57, 0.53]; // (the room is gloomy: no window, one weak bulb)
      const wall = (w, h, tex, rep, x, y, z, ry, rx = 0) => { const geo = new THREE.PlaneGeometry(w, h); geo.attributes.uv.array.forEach((v, i, arr) => { arr[i] = v * (i % 2 ? h : w) / rep; }); const m = new THREE.Mesh(geo, oldMaterial({ map: tex, color: dim })); m.position.set(x, y, z); m.rotation.set(rx, ry, 0); room.add(m); return m; };
      wall(W, Hr, paper, 0.9, 0, Hr / 2, z0 - D, 0); // the back wall
      wall(D, Hr, paper, 0.9, -W / 2, Hr / 2, z0 - D / 2, Math.PI / 2); wall(D, Hr, paper, 0.9, W / 2, Hr / 2, z0 - D / 2, -Math.PI / 2);
      wall(W, D, boards, 1.2, 0, 0.01, z0 - D / 2, 0, -Math.PI / 2); wall(W, D, ceil, 1, 0, Hr, z0 - D / 2, 0, Math.PI / 2);
      { // the front wall, with the arched hole the tunnel comes through
        const sh = new THREE.Shape(); sh.moveTo(-W / 2, 0); sh.lineTo(W / 2, 0); sh.lineTo(W / 2, Hr); sh.lineTo(-W / 2, Hr); sh.lineTo(-W / 2, 0);
        const ho = new THREE.Path(); ho.moveTo(-dr, 0.001); ho.lineTo(-dr, dh); ho.absarc(0, dh, dr, Math.PI, 0, true); ho.lineTo(dr, 0.001); ho.lineTo(-dr, 0.001); sh.holes.push(ho);
        const geo = new THREE.ShapeGeometry(sh, 24); geo.attributes.uv.array.forEach((v, i, arr) => { arr[i] = v / 0.9; });
        const m = new THREE.Mesh(geo, oldMaterial({ map: paper, color: dim, side: THREE.DoubleSide })); m.position.z = z0; room.add(m);
      }
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), oldMaterial({ map: ceil, glow: true, color: [1, 0.85, 0.55] })); bulb.position.set(0.4, Hr - 0.35, z0 - D * 0.55); room.add(bulb);
      const flex = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.3, 4), oldMaterial({ map: boards, color: [0.2, 0.2, 0.2] })); flex.position.set(0.4, Hr - 0.17, z0 - D * 0.55); room.add(flex); // (the bulb's flex)
      // the door itself: arched, painted planks, hinged on its left and swung half open
      const paint = canvasTex(64, 64, (g, w, h) => { g.fillStyle = '#c9c2ae'; g.fillRect(0, 0, w, h); for (let x = 0; x < w; x += 8) { g.fillStyle = 'rgba(80,70,50,.35)'; g.fillRect(x, 0, 1, h); } for (let i = 0; i < 30; i++) { g.fillStyle = 'rgba(90,80,60,.35)'; g.fillRect(tr() * w, tr() * h, 2, 1 + tr() * 3); } });
      paint.name = 'room';
      const hinge = new THREE.Group(); hinge.position.set(-dr * 0.97, mY, door.front - 0.12); hinge.rotation.y = -(p.doorOpen ?? 0.95); door.g.add(hinge);
      const pg = new THREE.ExtrudeGeometry(archShape(dr * 0.96, dh), { depth: 0.07, bevelEnabled: false, curveSegments: 16 }).translate(dr * 0.96, 0, -0.035);
      { const pu = pg.attributes.uv; for (let i = 0; i < pu.count; i++) pu.setXY(i, pu.getX(i) * 0.5, pu.getY(i) * 0.5); }
      hinge.add(new THREE.Mesh(pg, oldMaterial({ map: paint })));
      const knob = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 4), oldMaterial({ map: paint, color: [0.75, 0.6, 0.3] })); knob.position.set(dr * 1.7, dh * 0.9, 0.06); hinge.add(knob);
      // the tunnel from the door to the room: lined with dark earth (a few cm inside its carved hole), floored with boards
      const lenP = door.front - z0, earth = oldMaterial({ map: boards, color: [0.42, 0.36, 0.3], side: THREE.DoubleSide });
      const lsh = new THREE.Shape(); lsh.moveTo(-(dr - 0.04), 0); lsh.lineTo(-(dr - 0.04), dh); lsh.absarc(0, dh, dr - 0.04, Math.PI, 0, true); lsh.lineTo(dr - 0.04, 0);
      const lpts = lsh.getPoints(24), lg = new THREE.BufferGeometry(), lp3 = [], li = [];
      { // rings along the tunnel, each lifted by the floor's ramp there, so the lining's foot always sits on the boards
        const M = 24, P = lpts.length, uvs = [];
        for (let m = 0; m <= M; m++) { const lz = z0 + ((door.front - 0.05 - z0) * m) / M, y0 = ramp(lz); lpts.forEach((q, n) => { lp3.push(q.x, q.y + y0, lz); uvs.push(n / 6, (lz - z0) / 1.2); }); }
        for (let m = 0; m < M; m++) for (let n = 0; n + 1 < P; n++) { const a0 = m * P + n, b0 = a0 + P; li.push(a0, b0, a0 + 1, a0 + 1, b0, b0 + 1); }
        lg.setAttribute('position', new THREE.Float32BufferAttribute(lp3, 3)); lg.setIndex(li); lg.computeVertexNormals(); lg.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      }
      door.g.add(new THREE.Mesh(lg, earth));
      { const fg = new THREE.PlaneGeometry(dr * 1.9, lenP, 1, 24).rotateX(-Math.PI / 2).translate(0, 0.01, z0 + lenP / 2), fp = fg.attributes.position; for (let i = 0; i < fp.count; i++) fp.setY(i, 0.01 + ramp(fp.getZ(i))); fg.computeVertexNormals(); door.g.add(new THREE.Mesh(fg, oldMaterial({ map: boards }))); } // (the boards, following the ramp)
      Object.assign(door, { W, Hr, D, z0 }); // (for the solid's hollow)
      door.g.updateMatrixWorld(true);
      const inv = door.g.matrixWorld.clone().invert(), lp = new THREE.Vector3();
      roomFloor = (x, z) => { lp.set(x, 0, z).applyMatrix4(inv); return (Math.abs(lp.x) < W / 2 && lp.z < z0 && lp.z > z0 - D) || (Math.abs(lp.x) < dr && lp.z >= z0 && lp.z < door.front) ? homeFloor + (lp.z >= z0 ? ramp(lp.z) : 0) : null; };
    }
    for (const side of [-1, 1]) { // the windows: round, up on the dome, each under a grassy hood
      const az = side * 0.55, rho = 0.66, a = home.r * 0.12, len = home.r * 0.4, c = Math.cos(az), sn = Math.sin(az), dx = homeDir.x * c - homeDir.y * sn, dz = homeDir.x * sn + homeDir.y * c;
      const g = new THREE.Group(); g.position.set(home.x + dx * rho * home.r, Math.max(domeAt(rho) - a * 0.15, homeFloor + a * 0.85), home.z + dz * rho * home.r); g.rotation.y = Math.atan2(dx, dz); group.add(g);
      const front = len * 0.25 + 0.01;
      g.add(new THREE.Mesh(new THREE.TorusGeometry(a * 0.93, a * 0.07, 6, 24).translate(0, 0, front), rim));
      g.add(new THREE.Mesh(new THREE.CircleGeometry(a * 0.9, 24).translate(0, 0, front - 0.03), oldMaterial({ map: fanTex, glow: true, color: [0.95, 0.95, 1] })));
      g.updateMatrixWorld(true);
      hoods.push({ g, round: true, a, front, back: -len * 0.75, kind: 'window', inv: g.matrixWorld.clone().invert() });
    }
    group.add(houseSolid(hoods, door));
  }

  buildGround();

  // sky: a deep gradient dome, darkest straight up, pale where it meets the haze at the horizon
  {
    const sky = canvasTex(8, 256, (g, w, h) => {
      for (let y = 0; y < h; y++) {
        const el = 1 - y / h, up = smooth(0.5, 1, el);
        const c = up < 0.35 ? mixC(SKY_LOW, SKY_MID, up / 0.35) : mixC(SKY_MID, SKY_TOP, (up - 0.35) / 0.65);
        g.fillStyle = css(c); g.fillRect(0, y, w, 1);
      }
    });
    sky.magFilter = sky.minFilter = THREE.LinearFilter;
    const dome = new THREE.Mesh(new THREE.SphereGeometry(600, 32, 24), new THREE.MeshBasicMaterial({ map: sky, side: THREE.BackSide, fog: false, depthWrite: false }));
    dome.name = 'sky'; dome.renderOrder = -2; group.add(dome);
  }

  // clouds: painted cumulus cards at several distances, always turned to the camera, drifting slowly
  const clouds = [];
  {
    const cardTex = (seed) => { // cumulus from noise: a heaped density, lit from above, lilac and pink where it thins below
      const cr = rng(seed), so = Math.floor(cr() * 1000), lumps = Array.from({ length: 7 }, () => [0.2 + cr() * 0.6, 0.35 + cr() * 0.3, 0.12 + cr() * 0.16]);
      const W = 256, Hh = 160, dens = (u, v) => {
        let m = 0; for (const [cx, cy, rr] of lumps) m = Math.max(m, 1 - Math.hypot((u - cx) / rr, (v - cy) / (rr * 1.15)));
        m -= smooth(0.62, 0.8, v) * 1.2; // the flat base
        m -= (1 - smooth(0, 0.14, u) * smooth(1, 0.86, u) * smooth(0, 0.16, v)) * 1.5; // never touching the card's edges
        return m + (fbm(u * 9, v * 9, so) - 0.5) * 0.55 + (vnoise(u * 30, v * 30, so + 4) - 0.5) * 0.12;
      };
      const t = canvasTex(W, Hh, (g, w, h) => {
        const img = g.createImageData(w, h);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const u = x / w, v = y / h, dd = dens(u, v); if (dd <= 0) continue;
          const lit = smooth(-0.1, 0.3, dens(u, v + 0.04) - dens(u, v - 0.04) + (0.55 - v) * 0.6); // brighter where the cloud faces up
          let c = mixC([160, 150, 212], [255, 252, 246], lit);
          c = mixC(c, [255, 176, 208], smooth(0.5, 0.75, v) * (1 - lit) * 0.55); // a pink warmth in the low shade
          const a = smooth(0, 0.22, dd), i = (y * w + x) * 4;
          img.data[i] = c[0]; img.data[i + 1] = c[1]; img.data[i + 2] = c[2]; img.data[i + 3] = a * 255;
        }
        g.putImageData(img, 0, 0);
      });
      t.magFilter = t.minFilter = THREE.LinearFilter;
      return t;
    };
    const n = p.puffs ?? 28;
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2, d = 170 + r() * 330, w = 60 + r() * 110 * (d / 300);
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, w * 0.625), new THREE.MeshBasicMaterial({ map: cardTex(s * 31 + i), transparent: true, depthWrite: false, fog: false }));
      m.position.set(Math.cos(a) * d, 12 + r() * r() * 110 + d * 0.06, Math.sin(a) * d); m.renderOrder = -1; m.name = 'cloud';
      clouds.push({ m, a, d, y: m.position.y, v: (0.3 + r() * 0.5) / d });
      group.add(m);
    }
  }
  const update = (t, cam) => {
    for (const c of clouds) {
      const a = c.a + t * c.v;
      c.m.position.set(Math.cos(a) * c.d + (cam?.x || 0) * 0.9, c.y, Math.sin(a) * c.d + (cam?.z || 0) * 0.9);
      if (cam) c.m.lookAt(cam.x, c.y * 0.6, cam.z);
    }
  };
  update(0);

  const floor = (x, z) => roomFloor(x, z) ?? height(x, z), walkable = (x, z) => Math.hypot(x, z) < 400;
  return { group, height, floor, walkable, solids: [], spawn: new THREE.Vector3(0, height(0, 0) + 1.7, 0), palette: pal, homeYaw: 0, update, biome: { archetype: 'meadow' }, roads: [] };
}
