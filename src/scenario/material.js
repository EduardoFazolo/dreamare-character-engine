// Scenario material: the character page's PS2 shader (vertex snap, affine uvs, 15-bit dither, fog) plus
// what old outdoor RPG scenes lean on: per-vertex colour (baked terrain tint, hollows, blob shadows) and a
// dim, directional gouraud light set by the scene's time of day.
import * as THREE from 'three';
import { PS2 } from '../head.js';

// shared by every scenario material; generate() sets them
export const SCENE = {
  lightDir: { value: new THREE.Vector3(0.4, 0.7, 0.5).normalize() },
  lightCol: { value: new THREE.Color(0.8, 0.8, 0.78) },
  ambient: { value: new THREE.Color(0.45, 0.46, 0.46) },
};

let _white;
const white = () => { if (!_white) { _white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1); _white.needsUpdate = true; } return _white; };

// glow: unlit (windows, lamps); still fogs, so lights sink into the haze like everything else
export function oldMaterial({ map, color = [1, 1, 1], alphaTest = 0, side = THREE.FrontSide, vertexColors = false, glow = false } = {}) {
  const m = new THREE.ShaderMaterial({
    side, vertexColors,
    defines: glow ? { GLOW: 1 } : {},
    uniforms: {
      ...PS2, ...SCENE,
      map: { value: map || white() },
      color: { value: new THREE.Color(...color) },
      alphaTest: { value: alphaTest },
    },
    vertexShader: /* glsl */`
      uniform vec2 snapRes; uniform float fogNear, fogFar; uniform vec3 lightDir, lightCol, ambient;
      varying vec3 vUvw; varying vec2 vUvP; varying vec3 vLight; varying float vFog;
      void main(){
        vec4 mv = modelViewMatrix * vec4(position, 1.);
        vec4 cp = projectionMatrix * mv;
        cp.xy = floor(cp.xy / cp.w * snapRes + .5) / snapRes * cp.w;
        gl_Position = cp;
        #ifdef GLOW
          vLight = vec3(1.);
        #else
          vec3 n = normalize(mat3(modelMatrix) * normal);
          vLight = ambient + lightCol * max(dot(n, lightDir), 0.);
        #endif
        #ifdef USE_COLOR
          vLight *= color;
        #endif
        vUvw = vec3(uv * cp.w, cp.w); vUvP = uv;
        vFog = smoothstep(fogNear, fogFar, -mv.z);
      }`,
    fragmentShader: /* glsl */`
      uniform sampler2D map; uniform vec3 color, fogColor; uniform float affine, alphaTest;
      varying vec3 vUvw; varying vec2 vUvP; varying vec3 vLight; varying float vFog;
      float bayer2(vec2 a){ a = floor(a); return fract(a.x / 2. + a.y * a.y * .75); }
      float bayer4(vec2 a){ return bayer2(.5 * a) * .25 + bayer2(a); }
      void main(){
        vec2 uv = mix(vUvP, vUvw.xy / vUvw.z, affine);
        vec4 t = texture2D(map, uv);
        if (t.a < alphaTest) discard;
        vec3 c = t.rgb * color * vLight;
        c = mix(c, fogColor, vFog);
        c = floor(clamp(c, 0., 1.) * 31. + bayer4(gl_FragCoord.xy)) / 31.;
        gl_FragColor = vec4(c, 1.);
      }`,
  });
  m.name = glow ? 'glow' : 'lit';
  return m;
}
