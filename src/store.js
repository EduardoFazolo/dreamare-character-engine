// Shared browser storage for the engine's tabs (IndexedDB, so character GLBs of a few MB fit):
//   characters: characters sent from the Characters tab  { id, name, glb: ArrayBuffer, thumb, created }
//   scenes:     saved scenes                              { id, name, terrain, actors, created, updated }
//   meta:       'current' -> the scene being edited (a working copy; savedId links it to a saved scene)
//   poses:      the pose library                          { id, name, thumb, pose: { bones, hips }, created }
//   audio:      imported voice lines                      { id, name, data: ArrayBuffer, created }
//   captions:   per audio source ('asset:…' / 'db:…')     { src, cues: [{ start, end, text }], model, created }
// Files (scene export / import) are the portable save; this is per-browser convenience.

const DB = 'dreamare', VERSION = 4; // 2: + poses, 3: + audio, 4: + captions
let dbp = null;
function db() {
  dbp ||= new Promise((ok, fail) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => { const d = req.result; for (const s of ['characters', 'scenes', 'meta', 'poses', 'audio', 'captions']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s); };
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

// ---- the current scene ----
export function emptyScene(name = 'Untitled scene') { const now = Date.now(); return { id: uid(), savedId: null, name, terrain: null, actors: [], created: now, updated: now }; }
export async function currentScene() { let s = await get('meta', 'current'); if (!s) { s = emptyScene(); await put('meta', 'current', s); } return s; }
export async function setCurrentScene(s) { s.updated = Date.now(); await put('meta', 'current', s); bump(); return s; }

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
