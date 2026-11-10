// Cameras. A depth image with a colour image and intrinsics becomes a textured surface standing where
// the camera sees it: the depth is unprojected on the GPU (a grid whose vertices read the depth texture),
// so a new frame costs one texture upload. A colour image alone is a frustum with the picture on its far end.
import * as THREE from 'three';
import {Layer} from '../layer.js';

const surfaceVertex = /* glsl */`
#include <clipping_planes_pars_vertex>
uniform sampler2D depthMap;
uniform vec4 intrinsics;      // fx, fy, cx, cy in source pixels
uniform vec2 sourceSize, cell; // cell: one grid step in uv
uniform float depthScale, nearLimit, farLimit, edge;
varying vec2 vUv;
varying float vValid, vDepth;
float depthAt(vec2 at) { return texture2D(depthMap, at).r * depthScale; }
void main() {
  vUv = uv;
  float z = depthAt(uv);
  float a = depthAt(uv - vec2(cell.x, 0.0)), b = depthAt(uv + vec2(cell.x, 0.0)), c = depthAt(uv - vec2(0.0, cell.y)), d = depthAt(uv + vec2(0.0, cell.y));
  // A vertex next to a hole or a depth jump is marked; the fragment shader drops everything that touches it,
  // so a surface never stretches from an object to the wall behind it.
  float jump = max(max(abs(z - a), abs(z - b)), max(abs(z - c), abs(z - d)));
  bool ok = z > nearLimit && z < farLimit && min(min(a, b), min(c, d)) > nearLimit && jump < edge * z + 0.012;
  vValid = ok ? 1.0 : 0.0; vDepth = z;
  vec2 pixel = uv * sourceSize;
  vec3 optical = vec3((pixel.x - intrinsics.z) * z / intrinsics.x, (pixel.y - intrinsics.w) * z / intrinsics.y, z);
  vec4 mvPosition = modelViewMatrix * vec4(optical, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <clipping_planes_vertex>
}`;

const surfaceFragment = /* glsl */`
#include <clipping_planes_pars_fragment>
uniform sampler2D colorMap;
uniform float hasColor, opacity, time;
uniform vec3 tint;
varying vec2 vUv;
varying float vValid, vDepth;
void main() {
  #include <clipping_planes_fragment>
  if (vValid < 0.995) discard;
  vec3 color = hasColor > 0.5 ? texture2D(colorMap, vec2(vUv.x, 1.0 - vUv.y)).rgb : tint * (0.25 + 0.75 * fract(vDepth * 4.0));
  // A faint moving contour in depth: it reads as a scan passing over the surface.
  float sweep = exp(-pow((fract(vDepth * 0.5 - time * 0.25) - 0.5) * 14.0, 2.0));
  gl_FragColor = vec4(color + tint * sweep * 0.12, opacity);
  #include <colorspace_fragment>
}`;

function frustum(theme) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(16 * 3), 3));
  const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({color: theme.three.primary, transparent: true, opacity: 0.75, depthWrite: false}));
  lines.frustumCulled = false;
  return lines;
}

// The eight edges of a view pyramid of the given depth, in the optical frame (x right, y down, z forward).
function setFrustum(lines, K, width, height, depth) {
  const corner = (u, v) => [(u - K[2]) * depth / K[0], (v - K[5]) * depth / K[4], depth];
  const c = [corner(0, 0), corner(width, 0), corner(width, height), corner(0, height)], p = lines.geometry.attributes.position;
  let i = 0;
  for (let k = 0; k < 4; k++) { p.setXYZ(i++, 0, 0, 0); p.setXYZ(i++, ...c[k]); p.setXYZ(i++, ...c[k]); p.setXYZ(i++, ...c[(k + 1) % 4]); }
  p.needsUpdate = true;
  return c;
}

class CameraBase extends Layer {
  constructor(layers, options, {color, info}) {
    super(layers, options);
    this.colorTopic = color; this.infoTopic = info; this.K = null; this.size = [0, 0]; this.feed = null; this.frameId = '';
    this.rig = new THREE.Group(); this.object.add(this.rig);
    this.frustum = frustum(this.theme); this.rig.add(this.frustum); this.stage.clip(this.frustum.material);
  }

  startCamera() {
    if (this.colorTopic) this.feed = this.layers.feeds.acquire(this.colorTopic);
    if (this.infoTopic) this.listen(this.bus.subscribeDecoded(this.infoTopic.key, {delivery: 'latest', maxHz: 1}, info => {
      if (!info.K || !(info.K[0] > 0)) return;
      this.K = Array.from(info.K); this.size = [info.width, info.height];
      if (!this.frameId && info.header?.frame_id) this.frameId = info.header.frame_id;
    }));
  }

  stop() { super.stop(); this.layers.feeds.release(this.feed); this.feed = null; }

  bounds() {
    const pose = this.tf.lookup(this.frameId);
    return pose && this.frameId ? new THREE.Box3().setFromCenterAndSize(new THREE.Vector3().setFromMatrixPosition(pose), new THREE.Vector3(1.5, 1.5, 1)) : null;
  }
}

