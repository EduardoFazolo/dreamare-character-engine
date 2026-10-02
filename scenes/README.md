# Scene files

Each scene is `scenes/<id>.json`. The Editor tab reads and writes these files: it saves as you go, and when a file changes on disk it reloads it live, unless you have unsaved edits open. Characters come from the browser library; `library/characters.json`, written by the editor, lists them by name.

World: metres, y up. The spawn is at the origin; "forward" from the spawn is the direction the camera starts looking.

```jsonc
{
  "id": "the-waiting-field",            // = the file name
  "name": "The Waiting Field",          // title card, finder
  "terrain": { "kind": "emptymemories", "seed": 4242, "biome": { … }, "time": 0.55, "haze": 0.62, "wrongness": 0.2, "name": "Gumboworth Heath", … },
  "ambience": { "night-field-dogs": 0.7, "power-lines": 0.2 },   // ids from public/ambience
  "props": [
    { "id": "rocking-chair", "kind": "rockingChair", "place": { "from": "spawn", "right": -1.5, "forward": 6 }, "face": "spawn" }
  ],
  "actors": [
    { "id": "reginald", "character": "Reginald Rushcombe",       // a library name (or "charId")
      "seat": { "prop": "rocking-chair", "idx": 0 },               // sitting in a prop's seat
      "pose": { "preset": "sit", "look": "camera" } },
    { "id": "pim", "character": "Pim Rattray-Milley",
      "place": { "from": "rocking-chair", "right": 1.2, "forward": 0.6 }, "face": "rocking-chair",
      "pose": { "preset": "crouch", "look": "reginald", "rightHand": { "at": "rocking-chair", "offset": [0, 0.1, 0] } },
      "voice": { "src": "asset:/assets/remember2.wav", "name": "remember2.wav", "loop": false, "autoplay": true } }
  ],
  "directives": [ { "id": "roads", "kind": "converge", "toward": "rocking-chair", "count": 5 } ],
  "shots": [ { "name": "close on the chair", "pos": { "at": "rocking-chair", "offset": [2.2, 1.2, 2.4] }, "look": "rocking-chair", "hide": ["skyline"] } ]  // hide: things this shot leaves out (the player / slides only); "move": { "pos", "look", "roll", "secs" } glides the camera from the shot to there over secs (eased, from when the shot is shown); "roll": a tilted horizon (radians)
}
```

## References

