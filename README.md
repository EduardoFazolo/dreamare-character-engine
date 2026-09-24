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

**Export GLB** writes a binary glTF 2.0 file. It passes the Khronos glTF validator with 0 errors and 0 warnings.

- The on-screen character is itself the baked asset: the jointed body only drives poses; every rebuild bakes it into one skinned mesh + skeleton (`src/rig.js`).
- Skeleton: 32 bones with Mixamo-style humanoid names (`Hips`, `Spine`, `Spine1`, `Spine2`, `Neck`, `Head`, `LeftShoulder`, `LeftArm`, `LeftForeArm`, `LeftHand`, thumb + 4 fingers, `LeftUpLeg`, `LeftLeg`, `LeftFoot`, `LeftToeBase`, and the Right side). Each bone's +Y points at its child.
- Rest/bind pose: T-pose, meters (about 1.5 m tall), +Y up, facing +Z, feet at y = 0.
- Skinning is rigid: each vertex follows 1 bone (the PS1-style segmented look).
- Clips: `Pose` (the current static pose), `Idle`, `Walk`.
- Materials: unlit (`KHR_materials_unlit`), with the grade and outfit tint baked into the textures and nearest filtering. The PS2 shader itself (wobble, dither, fog) is not exported; recreate it per engine.

Import: Godot 4 and Blender open `.glb` natively, Unreal 5 has a built-in glTF importer, and Unity needs the glTFast package. The bone names are chosen so Unity Humanoid, Godot's humanoid bone map and Unreal's retargeter can auto-map them, which is what lets Mixamo/mocap animations play on these characters.
