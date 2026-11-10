// Where the robot is, where it means to go and what it believes about the floor:
// poses with a trail, paths as a line of light, occupancy grids as a textured plane.
import * as THREE from 'three';
import {Layer} from '../layer.js';

const poseOf = message => message.pose?.pose ?? message.pose ?? null;

export class PoseLayer extends Layer {
  constructor(layers, topic) {
    super(layers, {kind: 'pose', label: topic.topic, topic, glyph: 'axes'});
    const theme = this.theme;
    this.frame = new THREE.Group(); this.marker = new THREE.Group(); this.frame.add(this.marker); this.object.add(this.frame);
    const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.24, 4).rotateZ(-Math.PI / 2).translate(0.12, 0, 0),
      this.stage.clip(new THREE.MeshBasicMaterial({color: theme.three.alt, transparent: true, opacity: 0.9, wireframe: true})));
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.16, 0.18, 40), this.stage.clip(new THREE.MeshBasicMaterial({color: theme.three.alt, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false})));
    this.marker.add(arrow, ring);
    this.capacity = 2000; this.count = 0; this.head = 0; this.last = new THREE.Vector3(Infinity, 0, 0);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.capacity * 3), 3).setUsage(THREE.DynamicDrawUsage));
    this.trail = new THREE.Line(geometry, this.stage.clip(new THREE.LineBasicMaterial({color: theme.three.alt, transparent: true, opacity: 0.6, depthWrite: false})));
    this.trail.frustumCulled = false; this.frame.add(this.trail);
    this.frameId = ''; this.position = new THREE.Vector3();
  }

  start() {
    this.listen(this.bus.subscribeDecoded(this.topic.key, {delivery: 'latest', maxHz: 30}, message => {
      const pose = poseOf(message);
      if (!pose?.position) return;
      this.frameId = message.header?.frame_id || this.frameId;
      this.position.set(pose.position.x, pose.position.y, pose.position.z);
      this.marker.position.copy(this.position);
      this.marker.quaternion.set(pose.orientation.x, pose.orientation.y, pose.orientation.z, pose.orientation.w).normalize();
      // The trail grows only when the robot has moved; at its capacity the oldest half is dropped.
      if (this.position.distanceTo(this.last) > 0.03) {
        const points = this.trail.geometry.attributes.position;
        if (this.count === this.capacity) { points.array.copyWithin(0, this.capacity * 1.5, this.capacity * 3); this.count = this.capacity / 2; }
        points.setXYZ(this.count++, this.position.x, this.position.y, this.position.z); points.needsUpdate = true;
        this.trail.geometry.setDrawRange(0, this.count); this.last.copy(this.position);
      }
      this.touch();
    }));
  }

  bounds() {
    const pose = this.lastAt ? this.tf.lookup(this.frameId) : null;
    return pose ? new THREE.Box3().setFromCenterAndSize(this.position.clone().applyMatrix4(pose), new THREE.Vector3(1.5, 1.5, 1)) : null;
  }

  update() { this.place(this.frame, this.frameId); }
}

export class PathLayer extends Layer {
  constructor(layers, topic) {
    super(layers, {kind: 'path', label: topic.topic, topic, glyph: 'pulse'});
    this.line = new THREE.Line(new THREE.BufferGeometry(), this.stage.clip(new THREE.LineBasicMaterial({color: this.theme.three.ok, transparent: true, opacity: 0.95, depthWrite: false})));
    this.line.frustumCulled = false; this.line.renderOrder = 6; this.object.add(this.line); this.frameId = ''; this.box = new THREE.Box3();
  }

  start() {
    this.listen(this.bus.subscribeDecoded(this.topic.key, {delivery: 'latest', maxHz: 10}, message => {
      const poses = message.poses || [], positions = new Float32Array(poses.length * 3);
      poses.forEach((stamped, i) => { const p = poseOf(stamped)?.position; if (p) positions.set([p.x, p.y, p.z + 0.02], i * 3); });
      this.line.geometry.dispose(); this.line.geometry = new THREE.BufferGeometry();
      this.line.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      this.line.geometry.computeBoundingBox(); this.box.copy(this.line.geometry.boundingBox);
      this.frameId = message.header?.frame_id || this.frameId; this.detail = `${poses.length} poses`; this.touch();
    }));
  }

  bounds() { const pose = this.tf.lookup(this.frameId); return pose && !this.box.isEmpty() ? this.box.clone().applyMatrix4(pose) : null; }
  update() { this.place(this.line, this.frameId); }
}

export class GridLayer extends Layer {
  constructor(layers, topic) {
    super(layers, {kind: 'grid', label: topic.topic, topic, glyph: 'grid'});
    this.material = this.stage.clip(new THREE.MeshBasicMaterial({transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false}));
    this.plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.material); this.plane.renderOrder = 1;
    // outer is placed by tf at the grid's frame; origin is the grid's own origin pose inside that frame.
    this.outer = new THREE.Group(); this.origin = new THREE.Group(); this.origin.add(this.plane); this.outer.add(this.origin); this.object.add(this.outer);
    this.frameId = ''; this.box = new THREE.Box3();
  }

  start() {
    this.listen(this.bus.subscribeDecoded(this.topic.key, {delivery: 'latest', maxHz: 4}, message => {
      const info = message.info, width = info?.width, height = info?.height, cells = message.data;
      if (!width || !height || !cells || cells.length < width * height) return;
      const pixels = new Uint8Array(width * height * 4), free = this.theme.rgba.primary, wall = this.theme.rgba.alt;
      for (let i = 0; i < width * height; i++) {
        const value = cells[i];
        // Unknown cells are clear, free cells a faint wash, occupied cells bright in proportion to their cost.
        if (value < 0) continue;
        const t = Math.min(1, value / 100), color = t > 0.02 ? wall : free;
        pixels[i * 4] = color[0] * 255; pixels[i * 4 + 1] = color[1] * 255; pixels[i * 4 + 2] = color[2] * 255; pixels[i * 4 + 3] = t > 0.02 ? 70 + 185 * t : 22;
      }
      this.material.map?.dispose();
      const texture = new THREE.DataTexture(pixels, width, height, THREE.RGBAFormat);
      texture.colorSpace = THREE.SRGBColorSpace; texture.magFilter = THREE.NearestFilter; texture.needsUpdate = true;
      this.material.map = texture; this.material.needsUpdate = true;
      const resolution = info.resolution || 0.05, at = info.origin?.position || {x: 0, y: 0, z: 0}, q = info.origin?.orientation;
      // Cell (0, 0) is at the origin; x runs along the columns and y along the rows.
      this.plane.scale.set(width * resolution, height * resolution, 1);
      this.plane.position.set(width * resolution / 2, height * resolution / 2, 0);
      this.origin.position.set(at.x, at.y, at.z + 0.005);
      if (q && (q.x || q.y || q.z || q.w)) this.origin.quaternion.set(q.x, q.y, q.z, q.w).normalize();
      this.box.setFromCenterAndSize(new THREE.Vector3(at.x + width * resolution / 2, at.y + height * resolution / 2, at.z), new THREE.Vector3(width * resolution, height * resolution, 0.2));
      this.frameId = message.header?.frame_id || this.frameId; this.detail = `${width}×${height} @ ${resolution} m`; this.touch();
    }));
  }

  bounds() { const pose = this.tf.lookup(this.frameId); return pose && !this.box.isEmpty() ? this.box.clone().applyMatrix4(pose) : null; }
  update() { this.place(this.outer, this.frameId); }
}
