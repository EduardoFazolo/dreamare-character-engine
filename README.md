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

Sculpt sliders: muscle, fat (negative thins proportionally), hump, lumps/tumors (seeded), clay lumpiness, sag/melt, sleeve and pants/skirt length, clothes looseness, body grime, poly budget. Proportion sliders (head, neck, shoulders, torso, girth, belly, hunch, arms, hands, fingers, legs, feet) still apply to both styles.

**Baked body texture** (`src/bodybake.js`), like a real PS2 character: the sculpted mesh is auto-unwrapped into charts (one per dominant bone, split into side/cap projections, shelf-packed), then painted from 3D. Fabric is sampled triplanar in bind space, so chart seams and tiling seams don't show. Shirt, pants, shoes and skin boundaries are crisp regardless of triangulation, with hems and stitches, belt and buckle, buttons, baked AO and grime. Outfits are presets over CC0 photo textures in `public/textures` (ambientCG, 128px tiles), with hue/saturation/brightness sliders.

**Skinning**: the sculpted body uses smooth weights (inverse distance to each bone's axis, up to 4 bones, no left/right leakage), so elbows, knees and shoulders bend instead of splitting. Head, hat, hair and props stay rigid.

Poses: stand, hunch, crouch, gunslinger (with revolver), zombie. Camera: medium, full, portrait.

## Performance

- **Dependency-aware rebuilds**: the body sculpt is cached by a key of only the params that can change its geometry. Face, grade, makeup, outfit color, grime, render, pose and accessory changes never re-sculpt (~20 ms); the body texture is re-baked on the GPU only when its inputs change. Animated bounds are computed at export only.
- **Off the main thread**: the sculpt runs in a Web Worker (`src/sculpt.worker.js`), so the UI never freezes; the previous character stays on screen and is swapped atomically when the new one is ready. Only the newest request is queued while sliders move.
- **Parallel**: the worker fans out to a pool (`src/sampler.worker.js`): the grid is sampled in row slabs, and body, each garment and both hands are meshed and shaded concurrently. Slabs merge with the same rules as a single pass (earliest exact evaluation wins, else latest fill), so the output is bit-identical to the single-threaded path, which stays as a fallback.
- **Narrow band**: the distance field is evaluated exactly only near the surface and clothing offsets (three levels of provably-far block skipping); surface nets only scan blocks with a sign change and each leg pass only its half.

Geometry sliders: ~120-200 ms until the new body appears, 0 ms of main-thread blocking. Other sliders: ~20 ms.

## Export (any engine)

**Export character** downloads one `name.zip` with `name.glb`, `name.report.json` and `textures/face.png` + `textures/body.png` (already embedded in the GLB; there for engines that want them separately). Files are named `dreamare_<outfit>_<id>`, where the id comes from the character's seed. The goal: a character any engine can use with zero guessing (Three.js, Godot, Unity, Unreal, Blender). Everything the creator knows ships in the file.

**Plain glTF 2.0, valid on its own** (Khronos validator: 0 errors, 0 warnings)
- Meters, +Y up, facing +Z, soles at y = 0. Top-level nodes are `Root` (identity, the ground point between the feet) and `mesh_Character`.
- One mesh, one skin, 33 joints (`Root` + 32 humanoid bones with Mixamo-style names). Each material slot is a primitive named by purpose: `face`, `skin`, `top`, `bottom`, `shoes`, `hat`, `hair`, `prop`. In the sculpted style, `top`/`bottom`/`shoes`/`skin` share one baked body texture, so they stay separately recolorable.
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
