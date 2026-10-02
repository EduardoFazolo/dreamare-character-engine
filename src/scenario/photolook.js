// Looks: the same scenes, dressed three ways (terrain.look, a switch per scene; the drawn look stays the
// default and stays exact):
//   (none)    drawn: the canvas textures under the PS2 shader
//   'photo'   PS2 horror: photographs of real surfaces, shrunk to 128-256 px, unfiltered, same shader
//   'source'  Source-engine realism (Garry's Mod, Half-Life 2): real lit materials (512 px photos with normal
//             maps, filtered), a sun / moon that casts shadows, sky fill, ordinary fog, a sharper frame
//
// The drawn textures carry their kind as their name (props.js, gen.js, features.js name them without touching
// any random stream). After a scene is built, applyLook walks it. Photo: every material whose map is a kind we
// have swaps its map. Source: every PS2 material (scenario and characters) is replaced by a standard lit one
// (the original is kept, to go back, and its animated colour is copied over each frame: syncLook). Either way
// the geometry's UVs are re-mapped so a photo tiles at its real size (a drawn blotch could be stretched over a
// 30 m wall; a photo of bricks can't): box projection per triangle, in the object's space times its world
// scale. The terrain keeps its UVs and its biome colours: its photo is grey detail under the vertex colours.
// Photos: public/textures/photo and public/textures/source (CC0, ambientCG; see their READMEs).
import * as THREE from 'three';
import { SCENE } from './material.js';
import { PS2 } from '../head.js';

// kind -> metres covered by one tile of its photo
const KINDS = {
  facade: 3.2, pale: 2, cobble: 2.4, slab: 2.2, wood: 1.6, paint: 1.4, wall: 2.6, roof: 2.2, bark: 1.1, rock: 2.2,
  stone: 2.6, grass: 1, metal: 1.4, leather: 0.18, mud: 0.25, kerb: 1.2,
};
const GLASS = new Set(['window']); // (source: glossy, a little reflective, keeps its drawn frame)
let PHOTOS = null, HD = null, loading = null;

const loadImg = (src) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => ok(null); i.src = src; });
const grey = (img) => { // (the terrain: grey detail, the biome colours come from the vertex colours)
  const c = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height }), g = c.getContext('2d');
  g.filter = 'grayscale(1) brightness(1.45) contrast(1.1)'; g.drawImage(img, 0, 0); return c;
};
const texOf = (src, filtered) => {
  const t = new THREE.Texture(src); t.needsUpdate = true; t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (filtered) { t.anisotropy = 8; } else { t.magFilter = t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; }
  return t;
};
export function loadPhotos() {
  loading ||= Promise.all(Object.keys(KINDS).map(async (k) => {
    const [lo, hi, n, r] = await Promise.all([loadImg(`/textures/photo/${k}.jpg`), loadImg(`/textures/source/${k}.jpg`), loadImg(`/textures/source/${k}_n.jpg`), ['facade', 'cobble', 'slab', 'pale'].includes(k) ? loadImg(`/textures/source/${k}_r.jpg`) : null]);
    return [k, lo && texOf(k === 'grass' ? grey(lo) : lo, false), hi && { map: texOf(k === 'grass' ? grey(hi) : hi, true), normal: n && texOf(n, true), rough: r && texOf(r, true) }];
  })).then((list) => { PHOTOS = new Map(list.filter((e) => e[1]).map((e) => [e[0], e[1]])); HD = new Map(list.filter((e) => e[2]).map((e) => [e[0], e[2]])); });
  return loading;
}

