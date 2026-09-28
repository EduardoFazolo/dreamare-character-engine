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

Hands have a full finger skeleton (optional, on by default): each pose sets a hand shape (relaxed, claw, limp, fist, reach, spider) and Idle/Talk add a slow finger twitch. Poses: stand, hunch, crouch, gunslinger (one arm raised, pointing), zombie, plus creepy ones: broken (neck snapped to one side), lurker (bent over, craning up to stare), puppet (strung up by the wrists), stare (head turned hard to you), crawler, mantis. The **pose** switch next to Randomize decides whether Randomize also picks a pose; off, the current character and every new one stand in the default pose. About 4 in 10 randomized poses are creepy ones. Camera: medium, full, portrait.

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
  - Sometimes (30% of seeds by default; the biome's *phone booth %* slider sets it), just off the path stands an old paned phone booth, its door hanging open and creaking, with a dim TELEPHONE sign and a failing bulb. Its stained lining glows at night and dims when the bulb stutters. The receiver is off the hook, hanging inside on its coiled cord and still swaying slightly, as if someone just let go.
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
  - **Walk (WASD)**: click the view to look with the mouse (pointer lock), WASD or arrows to walk, Shift to run, C to crouch / stand, a toggle (eye height halves, 1.62 → 0.81 m, at half speed), Esc to release the mouse. You follow the ground and can walk out along the pier; you stop at the water and bump into poles, trees and the house. The figure is only ever at a distance: get within 9 m and it's gone.
  - **Full screen** shows the 4:3 frame letterboxed.
  - **Set scene ▸** makes this place (seed, biome, neighbours, mood) the terrain of the scene editor's current scene.
- **Sound** (`src/scenario/audio.js`, WebAudio): not wired by default. Set `PHONE_AUDIO` in `src/scenario/main.js` to an imported audio file's url, and it plays on repeat from the booth's dangling receiver. It starts on your first click or key press, because browsers need a gesture, and the Sound button appears to mute it.
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

### World map and biomes

The Scenarios tab has two views: **World map** and **Scene**.

- **Map** (`src/scenario/world.js`, `mapview.js`):
  - Click empty land to drop a region, an organic blob grown over free cells. The first region is the village.
  - Click a region to select it; double-click to enter it.
  - A selected region can be:
    - **continued** in any of 8 directions: a new region grows from its edge with a biome drifted from its parent, drifting further the deeper the chain goes, sometimes turning into another archetype;
    - **re-rolled** (random biome), **locked** (can't be re-rolled or removed), **removed**, or edited with the biome controls.
  - **Generate scene ▸** builds that region: its seed, biome and mood, with terrain, ground colour, grass and plants fading toward each neighbour past the shared edge. Water faces open map.
  - The map shows soft biome colours that fade into each other, glyphs for what grows there, and names from the place generator.
  - The world autosaves in this browser. **Save world** / **Load world** use a JSON file containing every seed, biome and cell.
- **Biomes** (`src/scenario/biomes.js`, `features.js`) are flat bags of numbers and switches, randomizable and mutable like characters:
  - dunes, hills, water;
  - five ground colours and two grass-tuft colours;
  - plants: none, dead, pine, broadleaf, birch, mushroom (mostly small, a few giants) or willow, with density (woods and clearings), size and tint;
  - rocks, grass tufts, extra houses, ploughed fields with crops;
  - the original set pieces as switches: house, path, bus stop, lamps, fence, poles, radio tower, pier, figure. The phone booth is a chance (0–1), rolled on its own stream: the booth is laid out either way and simply left out, so its absence moves nothing else.
  - Archetypes: village, farmland, pine moor, dead wood, fungal, birch mere, heath, salt flats, willow fen.
- **The village is exact**: `VILLAGE` rebuilds the original scene bit for bit. Every original feature keeps its place in the one random sequence, gated by a switch, and every added feature has its own random stream. This was verified by fingerprinting every mesh's vertices, colours, UVs, normals, transforms, material colours and texture pixels across 8 configurations, before and after.

## Scene editor (`/editor.html`)

A fourth tab composes scenes: a terrain from Scenarios plus characters from the Characters tab (`src/editor/main.js`, storage in `src/store.js`).

- **Getting things in:**
  - **Characters → Send to scene ▸** runs the normal validated export (unlit materials), names the character with the name generator, takes a thumbnail, and adds it to the current scene. Press again for another; the character goes into the library.
  - **Scenarios → Set scene ▸** sets the current scene's terrain. It's stored as the generator's inputs (seed, biome, neighbours, mood) and rebuilt in the editor, so it's identical and tiny.
  - An open editor updates live when another tab sends something.
- **Editing:**
  - Characters get the PS2 shader back and play a clip (Idle by default; Pose, Talk, Walk…).
  - **Camera** (speed and a controls list in the panel's Camera section; H folds the list). The viewport fills the window at 4:3.
    - **WASD** / arrows move level with a little inertia, gliding over the terrain at the travel height: eye level (0.85 m, low like a child's view) by default, shown in the Camera section. Looking down doesn't dive you into the ground, and after orbiting or zooming elsewhere the first steps ease you back to that height. **Space** raises it, **C** toggles a crouch to half of it (0.425 m by default, easing down and back up), **Home** returns to eye level, **Shift** is 3× faster, **Alt** slower, and **1–5** are speed presets (1.5 / 4 / 8 / 16 / 40 m/s).
    - **Dragging always turns the camera** (either button), wherever it starts, even over a character; the view turns 0.09° per pixel, adjustable with the *mouse sensitivity* slider in the Camera section (remembered in this browser). A click without dragging selects the character under it, or deselects on empty ground.
    - Only an **already selected** character can be dragged along the ground, and pose handles exist only while editing a pose, so nothing gets grabbed by accident.
    - The **wheel** steps straight forward / back along the view by a fixed amount that follows the fly speed (2.4 m per notch at 8 m/s).
    - **Alt + drag** orbits around the selected character (or what you're looking at). **Middle-drag** or **Shift + drag** pans.
    - **Double-click** a character to fly to it and select it, or the ground to fly over and look at that spot. **F** frames the selection, **Home** flies back to the start view.
  - Click a character to select it (a ring on the ground); once selected, drag it to move it over the terrain. Q / E turn it (when not flying), Delete removes it, and clicking its name in the list frames it.
  - The panel has name, animation, turn, scale, *Duplicate* and *Face the camera*. The library adds more of any character sent before.
  - **Mood** sliders (time, fog, wrongness, sky hue) restyle the terrain. **Walk (WASD)** and **Full screen** work as on Scenarios.
- **Context menu and props** (`src/scenario/props.js`):
  - A right **click** (not a drag) on the scene opens a menu with:
    - **Spawn prop ▸**, in categories:
      - Furniture: rocking chair, wooden chair, park bench, table;
      - Street: phone booth with its hanging receiver and failing bulb, lamp post, bus stop, mailbox;
      - Nature: dead tree, rock, giant mushroom;
      - Strange: old TV showing live static, lone doorway, swing.
    - **Add character here ▸** (from the library), **Move … here** for the selection, and **Fly here**.
    - Submenus open on hover or click and wait a moment before switching, so cutting diagonally across the menu doesn't close them.
  - Props face the camera when placed and behave like characters: click to select, drag once selected to move, Q / E turn, Delete removes, plus turn and scale sliders. They're built independently of the scenario generator, so the village stays exact.
  - **Seating:**
    - A seatable prop's **Seat a character ▸** enters pick mode: click a character in the scene or in the list (Esc cancels).
    - Seatable props: rocking chair, chair, bench (3 seats), bus stop (3) and swing.
    - The character takes a generated sitting pose (thighs forward, shins down, forearms on the lap, a slight slump, still breathing). It hangs from the seat, so it rocks or swings with it.
    - **Stand up**, dragging the character away, or removing the prop puts it back on its feet in front of the seat.
    - A sitter can still be selected by clicking it, pose-edited with the handles (head, hands, chest…), and turned on its seat (Q / E, *turn on seat*, *Face the camera*); its hips stay on the seat.
  - **Motion:** the rocking chair rocks slowly and softly (about 4.6 s per rock, ±4°); the swing barely moves, as if someone just got off; the booth door creaks.
  - **Saving:** props are saved with the scene (`rec.props`) and exported in the GLB, without their sitters, who export on their own (validator: 0 errors).
- **Voice lines** (`src/editor/voice.js`):
  - A selected character's **voice** menu lists the audio files in `assets/` plus anything added with **Import audio…** (kept in this browser). **▶ Speak** plays the line.
  - **▶ Play scene** starts everyone whose line is marked *in Play scene*; *loop* repeats a line.
  - **3D audio:** the voice comes from the head through an HRTF panner that faces where the head faces. It gets quieter with distance (amplitude ∝ d^−1.15, silent past about 42 m) and loses its highs far away.
  - **Lip sync** is precomputed once per file, locked to the audio clock: loudness and zero-crossing rate every 10 ms, loudness normalised to the file's own speech. Loud sound opens the jaw; hissy sound (s, f, sh) widens the mouth with the jaw half-closed; soft voiced sound rounds it a little. The mouth opens fast and closes slower. It drives the `jawOpen`, `mouthWide` and `mouthPucker` morphs over the clip or pose.
  - Measured: `remember2.wav` opens with 1.2 s of near-silence (−61 dB) and the first phrase starts at 1.3 s; the jaw starts opening at 1.3 s, peaks at 0.73 and closes as the phrase drops off.
  - **Export file** embeds the audio (assets included), so a scene file speaks anywhere. The GLB carries the voice choice as metadata only, because glTF has no standard audio.
- **Captions** (`src/editor/captions.js`), from a pasted script (no speech recognition):
  - The line is split at its pauses: ≥ 0.35 s below 8% of the file's speech loudness, and stretches over 8 s are cut again at their quietest moment. `remember2.wav` becomes 12 stretches, `stranger_on_phone.wav` 6.
  - **The pauses are the frame:** the caption rows are the detected stretches, always all of them. The script's **lines** fill them; sentences are only used when the script is one paragraph. Nothing ever cuts a stretch in the middle.
  - **As many lines as stretches:** line k is stretch k, exactly.
  - **Otherwise:** lines are matched in order, scored by each stretch's syllable peaks (loudness peaks ≥ 110 ms apart; on the phone line 1/1, 5/3, 15/13, 3/4, 8/7 against the real syllables) against the line's syllables, plus its length at this speaker's rate. Only the moves the counts call for are allowed:
    - more stretches than lines: a stretch is left empty (a laugh, an unscripted whisper) or a line runs over several;
    - more lines than stretches: lines share a stretch and show together.
    - Bracketed directions like "(laughs)" take a whole stretch.
  - Measured: a full 12-line script for `remember2.wav` matches line for line. With one line left out, the unscripted stretch (8.3 s) is correctly left empty and the other 11 land exactly. The phone line is exact however it's pasted.
  - **Fixing:** each row has **▶** (hear it), editable text, and **⤓ / ⤒** (shift that line and everything after it down / up one stretch). The status says when the script's line count differs from the stretches found.
  - While lines play, the **nearest** speaker's phrase is the main subtitle at the bottom centre; other speakers' phrases float above their heads, smaller and fading with distance. Same serif italic as the title card. Scripts and timings travel inside scene files.
- **Play / record:** **P** plays / stops the scene. **● Rec (vertical)** records a 1080×1920 clip. The scene renders natively in 9:16 (180×320 game pixels at the default resolution), the subtitles are drawn into the frames (on screen they're page elements), and the voices plus ambience are the audio. It saves an MP4 (H.264 + AAC), or a WebM where MP4 isn't supported.
- **Ambience** (the panel right of the view, `src/editor/ambience.js`):
  - Five calm, ominous CC0 field recordings from Freesound (`public/ambience/CREDITS.md`): night field with dogs far off, soft tonal wind, power lines humming, foghorn at sea, garbled radio static.
  - Each has a checkbox and volume. Beds loop with a 2 s crossfade between overlapping copies, so the loop point is never heard.
  - Saved with the scene; a scene that opens with ambience starts it on the first click (browsers need a gesture). Mixed under the voices, so recordings include it.
- **Look at me:** only the face turns to the camera and the eyes look straight into it. The neck takes a third of the turn (up to ~26°) and the head the rest (up to ~57° more). Whatever angle is left goes to the eye-look morphs (0.40 rad sideways, 0.32 rad up / down), so the eyes meet the lens even past the head's reach. It eases in and out over 0.35 s, works on top of any clip or pose (sitting too), leaves blinks alone, and is saved with the character. Measured: head exactly on the camera (0.0°) when in range; with the camera 90° to the side, the head stops at its limit and the eyes turn fully toward the lens.
- **Posing** (`src/editor/pose.js`): a selected character can hold a still pose instead of an animation.
  - **From photo… / From webcam…** runs MediaPipe (the heavy pose model, `public/models/pose_landmarker_heavy.task`, plus hands) on the picture. It retargets onto the character's skeleton: torso lean and twist, head, arms, hand angles, legs, feet and finger curls.
    - Limbs the photo can't see keep standing, and the hips drop or rise so the feet stay on the ground.
    - The photo's overall turn is left out, so the character keeps its facing in the scene.
    - *mirror photo* swaps sides. The webcam window has **Snap** and **Snap in 3 s** (time to strike the pose yourself) and is mirrored by default.
    - The character eases into the new pose over 0.35 s. Every captured pose lands in the **Poses** library with its photo; click one to pose the selected character like it.
  - **Edit pose (handles)** shows draggable handles, with IK doing the rest:
    - blue hands and green feet use two-bone IK, and elbows and knees keep their bend;
    - the yellow head aims where it looks, with the neck taking a third;
    - the orange chest bends, spread over three spine bones;
    - the pink hips crouch or lean while the feet stay planted; they're clamped to the legs' reach and kept above the lower foot, so the body can't be pulled off its feet or into the ground.
    - Editing an animated character starts from its current frame. **Save to poses** adds the edited pose to the library; **Back to animation** drops it.
  - **Breathing** (on by default) adds a slow, per-character breath on top of a still pose. It isn't stored in the pose.
  - A pose is per-bone local rotations plus the hips position: the same shape a keyframe will need, so poses can later become animation keys. Poses travel with the scene (saved scenes, scene files, the GLB export in pose).
  - Measured:
    - the retargeting math is exact on synthetic landmarks (0° on every limb; head within 5°);
    - a dragged hand follows the mouse up to arm's reach;
    - a 0.45 m hips crouch leaves the planted feet where they were;
    - every rotation is kept unit-length, so after any sequence of drags the bones carry no scale (measured: 0.0000). Before this fix, drift compounded into stretched, giant limbs.
    - Accuracy on real photos is MediaPipe's: good for clear full-body shots, poor for tiny or occluded figures, which report "no person found".
- **Scenes:**
  - The current scene autosaves as a working copy. It can be named (the name is the title card), saved (**Save scene** updates the saved one, **Save as new** forks it), and **loaded** from the list of saved scenes.
  - **New scene** starts empty. Storage is this browser's IndexedDB.
- **Export:**
  - **Export GLB** writes the whole scene as one file: baked terrain plus characters in their current pose with their original materials, and `extras.scene` with the terrain inputs and actors. Validator: 0 errors; skinned-mesh-under-parent warnings only.
  - **Export file** writes a `.scene.json` with the characters' GLBs inside. **Import** restores it anywhere, library included.

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
- **Scenarios use it**: every seed has a coastal place name. It's shown in the panel and fades in over the picture as an old-RPG area card, drawn into the frame so full screen shows it; click the name to show it again. It's saved in the export (`extras.scenario.name`) and the file names (`spindleham-flats-42.glb`).

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
