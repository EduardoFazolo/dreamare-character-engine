// Place kinds: which generator builds the land. A scene's terrain has a `kind`; directives (gen.js) then
// organise whatever the kind builds around the scene's own things.
//   emptymemories  the original: overcast dunes dissolving into fog, a worn path to a lone house, poles,
//                  a bus stop, a booth, a pier (biomes change the ingredients; the village is exact)
//   meadow         bright, empty rolling green hills under a deep blue sky with puffy clouds (meadow.js)
// More kinds plug in here, each a generate(params) -> world with the same shape as gen.js generate.
import { generate } from './gen.js';
import { generate as meadow } from './meadow.js';

export const KINDS = {
  emptymemories: { label: 'Empty memories', generate },
  meadow: { label: 'Meadow', generate: meadow },
};
export const KIND_NAMES = Object.keys(KINDS);
export const generatePlace = (p) => (KINDS[p.kind] || KINDS.emptymemories).generate(p);