const _s = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _n = new THREE.Vector3(), _e = new THREE.Vector3();
// box-projected UVs, one axis pair per triangle (by its normal), in metres / tile
function boxUV(geo, scale, m) {
  const pa = geo.attributes.position, uv = geo.attributes.uv; if (!uv || geo.index) return;
  geo.userData.drawnUV ||= uv.array.slice();
  for (let i = 0; i < pa.count; i += 3) {
    _a.fromBufferAttribute(pa, i).multiply(scale); _b.fromBufferAttribute(pa, i + 1).multiply(scale); _c.fromBufferAttribute(pa, i + 2).multiply(scale);
    _n.subVectors(_b, _a).cross(_e.subVectors(_c, _a)); const ax = Math.abs(_n.x), ay = Math.abs(_n.y), az = Math.abs(_n.z);
    for (let k = 0; k < 3; k++) {
      const p = k === 0 ? _a : k === 1 ? _b : _c;
      if (ay >= ax && ay >= az) uv.setXY(i + k, p.x / m, p.z / m); // floors, roofs
      else if (ax >= az) uv.setXY(i + k, p.z / m, p.y / m); // walls facing x
      else uv.setXY(i + k, p.x / m, p.y / m); // walls facing z
    }
  }
  uv.needsUpdate = true; geo.userData.photoUV = true;
}
function drawnUV(geo) {
  if (!geo.userData.drawnUV) return;
  geo.attributes.uv.array.set(geo.userData.drawnUV); geo.attributes.uv.needsUpdate = true; delete geo.userData.drawnUV; delete geo.userData.photoUV;
}

// Source: a standard lit material in place of a PS2 one (one per original, shared like the original was)
const converted = new WeakMap();
function sourceMat(src) {
  if (converted.has(src)) return converted.get(src);
  const u = src.uniforms, kind = u.map.value?.name, hd = HD?.get(kind), glow = !!src.defines?.GLOW, op = u.opacity?.value ?? 1;
  const opts = { color: u.color.value.clone(), side: src.side, vertexColors: src.vertexColors, alphaTest: u.alphaTest?.value || 0 };
  if (op < 1) Object.assign(opts, { transparent: true, opacity: op, depthWrite: false });
  const m = glow ? new THREE.MeshBasicMaterial({ ...opts, map: u.map.value })
    : new THREE.MeshStandardMaterial({ ...opts, map: hd ? hd.map : u.map.value, normalMap: hd?.normal || null, roughnessMap: hd?.rough || null, roughness: GLASS.has(kind) ? 0.15 : kind === 'ceramic' ? 0.22 : kind === 'metal' ? 0.55 : kind === 'leather' ? 0.6 : hd?.rough ? 1 : 0.9, metalness: GLASS.has(kind) ? 0.4 : kind === 'metal' ? 0.35 : 0 });
  if (hd?.normal) m.normalScale.set(1.4, 1.4); // (a little deeper: the bricks' mortar should catch the light)
  if (src.name === 'eye') { // eyes: wet, glossy spheres with a real highlight; eyeGlow: a faint light of their own
    m.roughness = 0.12; m.metalness = 0; m.normalMap = null;
    if (src.userData.eyeGlow) { m.emissiveMap = u.map.value; m.emissive = new THREE.Color(1, 1, 1); m.emissiveIntensity = src.userData.eyeGlow; }
  }
  if (src.userData.faceGlow) { m.emissiveMap = u.map.value; m.emissive = new THREE.Color(...(src.userData.glowColor || [1, 0.96, 0.86])); m.emissiveIntensity = src.userData.faceGlow; if (src.userData.glowColor) m.color.setRGB(...src.userData.glowColor); m.color.multiplyScalar(Math.max(0.1, 1 - src.userData.faceGlow * 0.85)); } // (mostly its own light: the scene's sun only shapes it a little, or the top of a ball reads as a pale cap) // (a face that shines: the sun in a children's-TV sky)
  if (src.userData.shade) { m.color.multiplyScalar(1 - src.userData.shade); if (src.name === 'eye') m.color.setScalar(Math.max(0.35, 1 - src.userData.shade)); }
  m.userData = { src, kind, glow, hd: !!hd };
  converted.set(src, m);
  return m;
}