export class RgbdLayer extends CameraBase {
  constructor(layers, {depth, color, info}) {
    super(layers, {kind: 'rgbd', label: color ? `${color.topic} + depth` : depth.topic, topic: depth, glyph: 'camera'}, {color, info});
    this.depthTopic = depth; this.depthTexture = null; this.grid = null; this.dims = [0, 0];
    this.uniforms = {
      depthMap: {value: null}, colorMap: {value: null}, intrinsics: {value: new THREE.Vector4(1, 1, 0, 0)}, sourceSize: {value: new THREE.Vector2(1, 1)},
      cell: {value: new THREE.Vector2()}, depthScale: {value: 1}, nearLimit: {value: 0.05}, farLimit: {value: 12}, edge: {value: 0.045},
      hasColor: {value: 0}, opacity: {value: 1}, time: {value: 0}, tint: {value: this.theme.three.primary.clone()},
    };
    this.material = this.stage.clip(new THREE.ShaderMaterial({uniforms: this.uniforms, vertexShader: surfaceVertex, fragmentShader: surfaceFragment, clipping: true, side: THREE.DoubleSide}));
    this.theme.addEventListener('change', () => this.uniforms.tint.value.copy(this.theme.three.primary));
  }

  start() {
    this.startCamera();
    this.listen(this.bus.subscribe(this.depthTopic.key, {delivery: 'latest', encoding: 'dimos_lcm_depth', maxHz: 15}, message => {
      const depth = message.decoded;
      if (!depth?.data || !depth.width) return;
      this.frameId = message.header?.frameId || depth.frameId || this.frameId;
      this.setDepth(depth); this.touch();
    }));
  }

  setDepth(depth) {
    const {width, height, data} = depth;
    if (this.dims[0] !== width || this.dims[1] !== height) {
      this.depthTexture?.dispose();
      this.depthTexture = new THREE.DataTexture(new Float32Array(width * height), width, height, THREE.RedFormat, THREE.FloatType);
      this.depthTexture.minFilter = this.depthTexture.magFilter = THREE.NearestFilter;
      this.uniforms.depthMap.value = this.depthTexture; this.dims = [width, height];
      // The grid is at most 256 columns: finer than that is past what a headset resolves on a table.
      const columns = Math.min(width, 256), rows = Math.max(2, Math.round(columns * height / width));
      this.grid?.geometry.dispose(); this.grid?.removeFromParent();
      const geometry = new THREE.PlaneGeometry(1, 1, columns - 1, rows - 1), uv = geometry.attributes.uv;
      // PlaneGeometry's v runs bottom to top; image rows run top to bottom.
      for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
      this.grid = new THREE.Mesh(geometry, this.material); this.grid.frustumCulled = false; this.grid.renderOrder = 2;
      this.rig.add(this.grid);
      this.uniforms.cell.value.set(1 / (columns - 1), 1 / (rows - 1));
    }
    const target = this.depthTexture.image.data;
    // 16-bit depth is millimetres, 32-bit float depth is metres (the ROS conventions).
    if (data instanceof Float32Array) target.set(data); else for (let i = 0; i < target.length; i++) target[i] = data[i] * 0.001;
    this.depthTexture.needsUpdate = true;
    this.source = [depth.sourceWidth || width, depth.sourceHeight || height];
    this.detail = `${width}×${height}`;
  }

  update(now) {
    if (!this.K || !this.grid) { this.rig.visible = false; return; }
    if (!this.place(this.rig, this.frameId)) return;
    const u = this.uniforms, [width, height] = this.source;
    // Intrinsics are given for the camera info's resolution; rescale them to the depth image's source size.
    const sx = this.size[0] ? width / this.size[0] : 1, sy = this.size[1] ? height / this.size[1] : 1;
    u.intrinsics.value.set(this.K[0] * sx, this.K[4] * sy, this.K[2] * sx, this.K[5] * sy);
    u.sourceSize.value.set(width, height); u.time.value = now / 1000;
    const ready = this.feed && this.feed.video.readyState >= 2;
    u.colorMap.value = ready ? this.feed.texture : null; u.hasColor.value = ready ? 1 : 0;
    setFrustum(this.frustum, [this.K[0] * sx, 0, this.K[2] * sx, 0, this.K[4] * sy, this.K[5] * sy], width, height, 0.12);
  }
}

export class CameraLayer extends CameraBase {
  constructor(layers, {color, info}) {
    super(layers, {kind: 'camera', label: color.topic, topic: color, glyph: 'camera'}, {color, info});
    this.screen = new THREE.Mesh(new THREE.BufferGeometry(), this.stage.clip(new THREE.MeshBasicMaterial({side: THREE.DoubleSide, transparent: true, opacity: 0.92})));
    this.screen.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
    this.screen.geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]), 2));
    this.screen.geometry.setIndex([0, 1, 2, 0, 2, 3]); this.screen.frustumCulled = false;
    this.rig.add(this.screen);
  }

  start() { this.startCamera(); }

  update() {
    const feed = this.feed;
    if (feed?.frameId) this.frameId = feed.frameId;
    if (feed?.lastAt) this.lastAt = feed.lastAt;
    if (!this.K || !feed || feed.video.readyState < 2 || !this.frameId) { this.rig.visible = false; return; }
    if (!this.place(this.rig, this.frameId)) return;
    const width = this.size[0] || feed.width, height = this.size[1] || feed.height;
    const corners = setFrustum(this.frustum, this.K, width, height, 0.6), p = this.screen.geometry.attributes.position;
    corners.forEach((corner, i) => p.setXYZ(i, ...corner)); p.needsUpdate = true;
    if (this.screen.material.map !== feed.texture) { this.screen.material.map = feed.texture; this.screen.material.needsUpdate = true; }
    this.detail = `${feed.width}×${feed.height}`;
  }
}
