// Head sculpt (skull + hair) off the main thread; runs alongside the body worker.
import { sculptHead } from './headsculpt.js';
import { simplifierReady } from './sdf.js';

self.onmessage = async (e) => {
  await simplifierReady;
  const { id, P, loop, index, p, style, hat } = e.data;
  const r = sculptHead(P, loop, index, p, style, hat);
  const transfer = [r.skull, r.hair, r.hat].filter(Boolean).flatMap((m) => [m.positions.buffer, m.indices.buffer, m.normals.buffer, m.ao.buffer, ...(m.aux ? [m.aux.buffer] : [])]);
  self.postMessage({ id, r }, transfer);
};
