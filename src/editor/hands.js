// Hand presets that work on any hand, long fingers included: hands/*.json say what each finger does in terms of
// contact (curl until the tip rests on the palm, curl round whatever is held, meet the thumb), not in joint
// angles. A fixed angle that closes a normal fist drives a long finger's tip through the palm and out the back
// of the hand; here each finger curls along its three joints (within their limits) only until one of its points
// would enter the palm, the forearm or the held thing, so it stops where it touches, whatever its length.
//
// A preset ({ label, fingers, thumb, spread, wrist, rub }):
//   fingers: { all | Index | Middle | Ring | Pinky: { mode, t, tight } } (a named finger overrides "all")
//     mode "curl"    a fixed share of the joints' range (t 0..1), still stopped by contact; joints: [knuckle,
//                    middle, last] how the curl is shared (a claw: [0, 1, 0.9])
//          "palm"    curl until it rests on the palm (tight 0..1: how far of that)
//          "target"  curl round the held thing (grip.around), "fallback" t when nothing is held
//          "pinch"   the index meets the thumb tip (with thumb "pinch")
//   thumb: { mode: "curl" (t) | "tuck" (over the curled fingers) | "pinch" | "target" }
//   spread: fingers fanned apart (0..1); wrist: { flex } the hand bent at the wrist toward the palm (radians)
//   rub: the two hands brought together in front of the chest, palms rubbing (see main.js gripHands)
import * as THREE from 'three';
import { curlAxis, GRIP_SIGN } from './pose.js';

const files = import.meta.glob('../../hands/*.json', { eager: true, import: 'default' });
export const HAND_PRESETS = Object.fromEntries(Object.entries(files).map(([p, v]) => [p.split('/').pop().replace('.json', ''), v]));

const FINGERS = ['Index', 'Middle', 'Ring', 'Pinky'], RANK = { Index: -1.5, Middle: -0.5, Ring: 0.5, Pinky: 1.5 };
const LIMIT = [1.55, 1.75, 1.3]; // each joint's furthest curl (knuckle, middle, last), radians
const THUMB_LIMIT = [0.9, 1.0, 1.1];
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _v = new THREE.Vector3(), _w = new THREE.Vector3();
const wp = (b) => b.getWorldPosition(new THREE.Vector3());

const chain = (rig, side, f) => [1, 2, 3].map((i) => rig.bones[`${side}Hand${f}${i}`]).filter(Boolean);
// a finger's points in the world: its joints and an extrapolated tip (no tip bone: the last segment again, a little shorter)
function points(bs) {
  const p = bs.map(wp), n = p.length;
  const tip = p[n - 1].clone().addScaledVector(p[n - 1].clone().sub(p[n - 2]).normalize(), p[n - 1].distanceTo(p[n - 2]) * 0.8);
  return [...p.slice(1), tip];
}
function setChain(rig, side, bs, base, angles) {
  bs.forEach((b, i) => { b.quaternion.copy(base[i]).multiply(_q.setFromAxisAngle(curlAxis(rig, side, b.name), (angles[i] || 0) * GRIP_SIGN.Left)).normalize(); });
  bs[0].parent.updateMatrixWorld(true);
}

// the hand's own frame, measured: where the fingers point, across the knuckles, which way they fold (the palm)
function palmFrame(rig, side) {
  const hand = rig.bones[`${side}Hand`], i1 = rig.bones[`${side}HandIndex1`], m1 = rig.bones[`${side}HandMiddle1`], p1 = rig.bones[`${side}HandPinky1`];
  hand.updateMatrixWorld(true);
  const H = wp(hand), M = wp(m1), I = wp(i1), P = wp(p1), fwd = M.clone().sub(H).normalize();
  const mid = chain(rig, side, 'Middle'), base = mid.map((b) => b.quaternion.clone());
  const t0 = points(mid).at(-1); setChain(rig, side, mid, base, [0.25, 0, 0]); const t1 = points(mid).at(-1); setChain(rig, side, mid, base, [0, 0, 0]);
  const n = t1.sub(t0).projectOnPlane(fwd).normalize();
  const knuckle = M.clone().sub(H).dot(fwd), th = I.distanceTo(P) / 7; // (finger thickness: from the knuckles' width)
  return { H, fwd, n, knuckle, th, center: H.clone().add(I).add(P).multiplyScalar(1 / 3) };
}
// signed clearance from the palm (and the forearm past the wrist): only points over the palm or behind it count
const palmClear = (F, x) => { const s = x.clone().sub(F.H).dot(F.fwd); if (s > F.knuckle * 0.92) return Infinity; return x.clone().sub(F.center).dot(F.n) - F.th; };

