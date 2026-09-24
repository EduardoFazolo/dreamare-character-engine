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
