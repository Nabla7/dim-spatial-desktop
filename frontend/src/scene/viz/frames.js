// The transform tree itself: three short axes at every frame and a thin line to its parent.
import * as THREE from 'three';
import {Layer} from '../layer.js';

const AXIS = 0.07;

export class FramesLayer extends Layer {
  constructor(layers) {
    super(layers, {kind: 'frames', label: 'Transform frames', glyph: 'axes'});
    this.capacity = 0; this.drawn = -1;
    this.axes = new THREE.LineSegments(new THREE.BufferGeometry(), this.stage.clip(new THREE.LineBasicMaterial({vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false})));
    this.links = new THREE.LineSegments(new THREE.BufferGeometry(), this.stage.clip(new THREE.LineBasicMaterial({color: this.theme.three.muted, transparent: true, opacity: 0.35, depthWrite: false})));
    this.axes.frustumCulled = this.links.frustumCulled = false; this.axes.renderOrder = 5;
    this.object.add(this.links, this.axes);
    this.box = new THREE.Box3();
  }

  bounds() { return this.box.isEmpty() ? null : this.box.clone().expandByScalar(0.3); }

  update() {
    const tf = this.tf;
    if (tf.version === this.drawn) return;
    this.drawn = tf.version;
    const count = tf.frames.size, theme = this.theme;
    if (count > this.capacity) {
      this.capacity = Math.max(count, this.capacity * 2, 32);
      this.axes.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.capacity * 18), 3).setUsage(THREE.DynamicDrawUsage));
      this.axes.geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.capacity * 18), 3).setUsage(THREE.DynamicDrawUsage));
      this.links.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.capacity * 6), 3).setUsage(THREE.DynamicDrawUsage));
    }
    const positions = this.axes.geometry.attributes.position, colors = this.axes.geometry.attributes.color, lines = this.links.geometry.attributes.position;
    const origin = new THREE.Vector3(), tip = new THREE.Vector3(), parent = new THREE.Vector3(), palette = [theme.three.axisX, theme.three.axisY, theme.three.axisZ];
    let a = 0, l = 0;
    this.box.makeEmpty();
    for (const [name, frame] of tf.frames) {
      const pose = tf.lookup(name);
      if (!pose) continue;
      origin.setFromMatrixPosition(pose); this.box.expandByPoint(origin);
      for (let axis = 0; axis < 3; axis++) {
        tip.set(axis === 0 ? AXIS : 0, axis === 1 ? AXIS : 0, axis === 2 ? AXIS : 0).applyMatrix4(pose);
        positions.setXYZ(a, origin.x, origin.y, origin.z); colors.setXYZ(a++, palette[axis].r, palette[axis].g, palette[axis].b);
        positions.setXYZ(a, tip.x, tip.y, tip.z); colors.setXYZ(a++, palette[axis].r, palette[axis].g, palette[axis].b);
      }
      const above = tf.lookup(frame.parent);
      if (above) { parent.setFromMatrixPosition(above); lines.setXYZ(l++, origin.x, origin.y, origin.z); lines.setXYZ(l++, parent.x, parent.y, parent.z); }
    }
    positions.needsUpdate = colors.needsUpdate = lines.needsUpdate = true;
    this.axes.geometry.setDrawRange(0, a); this.links.geometry.setDrawRange(0, l);
    this.detail = `${count} frames · root ${tf.root || '—'}`; this.touch();
  }
}