- **point:** `{ "behind": A, "toward": B, "back": m, "up": m, "side": m }` (over A's shoulder, looking at B), `[x, y, z]`, `[x, z]` (on the ground), `"spawn"`, `"camera"`, an actor or prop id or name (a character's head, a prop's middle), or `{ "at": <point>, "offset": [x, y, z] }`.
- **place:** `{ "from": "spawn" | "<id>", "right": m, "forward": m }`, relative to that thing's own facing. It sets x / z. Dragging the thing in the editor replaces it with plain `x` / `z`.
- **face:** `"spawn"`, `"camera"`, an id, or `[x, z]`. It sets `rotY`.
- Plain numbers work anywhere: `"x"`, `"z"`, `"rotY"` (radians), `"scale"`.

## Poses

- **Directed:** `{ "preset": …, "look": <point> | "camera", "leftHand" / "rightHand" / "leftFoot" / "rightFoot": <point>, "hipsDown": m }`.
  - Presets: `stand`, `sit`, `crouch`, `kneel`, `arms-up`, `reach`, `t-pose`. A seated actor defaults to `sit`.
  - Hands and feet reach with two-bone IK and stop at full reach. `"look": "camera"` follows the camera live (like *Look at me*).
- **Face and life** (with any pose):
  - `"face"`: a held expression, 0..1 per face shape: `mouthSmile`, `browInnerUp`, `browUp`, `browDown`, `mouthPucker`, `mouthWide`, `jawOpen`, `eyeBlinkLeft` / `eyeBlinkRight`.
  - `"alive"`: `{ "blink": true, "mutter": 0..1, "sway": 0..1 }` means blinking every few seconds, lips working over words nobody hears, and the head drifting and tilting.

  Both are driven by time alone, so a snapped slide freezes the exact moment.
- **Unhealthy breathing:** `"alive": { "wheeze": 0..1 }` gives breaths that go wrong, one kind per breath:
  - shallow and quick;
  - a catch: the inhale stalls halfway, then a jerky gasp finishes it;
  - a double sniff;
  - a rattle: the exhale shivers out;
  - held too long at the top, then collapsing.

  The chest lifts, the shoulders shrug on the gasps, and the jaw parts a little on them. The neck takes the motion back, so the head stays still. It's seeded from time, so every showing plays the same.
- **Mouthing a phrase:** `"alive": { "chant": seconds }` mouths a slow phrase on a loop ("re-meee-mber the duunes").
- **Twitching:** `"alive": { "twitch": 0..1 }` makes it something wearing a body and not quite knowing how, like the possessed walk in *Obsession*. It's subtle:
  - **Posture:** all the time, a wrong way of holding itself is laid over the walk. The arms are held a little off the sides and hardly swing, the elbows are soft, the wrists cocked, the fingers half-curled and splayed, the knees bent, with a slight hunch and the head low and tilted.
  - **Slips:** now and then, small and fast:
    - `head`: the head jerks.
    - `shoulder`: a shoulder hitches.
    - `fingers`: the fingers flex.
    - `stall`: the walk stops for a split second.
    - `knee`: a knee gives and it catches itself too fast.
    - `repeat`: it takes the same step twice, like a skipping loop.
    - `deadstop`: it stops dead for a second or so, then walks on.
    - `shiver`: a tremor runs down one arm to the fingertips.

    `"twitchKinds": [...]` picks which ones (all by default). They're dealt like a shuffled deck, so every chosen kind comes round before any repeats.
  - It's seeded from the moment the shot starts, so every showing plays the same. Joints stay within the elbow and knee hinges.
- **Walking toward you:** `"approach": { "speed": m/s (0.12), "stop": m (1.5), "backwards": true }`. `backwards` gives the *Obsession* walk: its back to you, walking backwards toward you with `"anim": "Walk"` walks it from where it was placed toward the camera, in a walk slowed to that pace, stopping that far away. In a slide, it starts from its spot each time the shot is shown. `"pose": { "look": "camera", "face": …, "alive": … }` rides on the walk.
- **Reaching and leaning:** `"rightHand": "camera"` (or left) holds the hand out toward the camera, low, like an offering; it follows the camera. `"lean": 0..1` bends the spine toward it. `"bow": radians` (about 1 = deeply stooped) curls the back forward down the spine; the head cranes up further to keep looking at the camera, and a camera hand reaches from the bowed shoulder.
- **Arms and hands:**
  - `"rightElbow"` / `"leftElbow"` (a point) bends the elbow toward it before the hand reaches.
  - `"rightAim"` / `"leftAim"` (a point) bends the wrist so the fingers point at it.
  - `"rightGrip"` / `"leftGrip"` sets the fingers: `"fist"`, `"point"` (the index out), `"claw"`, or `"hook"` (long fingers hooked round a handle).
  - Points can be body-relative: `{ "rel": "<id>", "right", "forward", "up" }`.
- **Following:** a prop with `"hold": { "actor", "hand", "offset" }` hangs from that hand. An actor with `"inside": "<prop id>"`, `"offset"` and a small `"scale"` sits inside that prop, e.g. a tiny person curled in a lantern; that lantern's flame goes out. `"face": "camera"` turns them to you. Lantern glass is dithered see-through.
- **No pose:** the actor plays its clip (`"anim": "Idle" | "Talk" | "Walk" | "Pose"`).
- **Hand-edited poses** are stored as `{ "bones": { … }, "hips": [ … ] }` (per-bone rotations).

## Props

`kind` is one of `rockingChair`, `chair`, `bench`, `table`, `phoneBooth`, `lamp`, `lantern`, `lanternPost`, `lanternTree`, `busStop`, `mailbox`, `deadTree`, `rock`, `mushroom`, `tv`, `doorway`, `swing`. Seats: rocking chair 1, chair 1, bench 3, bus stop 3, swing 1.

## Look

`terrain.look` dresses the same scene three ways. The toggle is *Look* under Mood in the editor:
- **Drawn** (no `look`): the drawn textures under the PS2 shader. This is the default and is unchanged.
- **`"photo"`**: PS2 horror. Real photographs of surfaces (brick, plaster, cobbles, planks, bark, rock, grass, rust, slate), shrunk to 128–256 px, unfiltered, same shader.
- **`"source"`**: Source-engine realism, like Garry's Mod or Half-Life 2. Every surface becomes a lit material, using 512 px photos with normal maps. The scene's sun or moon casts shadows, its ambient becomes sky fill, and fog is ordinary distance fog. The frame is sharper (at least 640 lines) with the tape wear nearly off. Characters are lit the same way.

The photos are CC0 (ambientCG), in `public/textures/photo` and `public/textures/source` (sources in their READMEs). `src/scenario/photolook.js` swaps them in by texture kind and re-maps UVs so each photo tiles at its real size. Things without a photo of their own (mushroom caps, lanterns, cloth) keep their drawn texture.

## Film

`"film"` makes a scene play itself: its shots on a timeline, with 3D sound. In the editor, **🎬 Play film** previews it live and **Export film** renders a 1080×1920 MP4 frame by frame, with the sound mixed offline from the same positions.

```jsonc
"film": {
  "secs": 34.6,
  "shots": [ { "shot": "f1 across the dunes", "from": 0, "to": 9.5 }, … ],   // a shot's "move" runs from its "from"
  "sounds": [
    { "src": "/assets/remember_the_dunes.wav", "lips": true, "ref": 2,        // lips: the mouth follows its loudness
      "at": [ { "t": 0, "actor": "him" }, { "t": 17.5, "actor": "him-near" } ] },
    { "src": "/assets/creepy_breathing.wav", "near": true, "loop": true, "loopEnd": 16.3, "at": [ … ] },
    { "src": "…", "start": 30.6, "offset": 2.6, "at": [ { "t": 0, "actor": "camera", "offset": [0.3, -0.05, 0.35] } ] }
  ],
  "beds": [ { "id": "tonal-wind", "gain": 0.5 } ]                            // ambience, not placed
}
```

- **Sounds come from a character's head,** or from a spot around the camera (`"actor": "camera"`, offset in the camera's own frame).
- **They're HRTF-panned** and lose level with distance. `ref` is the distance at full level.
- **Far away they get duller and wetter:** a lowpass closes and a reverb send opens, so a voice across the dunes sounds across the dunes.
- **`near`:** a sound that only exists up close, like breathing.
- **`start`** is when a sound begins in the film; **`offset`** is where in its file it starts.

