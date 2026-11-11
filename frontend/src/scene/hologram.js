// The look every solid shape on the table can take: a lit rim over a faint fill, with a slow scan line.
// The robot model and a replayed world both use it, so it lives here.
import * as THREE from 'three';

const vertexShader = /* glsl */`
#include <clipping_planes_pars_vertex>
varying vec3 vNormal, vView;
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vNormal = normalize(normalMatrix * normal); vView = normalize(-mvPosition.xyz);
  gl_Position = projectionMatrix * mvPosition;
  #include <clipping_planes_vertex>
}`;

const fragmentShader = /* glsl */`
#include <clipping_planes_pars_fragment>
uniform vec3 base, rim;
uniform float time, opacity;
varying vec3 vNormal, vView;
void main() {
  #include <clipping_planes_fragment>
  float facing = abs(dot(normalize(vNormal), normalize(vView)));
  float edge = pow(1.0 - facing, 2.4);
  float scan = 0.88 + 0.12 * sin(gl_FragCoord.y * 1.4 - time * 4.0);
  vec3 color = base * (0.35 + 0.4 * facing) + rim * edge * 1.5;
  gl_FragColor = vec4(color * scan, (0.42 + edge * 0.58) * opacity);
  #include <colorspace_fragment>
}`;

// base, rim: THREE.Color; time: a {value} shared by everything that should scan together.
export function hologram({base, rim, time, opacity = 0.9, depthWrite = true}) {
  return new THREE.ShaderMaterial({
    uniforms: {base: {value: base}, rim: {value: rim}, time, opacity: {value: opacity}},
    vertexShader, fragmentShader, clipping: true, transparent: true, depthWrite,
  });
}
