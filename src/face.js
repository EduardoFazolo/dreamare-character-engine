import * as THREE from 'three';
import { FaceLandmarker, FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision';

let landmarker, segmenter;

export async function initLandmarker() {
  const fileset = await FilesetResolver.forVisionTasks('/wasm');
  // multiclass selfie segmenter: 0 background, 1 hair, 2 body skin, 3 face skin, 4 clothes, 5 other
  const makeSeg = (delegate) => ImageSegmenter.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: '/models/selfie_multiclass_256x256.tflite', delegate },
    runningMode: 'IMAGE', outputCategoryMask: true, outputConfidenceMasks: false,
  });
  try { segmenter = await makeSeg('GPU'); } catch { segmenter = await makeSeg('CPU'); }
  // warm up now (first run compiles GPU programs for seconds), not on the first rebuild
  const warm = document.createElement('canvas');
  warm.width = warm.height = 64;
  warm.getContext('2d').fillRect(0, 0, 64, 64);
  segmenter.segment(warm, () => {});
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

// The person's real hair, read from the photo once per face (lazily, cached): its color, a small
// texture patch of it, and a best guess at the hairstyle from where hair sits around the face.
export function analyzeHair(face) {
  if (face.hair) return face.hair;
  let cat, w, h;
  segmenter.segment(face.img, (res) => {
    const m = res.categoryMask;
    w = m.width; h = m.height; cat = m.getAsUint8Array().slice();
  });
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(face.img, 0, 0, w, h);
  const px = g.getImageData(0, 0, w, h).data;
  const lm = face.lm;
  const top = lm[10][1] * h, chin = lm[152][1] * h, left = lm[234][0] * w, right = lm[454][0] * w;
  const fw = right - left, eyeY = ((lm[33][1] + lm[263][1]) / 2) * h;
  const frac = (x0, y0, x1, y1) => {
    let n = 0, hair = 0;
    for (let y = Math.max(0, y0 | 0); y < Math.min(h, y1); y++) for (let x = Math.max(0, x0 | 0); x < Math.min(w, x1); x++) {
      n++; if (cat[y * w + x] === 1) hair++;
    }
    return n ? hair / n : 0;
  };
  const cover = {
    top: frac(left - 0.1 * fw, top - 0.45 * fw, right + 0.1 * fw, top),
    crown: frac(left + 0.3 * fw, top - 0.3 * fw, right - 0.3 * fw, top),
    fringe: frac(left + 0.2 * fw, top, right - 0.2 * fw, top + 0.2 * (chin - top)),
    sides: (frac(left - 0.25 * fw, eyeY, left, chin) + frac(right, eyeY, right + 0.25 * fw, chin)) / 2,
    long: (frac(left - 0.3 * fw, chin, left, chin + 0.5 * fw) + frac(right, chin, right + 0.3 * fw, chin + 0.5 * fw)) / 2,
  };
  const style = cover.top < 0.12 && cover.sides < 0.12 ? 'bald'
    : cover.crown < 0.25 && cover.sides > 0.2 ? 'horseshoe'
    : cover.long > 0.25 ? 'long'
    : cover.fringe > 0.35 ? 'bowl'
    : cover.top < 0.35 ? 'buzz' : 'short';

  // color: median (by brightness) of the hair pixels
  const cols = [];
  for (let i = 0; i < cat.length; i += 3) if (cat[i] === 1) cols.push([px[i * 4], px[i * 4 + 1], px[i * 4 + 2]]);
  cols.sort((a, b) => a[0] + a[1] + a[2] - (b[0] + b[1] + b[2]));
  const color = cols.length > 30 ? cols[cols.length >> 1].map((v) => v / 255) : [0.16, 0.12, 0.09];

  // texture: the hairiest window above/beside the face, non-hair pixels replaced by the hair color
  const s = Math.max(8, 0.22 * fw);
  let best = null, bestF = -1;
  for (let y = top - 0.5 * fw; y < chin; y += s / 3) for (let x = left - 0.35 * fw; x < right + 0.35 * fw; x += s / 3) {
    const f = frac(x, y, x + s, y + s);
    if (f > bestF) { bestF = f; best = [x, y]; }
  }
  const patch = document.createElement('canvas');
  patch.width = patch.height = 64;
  const pg = patch.getContext('2d');
  const img = pg.createImageData(64, 64);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const sx = Math.min(w - 1, Math.max(0, (best[0] + (x / 64) * s) | 0)), sy = Math.min(h - 1, Math.max(0, (best[1] + (y / 64) * s) | 0));
    const i = sy * w + sx, o = (y * 64 + x) * 4, n = 0.85 + 0.3 * (((Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1 + 1) % 1);
    const hair = cat[i] === 1 && bestF > 0.2;
    img.data[o] = hair ? px[i * 4] : color[0] * 255 * n;
    img.data[o + 1] = hair ? px[i * 4 + 1] : color[1] * 255 * n;
    img.data[o + 2] = hair ? px[i * 4 + 2] : color[2] * 255 * n;
    img.data[o + 3] = 255;
  }
  pg.putImageData(img, 0, 0);

  face.hair = { style, color, canvas: patch, cover };
  return face.hair;
}

export function loadImage(src) {
  return new Promise((ok, fail) => {
    const img = new Image();
    img.onload = () => ok(img);
    img.onerror = fail;
    img.src = src;
  });
}
