// Place kinds: which generator builds the land. A scene's terrain has a `kind`; directives (gen.js) then
// organise whatever the kind builds around the scene's own things.
//   emptymemories  the original: overcast dunes dissolving into fog, a worn path to a lone house, poles,
//                  a bus stop, a booth, a pier (biomes change the ingredients; the village is exact)
// More kinds plug in here, each a generate(params) -> world with the same shape as gen.js generate.
import { generate } from './gen.js';

export const KINDS = {
  emptymemories: { label: 'Empty memories', generate },
};
export const KIND_NAMES = Object.keys(KINDS);
export const generatePlace = (p) => (KINDS[p.kind] || KINDS.emptymemories).generate(p);
