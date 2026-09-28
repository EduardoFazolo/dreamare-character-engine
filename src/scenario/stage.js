// The scenario look, shared by the Scenarios page and the scene editor: a low-res 4:3 render target upscaled
// through the VHS / old-console grade pass, plus the area-name title card drawn into the frame.
import * as THREE from 'three';
import { PS2 } from '../head.js';

export function createStage(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
  THREE.ColorManagement.enabled = false;
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 4 / 3, 0.1, 800);

  let lowRT;
  const post = new THREE.ShaderMaterial({
    uniforms: { tex: { value: null }, lowRes: { value: new THREE.Vector2() }, vhs: { value: 0.6 }, time: { value: 0 }, sat: { value: 0.7 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }`,
    fragmentShader: /* glsl */`
      uniform sampler2D tex; uniform vec2 lowRes; uniform float vhs, time, sat; varying vec2 vUv;
      float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
      void main(){
        vec2 uv = vUv; uv.x += vhs * .0015 * sin(uv.y * 30. + time * 2.);
        vec2 px = 1. / lowRes;
        vec3 c = texture2D(tex, uv).rgb;
        vec3 blur = (texture2D(tex, uv - vec2(px.x, 0)).rgb + 2. * c + texture2D(tex, uv + vec2(px.x, 0)).rgb) * .25;
        float r = texture2D(tex, uv + vec2(px.x * 1.5, 0)).r, b = texture2D(tex, uv - vec2(px.x * 1.5, 0)).b;
        vec3 col = mix(c, mix(vec3(r, blur.g, b), blur, .4), vhs);
        col *= 1. - vhs * .1 * (.5 + .5 * sin(vUv.y * lowRes.y * 6.2832));
        col += (hash(vUv * 900. + time) - .5) * .05 * vhs;
        vec2 q = vUv - .5; col *= 1. - dot(q, q) * .7 * vhs;
        col = mix(col, col * vec3(1.03, .98, 1.06), vhs);
        // dream bloom: bright areas bleed softly
        vec3 halo = (texture2D(tex, uv + px * vec2(3., 2.)).rgb + texture2D(tex, uv - px * vec2(3., 2.)).rgb + texture2D(tex, uv + px * vec2(-2., 3.)).rgb + texture2D(tex, uv - px * vec2(-2., 3.)).rgb) * .25;
        col += max(halo - .6, 0.) * .6 * vhs;
        // old-console grade: drained colour, lifted blacks, a touch less contrast
        col = mix(vec3(dot(col, vec3(.299, .587, .114))), col, sat);
        col = col * .92 + .035;
        gl_FragColor = vec4(col, 1.);
      }`,
    depthTest: false,
  });
  const postScene = new THREE.Scene();
  postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), post));
  const postCam = new THREE.OrthographicCamera(); postCam.position.z = 1; // the title card sits at z = 0, in front of the near plane

  // area-name card (old RPG style): drawn into the frame itself, so full screen shows it too
  const cardCanvas = document.createElement('canvas'); cardCanvas.width = 1024; cardCanvas.height = 160;
  const cardTex = new THREE.CanvasTexture(cardCanvas); cardTex.colorSpace = THREE.NoColorSpace;
  const card = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: cardTex, transparent: true, opacity: 0, depthTest: false }));
  card.position.set(0, -0.45, 0); postScene.add(card);
  let cardT0 = -1e9;
  function drawCard(name) {
    const g = cardCanvas.getContext('2d'), W = cardCanvas.width, H = cardCanvas.height;
    g.clearRect(0, 0, W, H);
    g.font = 'italic 64px Georgia, "Times New Roman", serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    const tw = Math.min(W - 40, g.measureText(name).width);
    g.strokeStyle = 'rgba(230,224,210,.55)'; g.lineWidth = 2; // a thin rule under it, like an area title
    g.beginPath(); g.moveTo(W / 2 - tw / 2 - 20, H / 2 + 44); g.lineTo(W / 2 + tw / 2 + 20, H / 2 + 44); g.stroke();
    g.shadowColor = 'rgba(0,0,0,.85)'; g.shadowBlur = 10; g.shadowOffsetY = 3;
    g.fillStyle = '#ece6d6'; g.fillText(name, W / 2, H / 2, W - 40);
    cardTex.needsUpdate = true; cardT0 = performance.now() / 1000;
  }
  function fitCard() { // keep the card's pixels square
    const a = renderer.domElement.width / renderer.domElement.height, w = a > 1 ? 1.2 : 2.1;
    card.position.y = a > 1 ? -0.45 : -0.6;
    card.scale.set(w, (w * cardCanvas.height) / cardCanvas.width * a, 1);
  }
  // 4:3 at `res` lines, shown 3x. vertical (recording): 9:16, 0.75 x res game pixels wide (240 -> 180x320), 1080 wide out
  function setRes(res, vertical = false) {
    let w, h, scale;
    if (vertical) { w = Math.round(res * 0.75); h = Math.round((w * 16) / 9); scale = 1080 / w; } else { h = res; w = Math.round((h * 4) / 3); scale = 3; }
    camera.aspect = w / h; camera.fov = vertical ? 70 : 55; camera.updateProjectionMatrix();
    canvas.classList.toggle('vertical', vertical);
    lowRT?.dispose();
    lowRT = new THREE.WebGLRenderTarget(w, h, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    post.uniforms.tex.value = lowRT.texture;
    post.uniforms.lowRes.value.set(w, h);
    PS2.snapRes.value.set(w / 2, h / 2);
    renderer.setSize(Math.round(w * scale), Math.round(h * scale), false);
    fitCard();
  }
  function render(t) {
    post.uniforms.time.value = t;
    const a = t - cardT0; // card: fade in, hold, fade out
    card.material.opacity = Math.min(THREE.MathUtils.smoothstep(a, 0.4, 1.4), 1 - THREE.MathUtils.smoothstep(a, 4.2, 5.4)); card.visible = card.material.opacity > 0.001;
    renderer.setRenderTarget(lowRT); renderer.render(scene, camera);
    renderer.setRenderTarget(null); renderer.render(postScene, postCam);
  }
  return { renderer, scene, camera, post, setRes, render, drawCard, set vhs(v) { post.uniforms.vhs.value = v; }, set sat(v) { post.uniforms.sat.value = v; } };
}

// scenario materials don't survive glTF: bake them to plain unlit textured materials (fog / snap are the host
// engine's job). Returns a clone of `group` ready for GLTFExporter.
export function bakeForExport(group) {
  const out = group.clone(true), mats = new Map();
  out.traverse((m) => {
    if (!m.material) return;
    const src = m.material;
    if (!mats.has(src)) {
      if (src.isShaderMaterial) {
        const c = src.uniforms.color.value, k = Math.max(1, c.r, c.g, c.b); // glTF colour factors stop at 1
        const b = new THREE.MeshBasicMaterial({ map: src.uniforms.map.value, color: c.clone().multiplyScalar(1 / k), alphaTest: src.uniforms.alphaTest.value, side: src.side, vertexColors: src.vertexColors });
        b.name = src.name; mats.set(src, b);
      } else mats.set(src, src);
    }
    m.material = mats.get(src);
  });
  return out;
}
