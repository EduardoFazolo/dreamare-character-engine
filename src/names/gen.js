// Names with a "mouthful": genteel old-English (with a little French), built the way real English
// surnames and place names are (root + -worth / -combe / -wick ...), but from cosy, odd, domestic roots,
// plus titles, double-barrels, spelled-out initials and lumpy invented words (Bulgrom-ish).
// Everything is seeded: personName(seed, opts) / placeName(seed, opts) always return the same name.
//
// opts: whimsy 0..1 (0 plausible British, ~0.5 the sweet spot, 1 full nonsense),
//       french 0..1 (how often the French seasoning appears), titles 0..1 (how often a title is used).

export function rng(seed) {
  let s = (Math.floor(seed) * 2654435761) >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pick = (r, a) => a[Math.floor(r() * a.length)];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const weighted = (r, entries) => { // [[weight, fn], ...]
  let t = 0; for (const [w] of entries) t += Math.max(0, w);
  let x = r() * t; for (const [w, f] of entries) { x -= Math.max(0, w); if (x <= 0) return f; }
  return entries[entries.length - 1][1];
};

// ---------- word pools ----------
const GIVEN = {
  british: ['Marjorie', 'Cecil', 'Winifred', 'Horace', 'Enid', 'Mildred', 'Eustace', 'Beryl', 'Clement', 'Agatha', 'Reginald', 'Maude', 'Percival', 'Bertram', 'Dorcas', 'Lionel', 'Mabel', 'Rupert', 'Edna', 'Ambrose', 'Gwendolyn', 'Nigel', 'Hortense', 'Thaddeus', 'Philippa', 'Ignatius', 'Gertrude', 'Wilfred', 'Muriel', 'Humphrey', 'Prudence', 'Algernon', 'Ethel', 'Barnaby', 'Constance', 'Norbert', 'Ivy', 'Crispin', 'Hilda', 'Montague', 'Violet', 'Osbert', 'Doris', 'Neville', 'Imelda', 'Godfrey', 'Petunia', 'Rodney', 'Esmé', 'Leopold', 'Gladys', 'Ptolemy', 'Myrtle', 'Basil', 'Ottoline', 'Aubrey', 'Florence', 'Cuthbert', 'Pansy', 'Desmond'],
  french: ['Bertrand', 'Odile', 'Clotilde', 'Gaston', 'Lucien', 'Solange', 'Ferdinand', 'Marguerite', 'Aurèle', 'Honoré', 'Delphine', 'Anatole', 'Ghislaine', 'Fabrice', 'Mireille', 'Édouard', 'Hyacinthe', 'Séraphin', 'Blandine', 'Évariste'],
  odd: ['Chubb', 'Pim', 'Wob', 'Dunkle', 'Bramm', 'Tubb', 'Nobb', 'Gumm', 'Pogg', 'Fudge', 'Moll', 'Bunt', 'Ploss', 'Dimm', 'Grue', 'Humm', 'Bodge', 'Mungo', 'Plum', 'Crumm'],
};
// real-sounding surnames for double-barrels and the plausible end of the dial
const SURNAME = ['Pemberton', 'Hargreaves', 'Whitlock', 'Pickering', 'Ashby', 'Thackeray', 'Dimmock', 'Fairweather', 'Bellamy', 'Ramsbottom', 'Ogden', 'Pennington', 'Lockwood', 'Hatherley', 'Gumble', 'Sidebottom', 'Tolley', 'Pargeter', 'Blenkinsop', 'Fothergill', 'Cholmondeley', 'Aldridge', 'Babbage', 'Crabtree', 'Duckworth', 'Entwistle', 'Higginbottom', 'Knatchbull', 'Mottram', 'Nuttall', 'Pinnock', 'Scrope', 'Tuttle', 'Whitworth', 'Bagshaw', 'Grimshaw', 'Pettigrew', 'Rattray', 'Wetherby', 'Ormerod'];
// surname roots: plain (plausible) .. odd (the word inside is the joke)
const ROOT = {
  plain: ['ash', 'brook', 'thorn', 'whit', 'pem', 'hol', 'marl', 'cran', 'hather', 'kings', 'bram', 'wen', 'ald', 'stan', 'lang', 'mort', 'fern', 'rad', 'cumber', 'wither', 'pel', 'tam', 'bel', 'hazel', 'oak', 'elder', 'wood', 'mill', 'rush', 'wil'],
  odd: ['thimble', 'treacle', 'crumb', 'pudding', 'nettle', 'gristle', 'custard', 'mutton', 'pickle', 'dumpling', 'wobble', 'bramble', 'pottle', 'snod', 'fumble', 'mumble', 'grumble', 'tuppen', 'parsnip', 'kettle', 'marrow', 'button', 'suet', 'gravy', 'plumb', 'bunion', 'wimple', 'muddle', 'dribble', 'spindle', 'tripe', 'cobble', 'crumple', 'blanc', 'noodle', 'dimple', 'gumbo', 'mould', 'lard', 'whelk', 'sprocket', 'bobbin', 'rumple', 'porridge', 'pumice', 'spoon', 'wishbone', 'cake', 'toffee', 'humble', 'stodge', 'jelly', 'gherkin', 'mothball', 'doily'],
};
const SUFFIX = ['worth', 'sworth', 'dale', 'by', 'wick', 'combe', 'ham', 'hurst', 'sher', 'ton', 'ley', 'field', 'shaw', 'more', 'thorpe', 'bury', 'stead', 'fold', 'bottom', 'wood', 'ford', 'dean', 'cote', 'well', 'bridge', 'ington', 'hampton', 'ridge', 'ster', 'bold'];
const SUFFIX_FR = ['eaux', 'ine', 'ot', 'ette', 'ard', 'ois', 'elle', 'ande'];
const TITLES = ['Mr', 'Mrs', 'Miss', 'Master', 'Nanny', 'Vicar', 'Doctor', 'Auntie', 'Uncle', 'Lady', 'Sir', 'Madame', 'Monsieur', 'Old', 'Little', 'Great-Aunt', 'Canon', 'Matron', 'Captain', 'Professor'];
const TITLE_FR = new Set(['Madame', 'Monsieur']);
// letters as they're said, for spelled-out initials (British: zed)
const SPOKEN = { A: 'Ay', B: 'Bee', C: 'See', D: 'Dee', E: 'Ee', F: 'Eff', G: 'Gee', H: 'Aitch', J: 'Jay', K: 'Kay', L: 'Ell', M: 'Emm', N: 'En', O: 'Oh', P: 'Pee', R: 'Arr', S: 'Ess', T: 'Tee', U: 'You', V: 'Vi', Z: 'Zed' };
// lumps: round vowels, pile-up codas
// lumps stay sayable: one pile-up per word, round vowels, simple onsets
const ON1 = ['b', 'bl', 'gl', 'gr', 'pl', 'sn', 'sm', 'fl', 'cl', 'cr', 'dr', 'g', 'm', 'p', 'ch', 'wh', 'h', 'n', 'w', 'sp', 'st', 'thr'];
const VOW = ['u', 'o', 'oo', 'ou', 'u', 'o', 'a'];
const CODA1 = ['mpth', 'mph', 'lch', 'rch', 'dge', 'mble', 'nk', 'lp', 'mp', 'gg', 'lm', 'nch', 'ckle', 'rm', 'mb', 'x', 'mbs', 'lk'];
const LIQ = ['l', 'm', 'n', 'r'];
const ON2 = ['g', 'b', 'd', 'p', 'm', 'w', 'gr', 'br', 'bl', 'pl', 'dr'];
const CODA2 = ['m', 'b', 'p', 'x', 'ch', 'dge', 'mph', 'ck', 'mble', 'n'];
// the originals stay theirs
const BLOCK = new Set(['marjory stewart-baxter', 'melvin wishcake', 'hubert cumberdale', 'mr frobisher', 'miss bulgrom', 'en. vi. cobblesworth', 'old chumm blompth', 'salad fingers']);
const BLOCK_PART = ['wishcake', 'cumberdale', 'bulgrom', 'cobblesworth', 'blompth', 'stewart-baxter'];

// ---------- building blocks ----------
function lump(r) {
  if (r() < 0.5) return cap(pick(r, ON1) + pick(r, VOW) + pick(r, CODA1)); // Gloomph
  let on = pick(r, ON1); const liq = pick(r, LIQ);
  if (liq === 'r' || liq === 'l') on = on.replace(/[rl]$/, '') || 'b'; // no "Frur", "Blul"
  let on2 = pick(r, ON2); if (liq === 'r' && on2.endsWith('r')) on2 = on2[0];
  return cap(on + pick(r, ['u', 'o', 'a']) + liq + on2 + pick(r, ['o', 'u', 'i']) + pick(r, CODA2)); // Bulgrom-ish
}
function joinRoot(root, suf) {
  if (suf === 'sworth' && /s$/.test(root)) suf = 'worth';
  if (/e$/.test(root) && /^[aeiou]/.test(suf)) root = root.slice(0, -1);
  if (root.slice(-1) === suf[0] && !/[aeiou]/.test(suf[0]) && root.slice(-2, -1) === root.slice(-1)) suf = suf.slice(1); // no triple letters
  return root + suf;
}
function compound(r, o) {
  const root = r() < 0.06 + o.whimsy * 0.88 ? pick(r, ROOT.odd) : pick(r, ROOT.plain);
  const suf = r() < o.french * 0.6 ? pick(r, SUFFIX_FR) : pick(r, SUFFIX);
  return cap(joinRoot(root, suf));
}
function surname(r, o) {
  return weighted(r, [
    [1.4 - o.whimsy, () => pick(r, SURNAME)],
    [1.6, () => compound(r, o)],
    [o.whimsy * 0.9, () => lump(r)],
  ])();
}
function given(r, o) {
  return weighted(r, [
    [1 - o.french, () => pick(r, GIVEN.british)],
    [o.french * 1.2, () => pick(r, GIVEN.french)],
    [o.whimsy * 0.35, () => pick(r, GIVEN.odd)],
  ])();
}
function title(r, o) {
  const t = pick(r, TITLES);
  return TITLE_FR.has(t) && r() > o.french * 2 ? 'Mr' : t;
}
const initials = (r) => { const L = Object.keys(SPOKEN); const n = r() < 0.75 ? 2 : 3; return Array.from({ length: n }, () => SPOKEN[pick(r, L)] + '.').join(' '); };

// ---------- the mouthful check ----------
export const syllables = (s) => s.toLowerCase().replace(/[^a-zé]/g, ' ').split(/\s+/).filter(Boolean)
  .reduce((n, w) => n + Math.max(1, (w.replace(/e$/, '').match(/[aeiouyé]+/g) || []).length), 0);
const lumpy = (s) => (s.toLowerCase().match(/[bpmgd]/g) || []).length;
function acceptable(name, lo, hi) {
  const l = name.toLowerCase();
  if (BLOCK.has(l) || BLOCK_PART.some((p) => l.includes(p))) return false;
  const n = syllables(name);
  return n >= lo && n <= hi && lumpy(name) >= 2;
}
const norm = (o = {}) => ({ whimsy: o.whimsy ?? 0.55, french: o.french ?? 0.12, titles: o.titles ?? 0.35 });

// ---------- people ----------
export function personName(seed, opts) {
  const o = norm(opts), r = rng(seed * 7919 + 17);
  for (let tries = 0; tries < 40; tries++) {
    const w = o.whimsy;
    const name = weighted(r, [
      [3, () => `${given(r, o)} ${surname(r, o)}`], // Cecil Thimbleworth
      [1.2, () => `${given(r, o)} ${pick(r, SURNAME)}-${r() < 0.5 + w * 0.4 ? compound(r, o) : pick(r, SURNAME)}`], // Winifred Ashby-Crumb
      [o.titles * 3, () => `${title(r, o)} ${r() < 0.7 ? compound(r, o) : surname(r, o)}`], // Mr Gristlecombe
      [0.35 + w * 0.5, () => `${initials(r)} ${compound(r, o)}`], // Aitch. Bee. Mumbleby
      [w * 1.1, () => `Old ${pick(r, GIVEN.odd)} ${lump(r)}`], // Old Pim Gloomph
      [o.french * 2.5, () => `${r() < 0.6 ? pick(r, GIVEN.french) : given(r, o)} de ${r() < 0.5 ? 'la ' : ''}${compound(r, o)}`], // Eustace de la Marrow
    ])();
    // sometimes a title in front of a full name too (Mrs Enid Treaclehurst), never doubled
    const full = !/^(Mr|Mrs|Miss|Master|Nanny|Vicar|Doctor|Auntie|Uncle|Lady|Sir|Madame|Monsieur|Old|Little|Great-Aunt|Canon|Matron|Captain|Professor) /.test(name) && r() < o.titles * 0.35
      ? `${title(r, o)} ${name}` : name;
    if (acceptable(full, 4, 9)) return full;
  }
  return `${pick(r, GIVEN.british)} ${compound(r, o)}`;
}

// ---------- places ----------
const FEATURE = {
  any: ['Field', 'Lane', 'Common', 'Downs', 'Marsh', 'Green', 'End', 'Crossing', 'Heath', 'Fold', 'Bottom', 'Halt', 'Row', 'Close', 'Yard', 'Hollow', 'Mere', 'Lido', 'Wharf', 'Allotments', 'Rise'],
  coast: ['Sands', 'Dunes', 'Pier', 'Reach', 'Strand', 'Bay', 'Marsh', 'Point', 'Links', 'Spit', 'Flats', 'Shingle', 'Front', 'Esplanade', 'Lido', 'Breakwater', 'Cove'],
};
const PREFIX = ['Little', 'Nether', 'Upper', 'Lower', 'Great', 'Much', 'Long', 'Old', 'East', 'West', 'Chipping', 'King’s'];
const JOIN = ['on', 'under', 'upon', 'in-the', 'by-the', 'over'];
const TAIL = { plain: ['Marsh', 'Water', 'Wold', 'Hill', 'Mire', 'Brook', 'Fen', 'Sea', 'Moor', 'Weald', 'Vale', 'Wash'], odd: ['Marrow', 'Mould', 'Custard', 'Crumb', 'Nettle', 'Pudding', 'Gravy', 'Treacle', 'Whelk', 'Suet', 'Porridge', 'Gristle'] };
const PLACE_TITLES = ['Mr', 'Mrs', 'Miss', 'Old', 'Auntie', 'Uncle', 'Nanny', 'Vicar', 'Doctor', 'Captain'];

// opts.kind: 'any' | 'coast'
export function placeName(seed, opts) {
  const o = norm(opts), r = rng(seed * 104729 + 3), F = FEATURE[opts?.kind === 'coast' ? 'coast' : 'any'];
  for (let tries = 0; tries < 40; tries++) {
    const w = o.whimsy;
    const name = weighted(r, [
      [3, () => `${compound(r, o)} ${pick(r, F)}`], // Nettlecombe Pier
      [1.6, () => `The ${compound(r, o)} ${pick(r, F)}`], // The Cumberwick Field
      [1.2, () => `${pick(r, PREFIX)} ${compound(r, o)}`], // Nether Plumbage
      [1, () => `${compound(r, o)}-${pick(r, JOIN)}-${pick(r, r() < w ? TAIL.odd : TAIL.plain)}`], // Crumbley-on-Marrow
      [1.1, () => (r() < o.titles + 0.2 ? `${pick(r, PLACE_TITLES)} ${compound(r, o)}` : given(r, o)) + `’s ${pick(r, F)}`], // Mrs Pottlewick's Lane
      [0.6, () => `St ${pick(r, GIVEN.british)}’s ${pick(r, F)}`], // St Enid's Sands
      [w * 0.9, () => `${lump(r)} ${pick(r, F)}`], // Gloomph Flats
    ])();
    if (acceptable(name, 3, 8)) return name;
  }
  return `${compound(r, o)} ${pick(r, F)}`;
}
