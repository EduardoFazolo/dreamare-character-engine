import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

// Export the baked SkinnedCharacter as a binary glTF. The PS2 shader can't travel between
// engines, so materials become unlit textures with the grade/tint baked into the pixels.
export async function exportGLB(sk, atlasCanvas) {
  const atlasTex = new THREE.CanvasTexture(atlasCanvas);
  atlasTex.magFilter = atlasTex.minFilter = THREE.NearestFilter;
  const originals = [];
  for (const m of sk.meshes) {
    const u = m.material.uniforms;
    let map = u.map.value;
    const color = u.color.value.clone();
    if (map?.isRenderTargetTexture) map = atlasTex;
    else if (map?.isDataTexture) map = null;
    else if (map && (u.hueShift.value !== 0 || u.satMul.value !== 1 || !color.equals(new THREE.Color(1, 1, 1)))) {
      map = tinted(map, u.hueShift.value, u.satMul.value, color);
    }
    const mat = new THREE.MeshBasicMaterial({
      name: m.material.name, map, color: map ? 0xffffff : color,
      alphaTest: u.alphaTest.value, side: m.material.side,
    });
    originals.push([m, m.material]);
    m.material = mat;
  }
  sk.skeleton.pose(); // node transforms = T-pose bind, which retargeters read as the rest pose
  try {
    return await new GLTFExporter().parseAsync(sk.content, { binary: true, animations: sk.clips, onlyVisible: true });
  } finally {
    for (const [m, mat] of originals) { m.material.dispose(); m.material = mat; }
    sk.update(0);
  }
}

function tinted(tex, hueDeg, sat, color) {
  const img = tex.image;
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height);
  const a = (hueDeg * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
  for (let i = 0; i < d.data.length; i += 4) {
    const r = d.data[i] / 255, gg = d.data[i + 1] / 255, b = d.data[i + 2] / 255;
    const y = 0.299 * r + 0.587 * gg + 0.114 * b;
    let I = 0.596 * r - 0.274 * gg - 0.322 * b, Q = 0.211 * r - 0.523 * gg + 0.312 * b;
    [I, Q] = [(I * ca - Q * sa) * sat, (I * sa + Q * ca) * sat];
    d.data[i] = 255 * Math.min(1, Math.max(0, (y + 0.956 * I + 0.621 * Q) * color.r));
    d.data[i + 1] = 255 * Math.min(1, Math.max(0, (y - 0.272 * I - 0.647 * Q) * color.g));
    d.data[i + 2] = 255 * Math.min(1, Math.max(0, (y - 1.106 * I + 1.703 * Q) * color.b));
  }
  g.putImageData(d, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = t.minFilter = THREE.NearestFilter;
  return t;
}