// curl a finger from t = 0 toward `tMax`, stopping before any of its points would come within reach of
// something (clear(x) < 0): returns the t it reached
function curlUntil(rig, side, bs, base, tMax, clear, limit = LIMIT) {
  let ok = 0;
  for (let t = 0.02; t <= tMax + 1e-6; t += 0.02) {
    setChain(rig, side, bs, base, limit.map((l) => l * t));
    if (points(bs).some((x) => clear(x) < 0)) break;
    ok = t;
  }
  setChain(rig, side, bs, base, limit.map((l) => l * ok));
  return ok;
}

// signed distance to a held shape (scene units, world): sphere, rail (a capsule), ring (a torus) or plane
export function shapeDist(s, x) {
  if (s.sphere) return x.distanceTo(_v.fromArray(s.sphere.center)) - s.sphere.r;
  if (s.rail) { const a = _v.fromArray(s.rail.a), b = _w.fromArray(s.rail.b), ab = b.clone().sub(a), t = Math.max(0, Math.min(1, x.clone().sub(a).dot(ab) / ab.lengthSq())); return x.distanceTo(a.clone().addScaledVector(ab, t)) - s.rail.r; }
  if (s.ring) { const c = _v.fromArray(s.ring.center), ax = _w.fromArray(s.ring.axis || [0, 0, 1]).normalize(), d = x.clone().sub(c), h = d.dot(ax), q = d.addScaledVector(ax, -h).length() - s.ring.R; return Math.hypot(q, h) - s.ring.r; }
  if (s.plane) return x.clone().sub(_v.fromArray(s.plane.point)).dot(_w.fromArray(s.plane.normal).normalize());
  return Infinity;
}

const cache = new WeakMap(); // rig -> { key: angles } for shapes that depend on the hand alone
const fingerSpec = (pr, f) => ({ ...(pr.fingers?.all || {}), ...(pr.fingers?.[f] || {}) });

