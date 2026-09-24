# Dream Face Lab

Texture-first MVP: photo -> MediaPipe landmarks -> canonical-UV face texture -> mutations/grade/makeup -> crude low-poly head with a PS2 renderer.

    npm install && npm run dev   # http://localhost:5177

- Drop any face photos onto the page (AI-generated weathered/grinning faces work best).
- Randomize / Roll 12 to explore; click a gallery tile to load it; Export texture saves the UV PNG.
- Every exported texture uses MediaPipe's canonical face UV layout, so any head mesh built on that layout can wear any face.
