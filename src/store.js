// Shared browser storage for the engine's tabs (IndexedDB, so character GLBs of a few MB fit):
//   characters: characters sent from the Characters tab  { id, name, glb: ArrayBuffer, thumb, created }
//   scenes:     saved scenes                              { id, name, terrain, actors, created, updated }
//   meta:       'current' -> the scene being edited (a working copy; savedId links it to a saved scene)
//   poses:      the pose library                          { id, name, thumb, pose: { bones, hips }, created }
//   audio:      imported voice lines                      { id, name, data: ArrayBuffer, created }
//   decks:      slide decks (Slides tab)                  { id, name, slides: [{ id, image, text, style }], created, updated }
//   shots:      editor snapshots for slides               { id, image (jpeg data url), scene, actors, place, props, created }
//   captions:   per audio source ('asset:…' / 'db:…')     { src, cues: [{ start, end, text }], model, created }
// Files (scene export / import) are the portable save; this is per-browser convenience.

const DB = 'dreamare', VERSION = 5; // 2: + poses, 3: + audio, 4: + captions, 5: + decks, shots
let dbp = null;
function db() {
  dbp ||= new Promise((ok, fail) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => { const d = req.result; for (const s of ['characters', 'scenes', 'meta', 'poses', 'audio', 'captions', 'decks', 'shots']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s); };
    req.onsuccess = () => ok(req.result);
    req.onerror = () => fail(req.error);
  });
  return dbp;
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((ok, fail) => {
    const t = d.transaction(store, mode), s = t.objectStore(store), req = fn(s);
    t.oncomplete = () => ok(req?.result);
    t.onerror = () => fail(t.error);
  });
}
export const put = (store, key, value) => tx(store, 'readwrite', (s) => s.put(value, key));
export const get = (store, key) => tx(store, 'readonly', (s) => s.get(key));
export const del = (store, key) => tx(store, 'readwrite', (s) => s.delete(key));
export const all = (store) => tx(store, 'readonly', (s) => s.getAll());
export const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// ---- scenes: files in scenes/ (dev server), so they can be edited in the app and by hand / by Claude ----
// Each scene is scenes/<id>.json; meta 'currentFile' remembers which one the editor has open. Without the dev
// server (a static build) scenes fall back to this browser's IndexedDB.
export const slugify = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'scene';
let filesP = null;
export const sceneFiles = () => (filesP ||= fetch('/__scenes').then((r) => r.ok).catch(() => false));
const lastWritten = new Map(); // id -> the JSON this tab last wrote (so its own saves don't come back as outside edits)
export const writtenText = (id) => lastWritten.get(id);
const sceneText = (s) => JSON.stringify(s, null, 2) + '\n';
export async function listScenes() {
  if (!(await sceneFiles())) return all('scenes');
  return (await fetch('/__scenes').then((r) => r.json())).filter((s) => !s.error);
}
export async function readScene(id) {
  if (!(await sceneFiles())) return get('scenes', id);
  const r = await fetch(`/__scenes/${id}`); if (r.status === 404) return null;
  const j = await r.json(); if (!r.ok) throw new Error(j.error || 'could not read the scene');
  return j;
}
export async function writeScene(s) {
  if (!(await sceneFiles())) return put('scenes', s.id, s);
  const text = sceneText(s); lastWritten.set(s.id, text);
  await fetch(`/__scenes/${s.id}`, { method: 'PUT', body: text });
}
export async function removeScene(id) { if (!(await sceneFiles())) return del('scenes', id); await fetch(`/__scenes/${id}`, { method: 'DELETE' }); }
export async function freeSceneId(name) { const taken = new Set((await listScenes()).map((s) => s.id)); const base = slugify(name); let id = base, n = 2; while (taken.has(id)) id = `${base}-${n++}`; return id; }

export function emptyScene(name = 'Untitled scene', id = uid()) { const now = Date.now(); return { id, name, terrain: null, actors: [], props: [], directives: [], shots: [], ambience: {}, created: now, updated: now }; }
// scenes saved in this browser before scenes became files: written out once
async function migrate() {
  if (localStorage.getItem('dreamare.scenesMigrated')) return;
  try {
    const have = new Set((await listScenes()).map((s) => s.id)), old = await all('scenes');
    for (const sc of old) { const id = await freeSceneId(sc.name); if (!have.has(id)) { const { savedId, savedAt, thumb, ...rest } = sc; await writeScene({ ...rest, id }); have.add(id); } }
    const cur = await get('meta', 'current');
    if (cur && (cur.actors?.length || cur.terrain) && !cur.savedId) { const id = await freeSceneId(cur.name); const { savedId, savedAt, ...rest } = cur; await writeScene({ ...rest, id }); await put('meta', 'currentFile', id); }
    localStorage.setItem('dreamare.scenesMigrated', '1');
  } catch { /* try again next time */ }
}
export async function currentScene() {
  if (!(await sceneFiles())) { let s = await get('meta', 'current'); if (!s) { s = emptyScene(); await put('meta', 'current', s); } return s; }
  await migrate();
  const id = await get('meta', 'currentFile');
  let s = id && (await readScene(id).catch(() => null));
  if (!s) { const list = await listScenes(); s = list.sort((a, b) => b.updated - a.updated)[0]; }
  if (!s) { s = emptyScene('Untitled scene', await freeSceneId('Untitled scene')); await writeScene(s); }
  if (s.id !== id) await put('meta', 'currentFile', s.id);
  return s;
}
export async function openScene(id) { await put('meta', 'currentFile', id); bump(); }
export async function setCurrentScene(s) {
  s.updated = Date.now();
  if (!(await sceneFiles())) { await put('meta', 'current', s); bump(); return s; }
  await writeScene(s); await put('meta', 'currentFile', s.id); bump(); return s;
}

// other tabs hear about changes to the current scene (so the editor refreshes when a character is sent)
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('dreamare-scene') : null;
const bump = () => channel?.postMessage({ type: 'current-changed', at: Date.now() });
export const onSceneChange = (fn) => channel?.addEventListener('message', (e) => e.data?.type === 'current-changed' && fn());

// ---- from other tabs ----
// Scenarios "Set scene": the terrain is the generator's inputs (seed, biome, neighbours, mood), rebuilt on load
export async function setSceneTerrain(terrain) { const s = await currentScene(); s.terrain = terrain; return setCurrentScene(s); }
// Characters "Send to scene": store the character, then add one more of it to the current scene
export async function sendCharacter({ name, glb, thumb, params }) {
  const id = uid();
  await put('characters', id, { id, name, glb, thumb, params, created: Date.now() });
  const s = await currentScene();
  s.actors.push(newActor(id, name, s.actors.length));
  await setCurrentScene(s);
  return { id, count: s.actors.length };
}
// a new actor is placed on a loose arc in front of the spawn, so a few sent in a row stand apart
export function newActor(charId, name, i) {
  const a = (i % 7 - 3) * 0.32, d = 7 + Math.floor(i / 7) * 3;
  return { id: uid(), charId, name, x: Math.sin(a) * d, z: -Math.cos(a) * d, rotY: 0, scale: 1, anim: null, rel: true }; // rel: offsets are relative to the spawn's view until the editor places it
}
