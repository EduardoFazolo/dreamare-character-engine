import * as THREE from 'three';
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

let landmarker;

export async function initLandmarker() {
  const fileset = await FilesetResolver.forVisionTasks('/wasm');
  const make = (delegate) =>
    FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: '/models/face_landmarker.task', delegate },
      runningMode: 'IMAGE',
      numFaces: 1,
    });
  try {
    landmarker = await make('GPU');
  } catch {
    landmarker = await make('CPU');
  }
}

// Canonical MediaPipe face mesh: 468 verts, same indexing as the detected landmarks.
// Positions are normalized so face width (234 -> 454) = 1, centered between forehead and chin.
export async function loadCanonical() {
  const txt = await (await fetch('/models/canonical_face_model.obj')).text();
  const v = [], vt = [], faces = [];
  for (const line of txt.split('\n')) {
    const s = line.trim().split(/\s+/);
    if (s[0] === 'v') v.push(s.slice(1, 4).map(Number));
    else if (s[0] === 'vt') vt.push(s.slice(1, 3).map(Number));
    else if (s[0] === 'f') faces.push(s.slice(1).map((p) => p.split('/').map((n) => Number(n) - 1)));
  }
  const uv = new Array(v.length);
  const index = [];
  for (const f of faces) for (const [vi, ti] of f) { uv[vi] = vt[ti]; index.push(vi); }
  return { pos: normalizeFace(v), uv, index };
}

export function normalizeFace(P) {
  const w = Math.hypot(P[454][0] - P[234][0], P[454][1] - P[234][1], P[454][2] - P[234][2]);
  const cx = (P[234][0] + P[454][0]) / 2;
  const cy = (P[10][1] + P[152][1]) / 2;
  const cz = (P[234][2] + P[454][2]) / 2;
  return P.map((p) => [(p[0] - cx) / w, (p[1] - cy) / w, (p[2] - cz) / w]);
}

export async function makeFace(img, name) {
  const res = landmarker.detect(img);
  const raw = res.faceLandmarks[0];
  if (!raw) return null;
  const lm = raw.slice(0, 468).map((p) => [p.x, p.y, p.z]);
  const aspect = img.naturalHeight / img.naturalWidth;
  // photo-derived 3D: image x right, y up, z toward viewer
  const geo = normalizeFace(lm.map(([x, y, z]) => [x, -y * aspect, -z]));
  const tex = new THREE.Texture(img);
  tex.needsUpdate = true;
  return { name, img, lm, geo, tex, skin: sampleSkin(img, lm) };
}

function sampleSkin(img, lm) {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  let r = 0, gg = 0, b = 0, n = 0;
  for (const i of [151, 50, 280, 205, 425, 9]) {
    const d = g.getImageData(Math.round(lm[i][0] * c.width) - 3, Math.round(lm[i][1] * c.height) - 3, 7, 7).data;
    for (let k = 0; k < d.length; k += 4) { r += d[k]; gg += d[k + 1]; b += d[k + 2]; n++; }
  }
  return [r / n / 255, gg / n / 255, b / n / 255];
}

export function loadImage(src) {
  return new Promise((ok, fail) => {
    const img = new Image();
    img.onload = () => ok(img);
    img.onerror = fail;
    img.src = src;
  });
}
