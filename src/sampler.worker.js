// Sub-worker for the sculpt worker's pool: samples one slab of the body grid, or produces one
// finished part (body, a garment or a hand). Setup is rebuilt from the same input: deterministic.
import * as THREE from 'three';
import { BodySDF, sampleGrid, simplifierReady } from './sdf.js';
import { handMesh, sculptSetup, surfacePart, handPart, gridFrom } from './sculpt.js';

const partTransfer = (q) => (q ? [q.positions.buffer, q.indices.buffer, q.normals.buffer, q.ao.buffer] : []);

self.onmessage = async (e) => {
  const { id, type, payload } = e.data;
  const t0 = performance.now();
  const post = (out, transfer) => self.postMessage({ id, out, ms: performance.now() - t0 }, transfer);
  if (type === 'sample') {
    const { prims, opts, cell, j0, j1 } = payload;
    const sdf = new BodySDF(prims.map((q) => ({ ...q, matrix: new THREE.Matrix4().fromArray(q.matrix) })), opts);
    const g = sampleGrid(sdf, cell, [j0, j1]);
    const out = { nx: g.nx, ny: g.ny, nz: g.nz, cell, o: g.o.toArray(), j0: g.j0, rows: g.rows, val: g.val, valL: g.valL, valR: g.valR, exact: g.exact, ord: g.ord };
    post(out, [g.val.buffer, g.valL.buffer, g.valR.buffer, g.exact.buffer, g.ord.buffer]);
    return;
  }
  await simplifierReady;
  if (type === 'surface') {
    const out = surfacePart(sculptSetup(payload.input), gridFrom(payload.grid), payload.which);
    post(out, partTransfer(out));
  } else if (type === 'handPart') {
    const S = sculptSetup(payload.input);
    const out = handPart(S, payload.n, handMesh(S.handJobs[payload.n]));
    post(out, partTransfer(out));
  }
};