## Mist

Moving mist is added to any scene with fog: soft banks standing on the ground around the view, drifting and churning (two layers of noise at different speeds), tinted the fog's colour.
- **How thick** it is follows the scene's fog (`terrain.haze`). `terrain.mist` (0..1) sets it outright, and 0 turns it off, as for an indoor scene.
- **It's driven by time,** so it moves in live slides and exports, and a snapped slide holds it.
- Seen from high up, half the banks float at mid-height between the rooftops.
- **Clouds:** `terrain.clouds` (0..1) adds big cloud banks drifting across the sky and across the moon, dark with moonlit edges.
- The code for both is in `src/scenario/mist.js`.

## Kinds

`terrain.kind` picks the generator that builds the land (`src/scenario/kinds.js`):
- **`emptymemories`** (the default): the original generator. Overcast dunes dissolve into fog, a worn path leads to a lone house, and there are poles, a bus stop, a booth and a pier. Biomes change the ingredients, and the VILLAGE biome is exact.

More kinds plug in beside it.

## Directives

Composition rules: the scene's own things organise the place. They're applied on every load, after the scene's props are placed. A scene without directives is exactly what the kind generates.

| kind | fields | what happens |
|---|---|---|
| `converge` | `toward`, `count` (4), `surface` ("stone" \| "trodden") | that many roads start at the edge of the land, spread around it, and all wander in toward the thing; stone: laid dark cobbles with kerb stones, crumbling toward the edge of the land and whole where they arrive; trodden: a worn line in the grass. Trees and grass keep off them |
| `causeways` | `toward`, `count` (6), `heights` ([5, 32]), `land` (8) | stone walkways from every direction and height: each starts broken off in the air far out, runs level, then steps down in flights of stairs (level, down, level…) on square piers, landing in a ring `land` m round the thing. None comes from the spawn's side, so the thing stays in view |
| `travellers` | `characters` (names), `toward`, `count` (16), `pose` ("kneel"), `lanterns` ("out" \| "none"), `between` ([12, 70]) | people kneeling at the roadside along the converging roads, all facing the thing with heads bowed, their lanterns gone out beside them; generated each load |
| `clearing` | `around`, `radius` (5) | the ground settles flat around it and nothing grows or stands there |
| `sightline` | `from` ("spawn"), `to` | nothing stands between the two: you can always see it |
| `ring` | `prop`, `around`, `radius` (10), `count` (6), `face` ("in" \| "out" \| "along"), `jitter` (0.35), `scale` | that many of a prop round the thing, evenly with a seeded jitter; generated each load, not stored as props |