// look: undefined (drawn) | 'photo' | 'source'. Photos must be loaded (loadPhotos()).
export function applyLook(root, look) {
  if (!root) return;
  root.updateWorldMatrix(true, true);
  root.traverse((o) => {
    if (!o.isMesh) return;
    // first, back to the drawn state
    if (o.userData.drawnMaterial) { o.material = o.userData.drawnMaterial; delete o.userData.drawnMaterial; o.castShadow = o.receiveShadow = false; }
    const mat = o.material; if (!mat?.uniforms?.map) return;
    if (mat.userData.drawnMap) { mat.uniforms.map.value = mat.userData.drawnMap; delete mat.userData.drawnMap; }
    const kind = mat.uniforms.map.value?.name, m = KINDS[kind];
    if (!look) { drawnUV(o.geometry); return; }
    const tiled = () => { if (m && o.name !== 'terrain' && !o.geometry.userData.photoUV) { o.getWorldScale(_s); boxUV(o.geometry, _s.clone(), m); } };
    if (look === 'photo') {
      const t = PHOTOS?.get(kind); if (!t) { drawnUV(o.geometry); return; }
      mat.userData.drawnMap = mat.uniforms.map.value; mat.uniforms.map.value = t; tiled();
      return;
    }
    // source
    const sm = sourceMat(mat); o.userData.drawnMaterial = mat; o.material = sm;
    o.castShadow = !sm.userData.glow && !sm.transparent && !(sm.alphaTest > 0) && o.name !== 'terrain'; // (not thin alpha-cut cards: hair strands threw striped shadows onto the neck) o.receiveShadow = !sm.userData.glow;
    if (sm.userData.hd) tiled(); else drawnUV(o.geometry);
  });
}

// each frame in the Source look: animated colours (flickering jars, a lamp that stutters, a room whose light
// goes out) live on the originals' uniforms; copy them over
export function syncLook(root) {
  root?.traverse((o) => {
    const src = o.userData.drawnMaterial; if (!src) return;
    o.material.color.copy(src.uniforms.color.value);
    if (o.material.map !== src.uniforms.map.value && !o.material.userData.hd) o.material.map = src.uniforms.map.value; // (a TV's static)
  });
}

// the Source look's light: the scene's own sun / moon (direction, colour) casting shadows round the camera, its
// ambient as sky fill, and plain distance fog in the scene's fog colour (a little further out than the PS2's)
export function sourceRig(scene, renderer) {
  const sun = new THREE.DirectionalLight(0xffffff, 1), sky = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
  sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03;
  Object.assign(sun.shadow.camera, { left: -45, right: 45, top: 45, bottom: -45, near: 1, far: 260 });
  // point lights where the scene's lamps are (props' `lights`): the nearest MAX to the camera each frame, a
  // fixed count (changing it would recompile every material)
  const MAX = 10, pool = Array.from({ length: MAX }, () => { const l = new THREE.PointLight(0xffffff, 0, 10, 2); return l; });
  let anchors = [], on = false; const _w = new THREE.Vector3();
  return {
    setLights(list) { anchors = list; },
    update(camera, want) {
      if (want !== on) {
        on = want;
        if (on) { scene.add(sun, sun.target, sky, ...pool); renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap; }
        else { scene.remove(sun, sun.target, sky, ...pool); renderer.shadowMap.enabled = false; scene.fog = null; }
        scene.traverse((o) => { if (o.material) [].concat(o.material).forEach((m) => { m.needsUpdate = true; }); });
      }
      if (!on) return;
      sun.color.copy(SCENE.lightCol.value); sun.intensity = 1.0 * Math.PI; // (three's lights are physical: Lambert divides by pi, so match the PS2 shader's brightness)
      sun.target.position.copy(camera.position); sun.position.copy(camera.position).addScaledVector(SCENE.lightDir.value, 120);
      sky.color.copy(SCENE.ambient.value); sky.groundColor.copy(SCENE.ambient.value).multiplyScalar(0.5); sky.intensity = 0.8 * Math.PI; // (darker than the PS2 look: the lamps light the rest)
      const near = anchors.map((a) => { a.at.getWorldPosition(_w); return { a, p: _w.clone(), d: _w.distanceToSquared(camera.position) }; }).sort((x, y) => x.d - y.d);
      pool.forEach((l, i) => { const e = near[i]; if (!e) { l.intensity = 0; return; } l.position.copy(e.p); l.color.setRGB(...e.a.color); l.distance = e.a.distance; l.intensity = e.a.power * (e.a.level ? e.a.level() : 1); });
      scene.fog ||= new THREE.Fog(0, 1, 2); scene.fog.color.copy(PS2.fogColor.value); scene.fog.near = PS2.fogNear.value * 1.3; scene.fog.far = PS2.fogFar.value * 1.6;
    },
  };
}
