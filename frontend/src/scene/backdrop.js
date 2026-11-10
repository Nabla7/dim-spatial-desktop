// What is behind the hologram when there is no room to see: a dark dome with a faint lattice,
// a floor ring and drifting motes. In mixed reality the room is the backdrop, so all of it hides.
import * as THREE from 'three';

const domeFragment = /* glsl */`
uniform vec3 base, glow;
uniform float time;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float horizon = exp(-pow(d.y * 3.2, 2.0));
  // Longitude and latitude lines, thin and far apart, brighter near the horizon.
  float lon = atan(d.z, d.x) * 12.0 / 3.14159265, lat = asin(clamp(d.y, -1.0, 1.0)) * 16.0 / 3.14159265;
  float lines = max(1.0 - min(abs(fract(lon - 0.5) - 0.5) / fwidth(lon), 1.0), 1.0 - min(abs(fract(lat - 0.5) - 0.5) / fwidth(lat), 1.0));
  float breathe = 0.85 + 0.15 * sin(time * 0.35 + d.x * 3.0);
  vec3 color = base + glow * (horizon * 0.10 + lines * horizon * 0.10 * breathe);
  color += glow * 0.04 * smoothstep(0.2, -0.9, d.y);
  gl_FragColor = vec4(color, 1.0);
  #include <colorspace_fragment>
}`;

export class Backdrop {
  constructor(theme) {
    this.theme = theme; this.group = new THREE.Group(); this.group.name = 'backdrop';
    this.uniforms = {base: {value: theme.three.sceneBg.clone()}, glow: {value: theme.three.primary.clone()}, time: {value: 0}};
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(60, 48, 24), new THREE.ShaderMaterial({
      uniforms: this.uniforms, side: THREE.BackSide, depthWrite: false,
      vertexShader: 'varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: domeFragment,
    }));
    this.dome.renderOrder = -10; this.group.add(this.dome);
    // Motes: slow, sparse, lit by the accent. They give the eye something to judge depth against.
    const count = 420, positions = new Float32Array(count * 3), seeds = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const r = 1.2 + Math.random() * 7, a = Math.random() * Math.PI * 2;
      positions.set([Math.cos(a) * r, Math.random() * 4.5 - 0.3, Math.sin(a) * r], i * 3); seeds[i] = Math.random();
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('seed', new THREE.BufferAttribute(seeds, 1));
    this.motes = new THREE.Points(geometry, new THREE.ShaderMaterial({
      uniforms: {color: this.uniforms.glow, time: this.uniforms.time, pixel: {value: 1}},
      vertexShader: /* glsl */`
        attribute float seed; uniform float time, pixel; varying float vAlpha;
        void main() {
          vec3 p = position; p.y += sin(time * 0.12 + seed * 40.0) * 0.25; p.x += cos(time * 0.09 + seed * 17.0) * 0.18;
          vec4 view = modelViewMatrix * vec4(p, 1.0);
          vAlpha = (0.25 + 0.75 * seed) * (0.6 + 0.4 * sin(time * 0.8 + seed * 90.0));
          gl_PointSize = pixel * (1.5 + seed * 3.0) / max(0.4, -view.z);
          gl_Position = projectionMatrix * view;
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 color; varying float vAlpha;
        void main() {
          float d = length(gl_PointCoord - 0.5); if (d > 0.5) discard;
          gl_FragColor = vec4(color, vAlpha * smoothstep(0.5, 0.0, d) * 0.55);
          #include <colorspace_fragment>
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.group.add(this.motes);
    // The floor: concentric rings, so "down" is always readable.
    this.rings = new THREE.Group();
    for (const [radius, opacity] of [[1.4, 0.22], [2.4, 0.13], [3.8, 0.08], [6, 0.05]]) {
      const points = Array.from({length: 129}, (_, i) => new THREE.Vector3(Math.cos(i / 128 * Math.PI * 2) * radius, 0, Math.sin(i / 128 * Math.PI * 2) * radius));
      this.rings.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points),
        new THREE.LineBasicMaterial({color: theme.three.primary, transparent: true, opacity, depthWrite: false})));
    }
    this.group.add(this.rings);
    theme.addEventListener('change', () => {
      this.uniforms.base.value.copy(theme.three.sceneBg); this.uniforms.glow.value.copy(theme.three.primary);
      for (const ring of this.rings.children) ring.material.color.copy(theme.three.primary);
    });
  }

  // passthrough: the session shows the room (immersive-ar), so nothing opaque may be drawn.
  setPassthrough(on) { this.dome.visible = !on; this.rings.visible = !on; this.motes.visible = !on; }

  update(time, renderer) {
    this.uniforms.time.value = time;
    this.motes.material.uniforms.pixel.value = renderer.getPixelRatio() * 14;
  }
}
