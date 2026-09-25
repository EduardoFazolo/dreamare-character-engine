// Lightweight stage timing: perf.time('label', () => work()) ; perf.report() -> { label: ms }
export const perf = {
  log: {},
  time(label, fn) {
    const t = performance.now();
    const r = fn();
    this.log[label] = (this.log[label] || 0) + performance.now() - t;
    return r;
  },
  reset() { this.log = {}; },
};
if (typeof window !== 'undefined') window.__perf = perf;
