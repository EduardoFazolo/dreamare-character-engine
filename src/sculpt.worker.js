// Runs the body sculpt off the main thread so the UI never freezes; same code, same output.
// A small pool of sub-workers samples the grid in slabs and sculpts the hands in parallel.
import * as THREE from 'three';
import { sculptParallel } from './sculpt.js';
import { simplifierReady, mergeSlabs, BodySDF } from './sdf.js';
import { perf } from './perf.js';

class Pool {
  constructor(n) {
    this.workers = Array.from({ length: n }, () => new Worker(new URL('./sampler.worker.js', import.meta.url), { type: 'module' }));
    this.free = [...this.workers];
    this.waiting = [];
    this.pending = new Map();
    this.id = 0;
    this.times = [];
    for (const w of this.workers) w.onmessage = (e) => {
      const { resolve, type, payload } = e.data && this.pending.get(e.data.id);
      this.times.push(`${type}${type === 'surface' ? ':' + payload.which : type === 'sample' ? ':' + payload.j0 : ''}=${Math.round(e.data.ms)}`);
      this.pending.delete(e.data.id);
      this.free.push(w);
      resolve(e.data.out);
      this.next();
    };
  }
  run(type, payload, urgent = false) {
    return new Promise((resolve) => {
      const job = { type, payload, resolve };
      if (urgent) this.waiting.splice(this.waiting.findIndex((j) => !j.urgent) >>> 0, 0, Object.assign(job, { urgent }));
      else this.waiting.push(job);
      this.next();
    });
  }
  next() {
    while (this.free.length && this.waiting.length) {
      const w = this.free.shift(), job = this.waiting.shift(), id = ++this.id;
      this.pending.set(id, job);
      w.postMessage({ id, type: job.type, payload: job.payload });
    }
  }
  // split block rows into slabs, one per worker, then merge them exactly like a single pass
  async sampleGrid(prims, opts, cell) {
    const sdf = new BodySDF(prims.map((q) => ({ ...q, matrix: new THREE.Matrix4().fromArray(q.matrix) })), opts);
    const ny = Math.ceil((sdf.bounds.max.y - sdf.bounds.min.y) / cell) + 2, B = 8;
    // one block row per job, scheduled dynamically: rows at arm height cost far more than leg rows
    const rows = Math.ceil(ny / B), jobs = [];
    for (let r = 0; r < rows; r++) jobs.push(this.run('sample', { prims, opts, cell, j0: r * B, j1: Math.min(ny, (r + 1) * B) }, true));
    const slabs = await Promise.all(jobs);
    const t = performance.now();
    const g = mergeSlabs(slabs);
    perf.log['  merge'] = performance.now() - t;
    return g;
  }
}

const pool = new Pool(Math.max(2, Math.min(8, (self.navigator?.hardwareConcurrency || 4) - 2)));

self.onmessage = async (e) => {
  await simplifierReady;
  const { id, input } = e.data;
  const t = performance.now();
  perf.reset();
  pool.times = [];
  const parts = await sculptParallel(input, pool);
  perf.log.jobs = pool.times.join(' ');
  const transfer = parts.flatMap((q) => [q.positions.buffer, q.indices.buffer, q.normals.buffer, q.ao.buffer]);
  self.postMessage({ id, parts, ms: performance.now() - t, perf: perf.log }, transfer);
};
