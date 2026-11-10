// The holotable: the robot's world, shown as a miniature that can be moved, turned and rescaled,
// or at life size around the viewer. Everything a stream draws is a child of `world`, in the
// robot's own coordinates (x forward, y left, z up, metres); only this file knows about the view.
import * as THREE from 'three';

const SIDES = 6;
// Robot world (x forward, y left, z up) -> three.js (x right, y up, z back).
const BASIS = new THREE.Matrix4().set(0, -1, 0, 0, 0, 0, 1, 0, -1, 0, 0, 0, 0, 0, 0, 1);

const tableVertex = /* glsl */`
varying vec2 vPlane;
void main() { vPlane = position.xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

// A metric grid in the robot's coordinates, so it slides and scales with the world rather than with the table.
const tableFragment = /* glsl */`
uniform float radius, scale, yaw, time, opacity;
uniform vec2 center;
uniform vec3 color, colorAlt;
varying vec2 vPlane;
float gridLines(vec2 p, float step) {
  vec2 q = p / step;
  vec2 g = abs(fract(q - 0.5) - 0.5) / max(fwidth(q), vec2(1e-5));
  return 1.0 - min(min(g.x, g.y), 1.0);
}
void main() {
  float c = cos(yaw), s = sin(yaw);
  vec2 local = vec2(vPlane.x * c - vPlane.y * s, vPlane.x * s + vPlane.y * c) / scale;
  vec2 world = center - vec2(local.y, local.x);
  // The step between lines is the power of ten that keeps them a hand's width apart on the table.
  float decade = log(0.045 / scale) / log(10.0);
  float lower = pow(10.0, ceil(decade)), blend = 1.0 - fract(decade);
  float minor = gridLines(world, lower) * blend * 0.35;
  float major = gridLines(world, lower * 10.0) * 0.8;
  float axes = (1.0 - min(abs(world.x) / max(fwidth(world.x), 1e-5), 1.0)) + (1.0 - min(abs(world.y) / max(fwidth(world.y), 1e-5), 1.0));
  float r = length(vPlane) / radius;
  float fade = smoothstep(1.0, 0.55, r);
  float sweep = 0.10 * exp(-pow((r - fract(time * 0.12)) * 9.0, 2.0));
  float glow = 0.05 * (1.0 - r);
  vec3 rgb = mix(color, colorAlt, clamp(axes, 0.0, 1.0));
  float alpha = (max(minor, major) * 0.55 + clamp(axes, 0.0, 1.0) * 0.5 + sweep + glow) * fade * opacity;
  gl_FragColor = vec4(rgb, alpha);
  #include <colorspace_fragment>
}`;

function hexPoints(radius, y = 0) {
  return Array.from({length: SIDES + 1}, (_, i) => {
    const a = Math.PI / SIDES + i * 2 * Math.PI / SIDES;
    return new THREE.Vector3(radius * Math.sin(a), y, radius * Math.cos(a));
  });
}

export class Stage {
  constructor(theme, {radius = 0.5} = {}) {
    this.theme = theme; this.radius = radius;
    this.root = new THREE.Group(); this.root.name = 'stage';
    this.world = new THREE.Group(); this.world.name = 'world'; this.world.matrixAutoUpdate = false;
    this.root.add(this.world);
    this.view = {center: new THREE.Vector3(), scale: 0.15, yaw: 0};
    this.target = {center: new THREE.Vector3(), scale: 0.15, yaw: 0};
    this.lifeSize = false; this.clipping = true;
    this.clipPlanes = Array.from({length: SIDES}, () => new THREE.Plane());
    this.noPlanes = [];
    this.materials = new Set();
    this.table = new THREE.Group(); this.root.add(this.table);
    this.uniforms = {
      radius: {value: radius}, scale: {value: 1}, yaw: {value: 0}, time: {value: 0}, opacity: {value: 1},
      center: {value: new THREE.Vector2()}, color: {value: theme.three.primary.clone()}, colorAlt: {value: theme.three.alt.clone()},
    };
    const disc = new THREE.Mesh(new THREE.CircleGeometry(radius, SIDES, Math.PI / SIDES - Math.PI / 2).rotateX(-Math.PI / 2), new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: tableVertex, fragmentShader: tableFragment,
      transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    }));
    disc.renderOrder = 1; this.table.add(disc); this.disc = disc;
    this.lines = [];
    const line = (points, opacity, dashed = false) => {
      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      const material = dashed
        ? new THREE.LineDashedMaterial({color: theme.three.primary, transparent: true, opacity, dashSize: 0.012, gapSize: 0.018, depthWrite: false})
        : new THREE.LineBasicMaterial({color: theme.three.primary, transparent: true, opacity, depthWrite: false});
      const object = new THREE.Line(geometry, material);
      if (dashed) object.computeLineDistances();
      this.table.add(object); this.lines.push(object);
      return object;
    };
    line(hexPoints(radius), 0.95);
    line(hexPoints(radius * 1.045), 0.4, true);
    line(hexPoints(radius * 1.09, -0.012), 0.16);
    // A low wall of light on each edge: the volume the projection fills.
    const wall = [], alpha = [], top = 0.07, ring = hexPoints(radius);
    for (let i = 0; i < SIDES; i++) {
      const a = ring[i], b = ring[i + 1];
      wall.push(a.x, 0, a.z, b.x, 0, b.z, b.x, top, b.z, a.x, 0, a.z, b.x, top, b.z, a.x, top, a.z);
      alpha.push(1, 1, 0, 1, 0, 0);
    }
    const wallGeometry = new THREE.BufferGeometry();
    wallGeometry.setAttribute('position', new THREE.Float32BufferAttribute(wall, 3));
    wallGeometry.setAttribute('alpha', new THREE.Float32BufferAttribute(alpha, 1));
    this.wall = new THREE.Mesh(wallGeometry, new THREE.ShaderMaterial({
      uniforms: {color: this.uniforms.color, opacity: {value: 0.22}},
      vertexShader: 'attribute float alpha; varying float vAlpha; void main(){ vAlpha = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform vec3 color; uniform float opacity; varying float vAlpha; void main(){ gl_FragColor = vec4(color, vAlpha * vAlpha * opacity); \n#include <colorspace_fragment>\n }',
      transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    }));
    this.table.add(this.wall);
    theme.addEventListener('change', () => {
      this.uniforms.color.value.copy(theme.three.primary); this.uniforms.colorAlt.value.copy(theme.three.alt);
      for (const object of this.lines) object.material.color.copy(theme.three.primary);
    });
    this.apply();
  }

  // Make a material obey the table's edge. Life size shows everything.
  clip(material) {
    this.materials.add(material);
    material.clippingPlanes = this.lifeSize || !this.clipping ? this.noPlanes : this.clipPlanes;
    return material;
  }

  setClipping(on) {
    this.clipping = on;
    for (const material of this.materials) { material.clippingPlanes = this.lifeSize || !on ? this.noPlanes : this.clipPlanes; material.needsUpdate = true; }
  }

  setLifeSize(on) {
    this.lifeSize = on; this.table.visible = !on;
    if (on) this.target.scale = 1;
    this.setClipping(this.clipping);
  }

  // Scale about a point given in three.js world coordinates (the pinch centre, the cursor), so it stays put.
  scaleAbout(factor, pivot = null) {
    const next = THREE.MathUtils.clamp(this.target.scale * factor, 0.002, 4);
    if (pivot) {
      const anchored = this.toRobot(pivot.clone());
      this.target.scale = this.view.scale = next; this.apply();
      const moved = this.toRobot(pivot.clone());
      this.target.center.add(anchored.sub(moved)); this.view.center.copy(this.target.center);
    } else this.target.scale = next;
    this.apply();
  }

  // Show a robot-frame box: centre it and pick the scale that fits it on the table.
  frame(box) {
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3()), span = Math.max(size.x, size.y, 0.4);
    box.getCenter(this.target.center); this.target.center.z = box.min.z;
    if (!this.lifeSize) this.target.scale = THREE.MathUtils.clamp(this.radius * 1.7 / span, 0.002, 4);
  }

  toRobot(point) { return this.world.worldToLocal(point); }
  toScene(point) { return this.world.localToWorld(point); }

  apply() {
    const {center, scale, yaw} = this.view;
    this.world.matrix.makeRotationY(yaw).scale(new THREE.Vector3(scale, scale, scale)).multiply(BASIS)
      .multiply(new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z));
    this.world.matrixWorldNeedsUpdate = true;
    this.root.updateMatrixWorld(true);
    this.uniforms.scale.value = scale; this.uniforms.yaw.value = yaw; this.uniforms.center.value.set(center.x, center.y);
    // Six planes through the table's edges, facing inward, in scene coordinates.
    const apothem = this.radius * Math.cos(Math.PI / SIDES), normal = new THREE.Vector3(), point = new THREE.Vector3();
    const rotation = new THREE.Matrix3().setFromMatrix4(this.root.matrixWorld);
    for (let i = 0; i < SIDES; i++) {
      const a = i * 2 * Math.PI / SIDES;
      normal.set(-Math.sin(a), 0, -Math.cos(a));
      point.set(Math.sin(a) * apothem, 0, Math.cos(a) * apothem).applyMatrix4(this.root.matrixWorld);
      this.clipPlanes[i].setFromNormalAndCoplanarPoint(normal.applyMatrix3(rotation).normalize(), point);
    }
  }

  update(time, dt) {
    const k = 1 - Math.exp(-dt * 9);
    this.view.center.lerp(this.target.center, k);
    this.view.scale += (this.target.scale - this.view.scale) * k;
    this.view.yaw += (this.target.yaw - this.view.yaw) * k;
    this.uniforms.time.value = time;
    this.apply();
  }
}