// apply preset `name` to one hand. The wrist must already be placed and turned (IK); opts.around: the held shape
export function applyHand(rig, side, name, opts = {}) {
  const pr = typeof name === 'object' ? name : HAND_PRESETS[name]; if (!pr || !rig.bones[`${side}HandMiddle1`]) return false;
  const hand = rig.bones[`${side}Hand`];
  if (pr.wrist?.flex) { // the hand bent at the wrist, toward the palm (ghost hands droop)
    const F0 = palmFrame(rig, side), axis = F0.fwd.clone().cross(F0.n).normalize();
    const wq = hand.getWorldQuaternion(new THREE.Quaternion()), q = _q2.setFromAxisAngle(axis, -pr.wrist.flex).multiply(wq);
    hand.quaternion.copy(hand.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(q)); hand.updateMatrixWorld(true);
  }
  // every finger back to rest first (deterministic: whatever the pose or the life layer did to them)
  const all = [...FINGERS, 'Thumb'].map((f) => chain(rig, side, f));
  all.flat().forEach((b) => b.quaternion.copy(rig.rest[b.name]));
  hand.updateMatrixWorld(true);
  const F = palmFrame(rig, side);
  if (pr.spread) for (const f of FINGERS) { // fanned about the palm's normal, outward from the middle
    const b = chain(rig, side, f)[0]; if (!b) continue;
    const q = _q2.setFromAxisAngle(F.n, RANK[f] * 0.12 * pr.spread * (side === 'Left' ? 1 : -1)).multiply(b.getWorldQuaternion(new THREE.Quaternion()));
    b.quaternion.copy(b.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(q));
  }
  hand.updateMatrixWorld(true);
  const bases = Object.fromEntries([...FINGERS, 'Thumb'].map((f) => [f, chain(rig, side, f).map((b) => b.quaternion.clone())]));
  const around = opts.around, held = around ? (x) => shapeDist(around, x) - F.th : null;
  const handOnly = !around && !FINGERS.some((f) => fingerSpec(pr, f).mode === 'target');
  const key = `${side}|${JSON.stringify(pr)}`, store = cache.get(rig) || {}; cache.set(rig, store);
  if (handOnly && store[key]) { // solved before for this hand: the same angles (they're in the hand's own frame)
    for (const [f, a] of Object.entries(store[key].fingers)) setChain(rig, side, chain(rig, side, f), bases[f], a);
    chain(rig, side, 'Thumb').forEach((b, i) => store[key].thumb[i] && b.quaternion.copy(store[key].thumb[i]));
    hand.updateMatrixWorld(true);
    return true;
  }
  const solved = {};
  for (const f of FINGERS) {
    const sp = fingerSpec(pr, f), bs = chain(rig, side, f); if (!bs.length) continue;
    const clearPalm = (x) => palmClear(F, x), lim = sp.joints ? LIMIT.map((l, i) => l * (sp.joints[i] ?? 1)) : LIMIT; // (joints: how the curl is shared, e.g. a claw keeps the knuckle straight)
    let t;
    if (sp.mode === 'palm') t = curlUntil(rig, side, bs, bases[f], 1, clearPalm, lim) * (sp.tight ?? 1);
    else if (sp.mode === 'target') t = held ? curlUntil(rig, side, bs, bases[f], 1, (x) => Math.min(held(x), clearPalm(x)), lim) : curlUntil(rig, side, bs, bases[f], sp.fallback ?? 0.7, clearPalm, lim);
    else if (sp.mode === 'pinch') t = null; // (solved with the thumb below)
    else t = curlUntil(rig, side, bs, bases[f], sp.t ?? 0, clearPalm, lim);
    if (t != null) { setChain(rig, side, bs, bases[f], lim.map((l) => l * t)); solved[f] = lim.map((l) => l * t); }
  }
  // the thumb
  const ts = pr.thumb || { mode: 'curl', t: 0.2 }, thumb = chain(rig, side, 'Thumb');
  if (thumb.length) {
    const others = FINGERS.flatMap((f) => (fingerSpec(pr, f).mode === 'pinch' ? [] : [chain(rig, side, f)]));
    const segDist = (x) => { let m = Infinity; for (const bs of others) { const p = [wp(bs[0]), ...points(bs)]; for (let i = 0; i + 1 < p.length; i++) { const a = p[i], ab = p[i + 1].clone().sub(a), u = Math.max(0, Math.min(1, x.clone().sub(a).dot(ab) / ab.lengthSq())); m = Math.min(m, x.distanceTo(a.clone().addScaledVector(ab, u))); } } return m - F.th * 1.6; };
    const oppose = (a, b = 0) => { // the thumb swung across the palm (about its normal) and rolled toward it (about the fingers' direction): opposition
      thumb[0].quaternion.copy(bases.Thumb[0]);
      const sg = side === 'Left' ? -1 : 1, q = _q2.setFromAxisAngle(F.n, b * sg).multiply(new THREE.Quaternion().setFromAxisAngle(F.fwd, a * sg)).multiply(thumb[0].getWorldQuaternion(new THREE.Quaternion()));
      thumb[0].quaternion.copy(thumb[0].parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(q)); thumb[0].updateMatrixWorld(true);
      return thumb[0].quaternion.clone();
    };
    const setThumb = (opp, t, sw = 0) => { const b0 = oppose(opp, sw), b = [b0, bases.Thumb[1], bases.Thumb[2]]; setChain(rig, side, thumb, b, THUMB_LIMIT.map((l) => l * t)); };
    if (ts.mode === 'pinch' || FINGERS.some((f) => fingerSpec(pr, f).mode === 'pinch')) {
      const pf = FINGERS.find((f) => fingerSpec(pr, f).mode === 'pinch') || 'Index', pb = chain(rig, side, pf);
      let best = { d: Infinity };
      const tryAt = (ti, opp, sw, tt) => { setChain(rig, side, pb, bases[pf], LIMIT.map((l) => l * ti)); const tipI = points(pb).at(-1); setThumb(opp, tt, sw); const d = points(thumb).at(-1).distanceTo(tipI); if (d < best.d) best = { d, ti, opp, sw, tt }; };
      for (let ti = 0.15; ti <= 1; ti += 0.1) for (let opp = -1.2; opp <= 1.2; opp += 0.3) for (let sw = -1.8; sw <= 1.8; sw += 0.3) for (let tt = 0; tt <= 1.2; tt += 0.1) tryAt(ti, opp, sw, tt); // (a long index curls further down to meet a shorter thumb)
      for (let r = 0; r < 3; r++) { const c = { ...best }, h = [0.05, 0.15, 0.15, 0.05].map((x) => x / (r + 1)); for (const a of [-1, 0, 1]) for (const b2 of [-1, 0, 1]) for (const c2 of [-1, 0, 1]) for (const d2 of [-1, 0, 1]) tryAt(Math.max(0.05, c.ti + a * h[0]), c.opp + b2 * h[1], c.sw + c2 * h[2], Math.min(1.2, Math.max(0, c.tt + d2 * h[3]))); } // (refined round the best)
      setThumb(best.opp, best.tt, best.sw);
      setChain(rig, side, pb, bases[pf], LIMIT.map((l) => l * best.ti)); solved[pf] = LIMIT.map((l) => l * best.ti);
      setThumb(best.opp, best.tt, best.sw);
    } else if (ts.mode === 'tuck') { // swung across and curled down onto the curled fingers' middle segments (searched, like the pinch: the thumb's fold plane only crosses the fingers once it's swung over)
      const i2 = chain(rig, side, 'Index')[1], m2 = chain(rig, side, 'Middle')[1];
      const goal = i2 && m2 ? wp(i2).add(wp(m2)).multiplyScalar(0.5).addScaledVector(F.n, F.th * 1.5) : null;
      if (goal) {
        let best = { d: Infinity };
        for (let opp = -1.2; opp <= 1.2; opp += 0.3) for (let sw = -1.8; sw <= 1.8; sw += 0.3) for (let tt = 0; tt <= 1.2; tt += 0.1) { setThumb(opp, tt, sw); const d = points(thumb).at(-1).distanceTo(goal); if (d < best.d) best = { d, opp, sw, tt }; }
        for (let r = 0; r < 3; r++) { const c = { ...best }, h = [0.15, 0.15, 0.05].map((x) => x / (r + 1)); for (const x of [-1, 0, 1]) for (const y of [-1, 0, 1]) for (const z of [-1, 0, 1]) { const tt = Math.min(1.2, Math.max(0, c.tt + z * h[2])); setThumb(c.opp + x * h[0], tt, c.sw + y * h[1]); const d = points(thumb).at(-1).distanceTo(goal); if (d < best.d) best = { d, opp: c.opp + x * h[0], sw: c.sw + y * h[1], tt }; } }
        setThumb(best.opp, best.tt, best.sw);
      } else setThumb(ts.opp ?? 0.9, 0.3);
    } else if (ts.mode === 'target' && held) {
      let t = 0; const opp = ts.opp ?? 0.7;
      for (let tt = 0.02; tt <= 1; tt += 0.02) { setThumb(opp, tt); if (points(thumb).some((x) => held(x) < 0)) break; t = tt; }
      setThumb(opp, t);
    } else setThumb(ts.opp ?? 0, ts.t ?? (ts.mode === 'target' ? ts.fallback ?? 0.4 : 0.2));
    solved.Thumb = thumb.map((b) => b.quaternion.clone());
  }
  if (handOnly) store[key] = { fingers: Object.fromEntries(Object.entries(solved).filter(([f]) => f !== 'Thumb')), thumb: solved.Thumb || [] }; // (kept: the fingers as angles from their bases, the thumb as its quaternions)
  hand.updateMatrixWorld(true);
  return true;
}