`toward` / `around` / `to` are prop or actor ids (or any point). In the editor, right-click with a prop or character selected, then **Around …**. From there: make every path lead here, clear the ground, keep it in sight, ring it with a prop, or undo its directives.

Props for lit places: `lantern`, `lanternPost` (a lantern on a hook), `moths` (big pale moths circling a light; lift them to it with `"y"`), `lanternTree` (a dead tree hung with swaying lanterns, one swallowed by the bark). They are all built from the Items tab's Oil Lantern (`items/oil-lantern.json`).

## Character files

`public/characters/<slug>.glb`, listed in `public/characters/index.json` (`[{ file, name, thumb?, params?, face? }]`): characters made outside this browser, e.g. built by Claude with the Characters tab's own export. The editor copies each into this browser's library (id `file:<slug>`), again whenever its `version` changes. Scenes then name them like any other character (`"character": "Old Pim Holwub"`).

Props for the city you reach asleep:
- `dreamStreet`: a cobbled street along the prop's Z (`"length"`, 60 m) between two rows of impossibly tall, narrow houses with a few lit windows. `"gaps": [{ "side": "left" | "right", "at": z, "w": m }]` leaves room for a shop.
- `leaningLamp`: an iron lamp whose post bends over like a neck, its lit shade hanging down to look at you. `"lean"` goes up to about 3; 0 is a plain, honest lamp.
- `jarShop`: a narrow tall shopfront, with shelves of jars behind the window, each holding a flickering light. `"sign"` sets its painted text, `"height"` the building.
- `moon`: a huge moon outside the fog (`"size"` is its diameter). Place it far away, lift it with `"y"`, and face it to the camera.
- `shoes`: a muddy pair of shoes.
- `prints`: a trail of muddy prints along +Z (`"length"`). `"style": "long"` gives bare, too-long feet.
- `lanternPost` also takes `"engraving"` (a brass name plate on the lantern) and `"engravingTurn"` (radians, to face the plate at a shot).

Careful: a prop's `place.right` and a shot's `rel.right` point opposite ways.

A prop's `"y"` lifts it off the ground (a lantern held up). A doorway's `"open"` sets how far its door stands open: 0 keeps it shut.
