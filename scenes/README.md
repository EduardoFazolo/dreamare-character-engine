# Scene files

Each scene is `scenes/<id>.json`. The Editor tab reads and writes these files: it saves as you go, and when a file changes on disk it reloads it live, unless you have unsaved edits open. Characters come from the browser library; `library/characters.json`, written by the editor, lists them by name.

World: metres, y up. The spawn is at the origin; "forward" from the spawn is the direction the camera starts looking.

```jsonc
{
  "id": "the-waiting-field",            // = the file name
  "name": "The Waiting Field",          // title card, finder
  "terrain": { "seed": 4242, "biome": { … }, "time": 0.55, "haze": 0.62, "wrongness": 0.2, "name": "Gumboworth Heath", … },
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
  "shots": [ { "name": "close on the chair", "pos": { "at": "rocking-chair", "offset": [2.2, 1.2, 2.4] }, "look": "rocking-chair" } ]
}
```

## References

- **point:** `[x, y, z]`, `[x, z]` (on the ground), `"spawn"`, `"camera"`, an actor or prop id or name (a character's head, a prop's middle), or `{ "at": <point>, "offset": [x, y, z] }`.
- **place:** `{ "from": "spawn" | "<id>", "right": m, "forward": m }`, relative to that thing's own facing. It sets x / z. Dragging the thing in the editor replaces it with plain `x` / `z`.
- **face:** `"spawn"`, `"camera"`, an id, or `[x, z]`. It sets `rotY`.
- Plain numbers work anywhere: `"x"`, `"z"`, `"rotY"` (radians), `"scale"`.

## Poses

- **Directed:** `{ "preset": …, "look": <point> | "camera", "leftHand" / "rightHand" / "leftFoot" / "rightFoot": <point>, "hipsDown": m }`.
  - Presets: `stand`, `sit`, `crouch`, `kneel`, `arms-up`, `reach`, `t-pose`. A seated actor defaults to `sit`.
  - Hands and feet reach with two-bone IK and stop at full reach. `"look": "camera"` follows the camera live (like *Look at me*).
- **No pose:** the actor plays its clip (`"anim": "Idle" | "Talk" | "Walk" | "Pose"`).
- **Hand-edited poses** are stored as `{ "bones": { … }, "hips": [ … ] }` (per-bone rotations).

## Props

`kind` is one of `rockingChair`, `chair`, `bench`, `table`, `phoneBooth`, `lamp`, `busStop`, `mailbox`, `deadTree`, `rock`, `mushroom`, `tv`, `doorway`, `swing`. Seats: rocking chair 1, chair 1, bench 3, bus stop 3, swing 1.
