# Dreamare Character Engine
<img width="2957" height="1574" alt="image" src="https://github.com/user-attachments/assets/11ef5673-48ad-45ce-b6d2-348780690558" />

Engine-agnostic generator for strange, dreamlike PS2-era humanoids: a photo becomes a mutated face texture (MediaPipe landmarks -> canonical-UV texture -> warps, grade, makeup) on a sculpted, clothed, rigged body that exports to any engine.

    npm install && npm run dev   # http://localhost:5177

- Drop any face photos onto the page (AI-generated weathered/grinning faces work best).
- Randomize / Roll 12 to explore; click a gallery tile to load it; Export texture saves the UV PNG.
- Every exported texture uses MediaPipe's canonical face UV layout, so any head mesh built on that layout can wear any face.

## Bodies

Two styles ("Body style"):

- **sculpted** (default): the body is a signed distance field of blended primitives (ellipsoid torso parts, rounded-cone limbs, rounded-box feet) in the joints' local frames. Each limb smooth-blends into the torso but never into another limb, and each leg is sculpted in its own pass where the other leg doesn't exist (the halves are welded at the pelvis centerline), so legs, pant legs and feet can't be bridged even when they're closer than a grid cell. Fat goes mostly to the torso (legs 40%, arms 60%). It is polygonized with surface nets and decimated to "Poly budget" with meshoptimizer. Hands get their own finer grid. Normals and ambient occlusion come straight from the field (`src/sdf.js`, `src/sculpt.js`).
- **Clothing layers**: garments are separate shells sampled on the same grid: the body pushed out by a thickness ("Clothes looseness"; fur/shag get a thick fuzzy shell), cut by region masks. The shirt has a round neck hole and sleeve length; bottoms are pants (each leg separate, length) or a skirt/robe ("Bottom") that deliberately bridges the legs; plus shoes. Skin fully covered by a garment is removed.
- **segmented**: the original PS1-style rigid segments.

**Clean meshes by construction** (no teeth, fins or holes). The body, clothes and hair are meshed on grids. Every rule below exists because breaking it provably produced artifacts:
- **Nothing finer than the grid.** Fur/shag noise has a wavelength of at least 4 cells. Where two cuts meet (hems, collar, waist, skirt, hairlines, hat line) the crease is rounded by 1.5 cells. Hair tails are at least 2 cells thick.
- **No cut runs parallel to a surface.** A near-parallel cut leaves a sliver thinner than a cell, which meshes as non-manifold teeth:
  - The collar hole is fitted to the measured shirt shell around the neck (fat, clay and fuzz included).
  - The pants floor sits above the flat top of the foot.
  - Feet reach below the ground and are cut flat by a hard ground plane, so soles are exactly on y = 0 with no vertex clamping. The foot pieces are shaped so the cut crosses them at 60 degrees: not tangent (slivers), not a vertical wall (a razor crease).
- **Layers never interpenetrate.** Hems are rounded just past the cut, so cloth keeps its full thickness above the skin right up to the hem (a plain rounded cut brings thin cloth down onto the skin, and the separately decimated meshes then cross into a jagged line). Where full-length pants meet shoes, the shoe rises inside the pants, the cuff thickens to clear it and the shoe thins where it's hidden, so the outer layer always clears the inner one by more than the meshes' chord error.
- **Leg passes weld 1:1.** Where the centerline surface isn't a leg's (crotch, skirt), both passes use identical values, so their seam cells match. Any hole left in the centerline band is filled.
- **After decimation:** zero-volume fins are dropped, folded-back triangle pairs are flipped open, and the outline of a flat sole is locked so it stays on the ground.
- **Head:**
  - Hair lies on a proxy of the body's real (fattened) neck. Below the jaw, long hair only hangs behind the neck's centre plane (never over the throat or chest), and its ends are rounded rather than cut flat.
  - When the hat line trims an extra (like a bun) to less than the grid can mesh, the extra is dropped.
  - A fringe band under a hat brim that's too thin to mesh is lifted away.

Sculpt sliders: muscle, fat (negative thins proportionally), hump, lumps/tumors (seeded), clay lumpiness, sag/melt, sleeve and pants/skirt length, clothes looseness, body grime, poly budget. Proportion sliders (head, neck, shoulders, torso, girth, belly, hunch, arms, hands, fingers, legs, feet) still apply to both styles.

