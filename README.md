# Dream Face Lab
<img width="2957" height="1574" alt="image" src="https://github.com/user-attachments/assets/11ef5673-48ad-45ce-b6d2-348780690558" />

Texture-first MVP: photo -> MediaPipe landmarks -> canonical-UV face texture -> mutations/grade/makeup -> crude low-poly head with a PS2 renderer.

    npm install && npm run dev   # http://localhost:5177

- Drop any face photos onto the page (AI-generated weathered/grinning faces work best).
- Randomize / Roll 12 to explore; click a gallery tile to load it; Export texture saves the UV PNG.
- Every exported texture uses MediaPipe's canonical face UV layout, so any head mesh built on that layout can wear any face.

## Bodies

Crude jointed body (lathe torso + cylinder limbs, in "head units") with proportion sliders that are allowed to go wrong: head size, neck, shoulders, torso, girth, belly, hunch, arms, hands, fingers, legs, feet.

- Outfits are presets over CC0 photo textures in `public/textures` (ambientCG, 128px tiles); hue/saturation/brightness sliders tint them.
- Poses: stand, hunch, crouch, gunslinger (with revolver), zombie. The lowest point is snapped to the ground.
- Hands, neck and barefoot/naked parts sample the skin color from the face texture, so they match the head.
- Camera: medium (thighs up), full, portrait.

## Export (any engine)

**Export GLB** writes `name.glb` plus `name.report.json`. The goal: a character any engine can use with zero guessing (Three.js, Godot, Unity, Unreal, Blender). Everything the creator knows ships in the file.

**Plain glTF 2.0, valid on its own** (Khronos validator: 0 errors, 0 warnings)
- Meters, +Y up, facing +Z, soles at y = 0. Top-level nodes are `Root` (identity, the ground point between the feet) and `mesh_Character`.
- One mesh, one skin, 33 joints (`Root` + 32 humanoid bones with Mixamo-style names). Each material slot is a primitive named by purpose: `face`, `skin`, `top`, `bottom`, `shoes`, `hat`, `hair`, `prop`.
- Bind pose is the VRM 1.0 T-pose: arms along X, palms down, fingers along X, thumbs 45 degrees forward. Rigid skinning, 1 influence per vertex.
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

**Validation**: every export is checked (humanoid roles, unique names, one skin, identity roots, uniform scale, soles at 0, facing +Z, feet parallel, T-pose arms, weights, clip bone sets, loop continuity, in-place, landmark reach, symmetry). The report is always saved; with any error the `.glb` is not exported.

Not included (yet): face blend shapes / VRM expressions, LODs (characters are ~2.5k triangles), twist bones (rigid skinning can't candy-wrap).
