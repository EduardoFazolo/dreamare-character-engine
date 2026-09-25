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

Poses: stand, hunch, crouch, gunslinger (with revolver), zombie, plus creepy ones: broken (neck snapped to one side), lurker (bent over, craning up to stare), puppet (strung up by the wrists), stare (head turned hard to you), crawler, mantis. **Random pose** switches the current character's pose instantly (poses never re-sculpt); about 4 in 10 randomized characters get a creepy one. Camera: medium, full, portrait.

## Head and hair

- The photo face stays a mask on the front; the rest of the head is sculpted (`src/headsculpt.js`): cranium, occiput, jaw, ears (Ear size) and a neck stub, plus small spheres along the mask's rim so the skull swallows the photo's edge. The photo fades into the skin tone over its outer rim (the same tone the skull, neck and hands wear), so the face melts into the head instead of looking like a photo stuck on one. Wherever the photo actually shows, the skull stays behind it: every skull triangle there is checked and pushed back until none crosses the face. The head re-sculpts (in its worker) whenever the face's shape changes, so it always matches the current face.
- Hair is a shell over the skull, cut by per-style masks (like clothing): bald, buzz (painted stubble), short, bowl, horseshoe, slicked, mullet, long, afro, mohawk, pompadour, bun, ponytail, pigtails, spiky. Extra shapes (bun, tails, quiff) are added on top of the shell. A non-zero hair hue dyes the hair (works on black hair too). **Hairstyle: auto** picks one from the photo.
- The photo is segmented once per face with MediaPipe's multiclass selfie segmenter (hair / face skin / body skin / clothes): the person's real hair color, a patch of their actual hair (used as the hair texture), and where hair sits (style guess). Hair volume, hue and brightness sliders on top.
- The skull and hair get their own baked atlas: skin tone that blends into the photo's own edge colors near the face (no pale frame), stubble, strands running down from the crown, AO behind the ears. Material slots: `head`, `hair` (plus `hairStrands` for the extra stringy strands).
- Skin matches the face. The body, hands and skull wear the face's graded skin tone, sampled with makeup switched off (cheek flush used to make necks pinker than the face). The mask's border samples the photo 12% in, so hair or background at the face's edge never reaches it, and the skull around it reads those same border colors. Bare skin uses a fine, seamless, low-contrast mottle instead of coarse checkers.
- "Stringy" strands are wisps rooted on the hair shell's lower edge (never on bald skull), hanging straight down, tinted with the shell's own painted color.
- Hats fit the head: the crown is a sculpted shell around skull + forehead cut at a hat line just above the brow, with a shape per type and a brim or visor sized to the head: bowler, cowboy, fedora, top hat, beanie, baseball cap, flat cap, fez, wizard. Each has its own texture; Hat hue tints it. Under a hat, hair (and buns/tails) only shows below the hat line. About 1 in 5 randomized characters wears one.
- The head sculpt runs in its own worker (`src/head.worker.js`) next to the body's; it only re-sculpts when the face outline, skull or hair params change.

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
- One mesh, one skin, 33 joints (`Root` + 32 humanoid bones with Mixamo-style names). Each material slot is a primitive named by purpose: `face`, `head`, `hair`, `hairStrands`, `skin`, `top`, `bottom`, `shoes`, `hat`, `prop`. In the sculpted style, `top`/`bottom`/`shoes`/`skin` share one baked body texture, so they stay separately recolorable.
- Bind pose is the VRM 1.0 T-pose: arms along X, palms down, fingers along X, thumbs 45 degrees forward. Sculpted body: smooth skinning, up to 4 influences. Segmented body and head/accessories: rigid, 1 influence.
- Materials are PBR by default (roughness 1) or unlit (`KHR_materials_unlit`) via "Export materials". The grade and outfit tint are baked into the textures; the PS2 shader is not exported.
- Clips: `Pose`, `Idle`, `Walk`, all in place, same bone set.

**VRM 1.0 (`VRMC_vrm`)**: `meta` plus the `humanoid.humanBones` map, role to node index (hips ... toes, thumb metacarpal, 4 finger proximals). Loads as an avatar in three-vrm, UniVRM, the VRM add-ons for Blender/Godot and VRM4U. Tools that don't know VRM ignore it.

**`extras.character`** (on the glTF root and on the `Root` node), all in meters, with node indices:
- `humanoid`: role -> bone/node. `hinges`: elbow/knee bend axis (bone-local, positive = bend) plus limits.
- `landmarks`: height, bodyHeight, eyeHeight, shoulderHeight, hipWidth, leg length per side, feet (heel, toe tip, ball, length, width, ankle and sole height), eyes, grip points plus axes, center of mass.
- `nodes`: landmark/socket empties parented to bones (`lm_*`, `socket_*Grip`, `socket_*Hip`, `socket_headTop`, `socket_back`).
- `colliders`: per-bone capsules (bone-local, along +Y) with mass, a controller capsule, total mass.
- `bounds`: rest and max-pose (every frame of every clip). `masks`: upperBody, lowerBody, head, arms, legs. `materials`: slot -> index.
- `animations` (also on each `animations[i].extras.animation`): role, loop, fps, in-place speed (m/s), foot contacts `[down, up]` (an interval with down > up wraps over the loop point), footDown/footUp events.

**Validation**: every export is checked (humanoid roles, unique names, one skin, identity roots, uniform scale, soles at 0, facing +Z, feet parallel, T-pose arms, weights, clip bone sets, loop continuity, in-place, landmark reach, symmetry). The report is always saved; with any error only the report is downloaded, no `.glb`.

Not included (yet): face blend shapes / VRM expressions, LODs (characters are ~2.5k triangles), twist bones (rigid skinning can't candy-wrap).
