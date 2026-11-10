// sensor_msgs.PointCloud2 as points of light. The gateway's point-cloud codec sends positions already
// unpacked (and thinned to what the link carries); they are drawn in the cloud's own frame, placed by tf,
// and coloured by height in the fixed frame so a floor, a wall and a ceiling read apart at a glance.
import * as THREE from 'three';
import {Layer} from '../layer.js';

const vertexShader = /* glsl */`
#include <clipping_planes_pars_vertex>
attribute float intensity;
uniform mat4 placement;
uniform float size, viewport, low, high, useIntensity;
varying float vHeight, vIntensity;
void main() {
  vec4 fixedPosition = placement * vec4(position, 1.0);
  vHeight = clamp((fixedPosition.z - low) / max(high - low, 0.001), 0.0, 1.0);
  vIntensity = mix(1.0, 0.35 + 0.65 * intensity, useIntensity);
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  // size is in the robot's metres: a point keeps its place in the world as the table is rescaled.
  float worldScale = length(modelMatrix[0].xyz);
  gl_PointSize = clamp(size * worldScale * projectionMatrix[1][1] * viewport * 0.5 / max(-mvPosition.z, 0.001), 1.5, 48.0);
  #include <clipping_planes_vertex>
}`;

const fragmentShader = /* glsl */`
#include <clipping_planes_pars_fragment>
uniform vec3 colorLow, colorMid, colorHigh;
uniform float opacity;
varying float vHeight, vIntensity;
void main() {
  #include <clipping_planes_fragment>
  float d = length(gl_PointCoord - 0.5);
  if (d > 0.5) discard;
  vec3 color = vHeight < 0.5 ? mix(colorLow, colorMid, vHeight * 2.0) : mix(colorMid, colorHigh, vHeight * 2.0 - 1.0);
  float core = smoothstep(0.5, 0.05, d);
  gl_FragColor = vec4(color * vIntensity * (0.55 + 0.75 * core), opacity * core);
  #include <colorspace_fragment>
}`;

export class CloudLayer extends Layer {
  constructor(layers, topic) {
    super(layers, {kind: 'cloud', label: topic.topic, topic, glyph: 'cloud'});
    const theme = this.theme;
    this.geometry = new THREE.BufferGeometry();
    this.capacity = 0; this.count = 0; this.frameId = ''; this.pointSize = /map/i.test(topic.topic) ? 0.04 : 0.03;
    this.material = this.stage.clip(new THREE.ShaderMaterial({
      uniforms: {
        placement: {value: new THREE.Matrix4()}, size: {value: this.pointSize}, viewport: {value: 1000}, low: {value: -0.2}, high: {value: 2.2},
        useIntensity: {value: 0}, opacity: {value: 0.9},
        colorLow: {value: theme.three.primary.clone()}, colorMid: {value: theme.three.info.clone()}, colorHigh: {value: theme.three.alt.clone()},
      },
      vertexShader, fragmentShader, clipping: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false; this.points.renderOrder = 4;
    // The point size is in pixels, so it needs the height of the viewport being drawn (each eye, in a headset).
    this.points.onBeforeRender = (renderer, scene, camera) => {
      const height = camera.viewport ? camera.viewport.w : renderer.getDrawingBufferSize(SIZE).y;
      if (this.material.uniforms.viewport.value !== height) { this.material.uniforms.viewport.value = height; this.material.uniformsNeedUpdate = true; }
    };
    this.object.add(this.points);
    this.fixedBox = new THREE.Box3();
    theme.addEventListener('change', () => {
      const u = this.material.uniforms; u.colorLow.value.copy(theme.three.primary); u.colorMid.value.copy(theme.three.info); u.colorHigh.value.copy(theme.three.alt);
    });
  }

  start() {
    this.listen(this.bus.subscribe(this.topic.key, {delivery: 'latest', encoding: 'dimos_lcm_pointcloud2', maxHz: 12}, message => {
      const cloud = message.decoded;
      if (!cloud?.positions) return;
      this.frameId = message.header?.frameId ?? cloud.frameId ?? this.frameId;
      this.setPoints(cloud.positions, cloud.intensity || null);
      this.touch();
    }));
  }

  setPoints(positions, intensity) {
    const count = Math.floor(positions.length / 3), geometry = this.geometry;
    if (count > this.capacity) {
      // Grow in steps: a scan's size wobbles, and a new buffer per message would churn the GPU.
      this.capacity = Math.max(count, Math.ceil(this.capacity * 1.5), 4096);
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.capacity * 3), 3).setUsage(THREE.DynamicDrawUsage));
      geometry.setAttribute('intensity', new THREE.BufferAttribute(new Float32Array(this.capacity), 1).setUsage(THREE.DynamicDrawUsage));
    }
    const target = geometry.attributes.position; target.array.set(positions.subarray(0, count * 3)); target.needsUpdate = true;
    target.clearUpdateRanges?.(); target.addUpdateRange?.(0, count * 3);
    const shade = geometry.attributes.intensity;
    if (intensity) { for (let i = 0; i < count; i++) shade.array[i] = intensity[i] / 255; shade.needsUpdate = true; shade.clearUpdateRanges?.(); shade.addUpdateRange?.(0, count); }
    this.material.uniforms.useIntensity.value = intensity ? 1 : 0;
    geometry.setDrawRange(0, count); this.count = count;
    // A scan is drawn as light that adds up; a dense map drawn that way burns to white, so it is drawn as dots.
    const dense = count > 60000, blending = dense ? THREE.NormalBlending : THREE.AdditiveBlending;
    if (this.material.blending !== blending) { this.material.blending = blending; this.material.needsUpdate = true; }
    this.material.uniforms.opacity.value = dense ? 0.6 : 0.9;
    this.detail = `${count.toLocaleString()} pts`;
    this.measure(positions, count);
  }

  // Height range and extent, from a sample: enough for the colours and for framing the table.
  measure(positions, count) {
    const pose = this.tf.lookup(this.frameId);
    if (!pose || !count) return;
    const step = Math.max(1, Math.floor(count / 1500)), heights = [], point = new THREE.Vector3();
    this.fixedBox.makeEmpty();
    // Points above the table's lid are not drawn, so they do not stretch the colour scale either.
    const lid = this.stage.lifeSize ? Infinity : this.stage.view.center.z + this.stage.ceiling;
    for (let i = 0; i < count; i += step) {
      point.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]).applyMatrix4(pose);
      if (point.z > lid) continue;
      heights.push(point.z); this.fixedBox.expandByPoint(point);
    }
    if (heights.length < 2) return;
    heights.sort((a, b) => a - b);
    const low = heights[Math.floor(heights.length * 0.03)], high = heights[Math.floor(heights.length * 0.97)], u = this.material.uniforms;
    // Ease toward the new range so the colours do not flicker from scan to scan.
    u.low.value += (low - u.low.value) * 0.2; u.high.value += (Math.max(high, low + 0.5) - u.high.value) * 0.2;
  }

  bounds() { return this.count ? this.fixedBox : null; }

  update() {
    if (!this.place(this.points, this.frameId)) return;
    this.material.uniforms.placement.value.copy(this.points.matrix);
    this.material.uniforms.size.value = this.pointSize;
  }
}

const SIZE = new THREE.Vector2();