**Baked body texture** (`src/bodybake.js`), like a real PS2 character: the sculpted mesh is auto-unwrapped into charts (one per dominant bone, split into side/cap projections, shelf-packed), then painted from 3D. Fabric is sampled triplanar in bind space, so chart seams and tiling seams don't show. Shirt, pants, shoes and skin boundaries are crisp regardless of triangulation, with hems and stitches, belt and buckle, buttons, baked AO and grime. Outfits are presets over CC0 photo textures in `public/textures` (ambientCG, 128px tiles), with hue/saturation/brightness sliders.

**Skinning**: the sculpted body uses smooth weights (inverse distance to each bone's axis, up to 4 bones, no left/right leakage), so elbows, knees and shoulders bend instead of splitting. Head, hat, hair and props stay rigid.

Hands have a full finger skeleton (optional, on by default): each pose sets a hand shape (relaxed, claw, limp, fist, reach, spider) and Idle/Talk add a slow finger twitch. Poses: stand, hunch, crouch, gunslinger (one arm raised, pointing), zombie, plus creepy ones: broken (neck snapped to one side), lurker (bent over, craning up to stare), puppet (strung up by the wrists), stare (head turned hard to you), crawler, mantis. **Random pose** switches the current character's pose instantly (poses never re-sculpt); about 4 in 10 randomized characters get a creepy one. Camera: medium, full, portrait.

## Head and hair

- **The head is the face.** The 468-point face mesh is the front of the head, and the rest is a hull grown from the face's own outline: 7 rings shrinking back to a point behind the head, with Cranium and Head depth shaping it. So the head continues the face's contour instead of wrapping a face around a skull. The face shape defaults to **fitted**: the person's proportions from the photo on the canonical model's sculpted depth (Head shape also offers canonical and photo).
- **The whole head wears the person's real photo texture.** There's no flat skin and no second texture. Past the face's outline, the hull's UVs mirror back into the face at 1:1 scale, bouncing between the outline and a patch of plain skin (forehead, cheeks, chin). Those skin patches are reached without crossing an eye or the mouth, so nothing stretches into streaks and no feature is mirrored onto the head. The face texture sits on a flat skin-tone background with 1–2% edge padding, and its outline samples the first real skin inward from each landmark, so jaw shadows and background never reach the head.
- A hidden sculpted skull (`src/headsculpt.js`: cranium, occiput, jaw, ears, neck stub) only shapes the hair shell and the fitted hats.
- **The face moves** (`src/faceanim.js`). MediaPipe's topology tells every vertex its role, so the mouth and eyes are cut open where the canonical mesh seals them: 18 triangles across the inner lips, 14 per eye.
  - Behind each eye sits a generated eyeball (`eye` material: sclera, iris with fibres, pupil, highlight), so it reads as an eye whatever the warps did to the photo. Its colours come from the photo's own eye area: the iris from the darkest pixels (a little more saturated), the sclera from the brightest, pulled toward white. Void eyes makeup turns them black. The eyeballs rotate to look around.
  - Behind the lips sits a mouth interior (`mouth` material): a dark cavity plus upper and lower teeth.
  - Thirteen morph targets are built from anatomy: `jawOpen` (a rotation about the jaw hinge, weighted below the lip line), `mouthSmile`, `mouthPucker`, `mouthWide`, `eyeBlinkLeft`/`eyeBlinkRight` (the lid rows close to a line), and `eyeLookUp`/`Down`/`Left`/`Right` (the eyeballs rotate). Three brow shapes move the photo's own brows (MediaPipe labels 10 landmarks per brow): `browUp`, `browDown` (lowered and pulled together) and `browInnerUp` (worried). They fall off softly into the forehead and quickly above the eyelids.
  - **Idle** blinks and glances, **Walk** blinks, and **Talk** (a new clip, also in the Animation menu) cycles mouth shapes.
- Hair is a shell over the skull, cut by per-style masks (like clothing): bald, buzz (painted stubble), short, bowl, horseshoe, slicked, mullet, long, afro, mohawk, pompadour, bun, ponytail, pigtails, spiky. Extra shapes (bun, tails, quiff) are added on top of the shell. A non-zero hair hue dyes the hair (works on black hair too). **Hairstyle: auto** picks one from the photo.
- The photo is segmented once per face with MediaPipe's multiclass selfie segmenter (hair / face skin / body skin / clothes): the person's real hair color, a patch of their actual hair (used as the hair texture), and where hair sits (style guess). Hair volume, hue and brightness sliders on top.
- The hair shell gets its own baked atlas: the person's hair texture with strands running down from the crown, and dye. Material slots: `face` (the whole head), `hair` (plus `hairStrands` for the extra stringy strands).
- Skin matches the face. The body and hands wear the face's graded skin tone, sampled with makeup switched off (cheek flush used to make necks pinker than the face). Bare skin uses a fine, seamless, low-contrast mottle instead of coarse checkers.
- "Stringy" strands are wisps rooted on the hair shell's lower edge (never on bald skull), hanging straight down, tinted with the shell's own painted color.
- Hats fit the head: the crown is a sculpted shell around skull + forehead cut at a hat line just above the brow, with a shape per type and a brim or visor sized to the head: bowler, cowboy, fedora, top hat, beanie, baseball cap, flat cap, fez, wizard. Each has its own texture; Hat hue tints it. Under a hat, hair (and buns/tails) only shows below the hat line. About 1 in 5 randomized characters wears one.
- The head sculpt runs in its own worker (`src/head.worker.js`) next to the body's; it only re-sculpts when the face outline, skull or hair params change.

## Scenarios (`/scenario.html`)

A second tab builds seeded outdoor places in the style of an old, empty PS1/PS2 RPG field (`src/scenario/`). It uses the same vertex snap, affine UVs, dither and VHS pass as the character page.

**The Dunes**: overcast grass dunes that dissolve into fog.

- **Look**:
  - The sky meets the fog exactly at the horizon, so nothing has an edge.
  - The colours are muted time-of-day keys: grey dawn, overcast noon, bruised dusk, night. The post pass drains the colour and lifts the blacks.
  - Lighting is gouraud with baked vertex colour. `src/scenario/material.js` handles grass, bare sand on steep slopes, the wet shore, the worn path, dark hollows and blob shadows under every object. Merged props use flat normals, for faceted PS1 shading.
- **Layout**:
  - You stand on a low rise. A worn path meanders to a lone house with one warm window.
  - Along the path: an empty bus stop, lamp posts that light at dusk, and an old fence with missing posts.
  - Just off the path stands an old paned phone booth, its door hanging open and creaking, with a dim TELEPHONE sign and a failing bulb. Its stained lining glows at night and dims when the bulb stutters. The receiver is off the hook, hanging inside on its coiled cord and still swaying slightly, as if someone just let go.
  - Around you: a few bare trees, sparse pale grass, and telephone poles walking off into the fog both ways.
  - Far away, a radio tower's red light blinks through the haze.
  - Dark still water lies to one side, with a pier running out into the fog.
  - Sometimes someone stands at the edge of the fog, facing you.
- **Sliders**:
  - Place: seed, dune height, prop density.
  - Mood: time of day, sky hue, fog, and **wrongness**. Wrongness tilts and floats props, drops planks and posts, lights the window at noon, and makes the figure likelier and closer.
  - Render: resolution, colour, VHS, texture warp.
- **Controls**:
  - View mode: drag to look, wheel to step along your view, "drift" slowly turns the camera.
  - **Walk (WASD)**: click the view to look with the mouse (pointer lock), WASD or arrows to walk, Shift to run, Esc to release the mouse. You follow the ground and can walk out along the pier; you stop at the water and bump into poles, trees and the house. The figure is only ever at a distance: get within 9 m and it's gone.
  - **Full screen** shows the 4:3 frame letterboxed.
  - **● Rec (vertical)** records a TikTok clip: while recording, the game renders natively in 9:16 (180×320 game pixels at the default resolution, output 1080×1920, 30 fps) and captures what you hear (the phone's 3D audio, when wired; otherwise the clip is silent). Click again to stop and it saves an MP4 (H.264 + AAC), or a WebM where the browser can't encode MP4. Walk mode works while recording.
- **Sound** (`src/scenario/audio.js`, WebAudio): not wired by default. Set `PHONE_AUDIO` in `src/scenario/main.js` to an imported audio file's url, and it plays on repeat from the booth's dangling receiver. It starts on your first click or key press, because browsers need a gesture, and the Sound button appears to mute it. Recordings include it.
  - The song is normalised to a −1 dBFS peak.
  - Phone speaker chain:
    - a steep 300 Hz–3.3 kHz phone-line band with a 1.7 kHz presence bump;
    - a 1.3 ms comb for the plastic handset cavity;
    - soft clipping for a small speaker;
    - faint line hiss.
  - It's positioned in 3D with an HRTF panner at the receiver, which follows the receiver as it sways. The earpiece is directional: it's loudest out of the open door, with a cone that's 0.4× to the sides and behind.
  - Distance loss is custom: amplitude ∝ d^−1.6, faded to silence between 12 and 26 m, because a small speaker doesn't carry. Highs thin out with distance. The signal stays nearly dry so it's pinned to the receiver.
  - The booth's solid back wall muffles it further (lowpass to 900 Hz, −5 dB).
  - Measured relative to the phone's own output: inside the booth −6 dB, 2 m in front −15, 8 m −33, 15 m −42, 25 m silent (−86), 2 m to the side −21, 2 m behind −26 and muffled.
- Everything is deterministic in the seed; a rebuild takes ~120 ms.
- **Export scenario (GLB)** bakes the materials to unlit textured materials with vertex colours (validator: 0 errors). `extras.scenario` carries the params, the spawn point and the fog colour and range.

## Names (`/names.html`)

A third tab generates names in a genteel, mouthful, old-English style with a little French (`src/names/gen.js`, seeded, no dependencies).

- **People** use weighted patterns:
  - given name + surname (*Cecil Thimbleworth*);
  - double-barrelled (*Winifred Ashby-Crumb*);
  - title + surname (*Mr Gristlecombe*);
  - spelled-out initials (*Emm. Tee. Muttonfold*);
  - *Old* + nickname + an invented lump (*Old Pim Holwub*);
  - *de la* (*Eustace de la Marrow*);
  - sometimes a title in front of a full name.
- **Surnames** are built like real English ones, a root plus *-worth, -combe, -wick, -hurst, -bottom*..., from plain roots or odd domestic ones (*treacle, gristle, custard, thimble*). Lumps come from a small sound generator: round vowels, one consonant pile-up, always sayable.
- **The mouthful check** keeps names of 4–9 syllables with some b/p/m/g/d weight. The Salad Fingers originals are blocked.
- **Places** (general or coastal):
  - *Nettlecombe Pier*, *The Cumberwick Field*;
  - *Nether Plumbage*, *Cobblebridge-upon-Gravy*;
  - *Nanny Radhurst's Sands*, *St Enid's Sands*.
- **Sliders**: whimsy (plausible British → full nonsense), French, titles, how many, seed. Click a name to copy it; ☆ keeps it in this browser's list; *Copy all* and *Copy kept* copy the lists.
- **Scenarios use it**: every seed has a coastal place name. It's shown in the panel and fades in over the picture as an old-RPG area card, drawn into the frame so full screen and recordings show it; click the name to show it again. It's saved in the export (`extras.scenario.name`) and the file names (`spindleham-flats-42.glb`).

## Performance

- **Dependency-aware rebuilds**: the body sculpt is cached by a key of only the params that can change its geometry. Face, grade, makeup, outfit color, grime, render, pose and accessory changes never re-sculpt (~20 ms); the body texture is re-baked on the GPU only when its inputs change. Animated bounds are computed at export only.
- **Off the main thread**: the sculpt runs in a Web Worker (`src/sculpt.worker.js`), so the UI never freezes; the previous character stays on screen and is swapped atomically when the new one is ready. Only the newest request is queued while sliders move.
- **Parallel**: the worker fans out to a pool (`src/sampler.worker.js`): the grid is sampled in row slabs, and body, each garment and both hands are meshed and shaded concurrently. Slabs merge with the same rules as a single pass (earliest exact evaluation wins, else latest fill), so the output is bit-identical to the single-threaded path, which stays as a fallback.
- **Narrow band**: the distance field is evaluated exactly only near the surface and clothing offsets (three levels of provably-far block skipping); surface nets only scan blocks with a sign change and each leg pass only its half.

Geometry sliders: ~120-200 ms until the new body appears, 0 ms of main-thread blocking. Other sliders: ~20 ms.

## Export (any engine)

**Export character** downloads one `name.zip` with `name.glb`, `name.report.json` and `textures/face.png` + `textures/body.png` + `textures/head.png` (already embedded in the GLB; there for engines that want them separately). Files are named `dreamare_<outfit>_<id>`, where the id comes from the character's seed. The goal: a character any engine can use with zero guessing (Three.js, Godot, Unity, Unreal, Blender). Everything the creator knows ships in the file.

**Plain glTF 2.0, valid on its own** (Khronos validator: 0 errors, 0 warnings)
- Meters, +Y up, facing +Z, soles at y = 0. Top-level nodes are `Root` (identity, the ground point between the feet) and `mesh_Character`.
- One mesh, one skin, 53 joints (`Root` + 52 humanoid bones with Mixamo-style names, including three bones per finger and thumb). With **Finger bones: none** it's 23 joints and the hands are rigid. Each material slot is a primitive named by purpose: `face`, `head`, `hair`, `hairStrands`, `skin`, `top`, `bottom`, `shoes`, `hat`, `prop`. In the sculpted style, `top`/`bottom`/`shoes`/`skin` share one baked body texture, so they stay separately recolorable.
- Bind pose is the VRM 1.0 T-pose: arms along X, palms down, fingers along X, thumbs 45 degrees forward. Sculpted body: smooth skinning, up to 4 influences. Segmented body and head/accessories: rigid, 1 influence.
- Materials are PBR by default (roughness 1) or unlit (`KHR_materials_unlit`) via "Export materials". The grade and outfit tint are baked into the textures; the PS2 shader is not exported.
- Clips: `Pose`, `Idle`, `Walk`, `Talk`, all in place, same bone set, each also animating the face morph weights.
- Face: 13 named morph targets on `mesh_Character` (`extras.targetNames`, also `extras.character.face`).

**VRM 1.0 (`VRMC_vrm`)**: `meta` plus the `humanoid.humanBones` map, role to node index (hips ... toes, thumb metacarpal, 4 finger proximals). `expressions.preset` binds the VRM presets to the face morph targets: aa, ih, ou, ee, oh, blink, blinkLeft, blinkRight, happy, surprised, angry, sad, relaxed, lookUp, lookDown, lookLeft, lookRight. `lookAt` is expression-driven. Loads as an avatar in three-vrm, UniVRM, the VRM add-ons for Blender/Godot and VRM4U. Tools that don't know VRM ignore it.

**`extras.character`** (on the glTF root and on the `Root` node), all in meters, with node indices:
- `humanoid`: role -> bone/node. `hinges`: elbow/knee bend axis (bone-local, positive = bend) plus limits.
- `landmarks`: height, bodyHeight, eyeHeight, shoulderHeight, hipWidth, leg length per side, feet (heel, toe tip, ball, length, width, ankle and sole height), eyes, grip points plus axes, center of mass.
- `nodes`: landmark/socket empties parented to bones (`lm_*`, `socket_*Grip`, `socket_*Hip`, `socket_headTop`, `socket_back`).
- `colliders`: per-bone capsules (bone-local, along +Y) with mass, a controller capsule, total mass.
- `bounds`: rest and max-pose (every frame of every clip). `masks`: upperBody, lowerBody, head, arms, legs. `materials`: slot -> index.
- `animations` (also on each `animations[i].extras.animation`): role, loop, fps, in-place speed (m/s), foot contacts `[down, up]` (an interval with down > up wraps over the loop point), footDown/footUp events.

**Validation**: every export is checked (humanoid roles, unique names, one skin, identity roots, uniform scale, soles at 0, facing +Z, feet parallel, T-pose arms, weights, clip bone sets, loop continuity, in-place, landmark reach, symmetry). The report is always saved; with any error only the report is downloaded, no `.glb`.

Not included (yet): LODs (characters are ~2.5k triangles), twist bones (rigid skinning can't candy-wrap).
