// sensor_msgs.PointCloud2 with the standard Controller voxel renderer. The gateway's point-cloud codec sends positions already
// unpacked (and thinned to what the link carries); they are drawn in the cloud's own frame, placed by tf,
// and coloured by height in the fixed frame so a floor, a wall and a ceiling read apart at a glance.
import * as THREE from 'three';
import {Layer} from '../layer.js';
import {cloudMaterial} from './cloud-material.js';

export class CloudLayer extends Layer {
  constructor(layers, topic) {
    super(layers, {kind: 'cloud', label: topic.topic, topic, glyph: 'cloud'});
    this.geometry = new THREE.BufferGeometry();
    this.capacity = 0; this.count = 0; this.frameId = ''; this.pointSize = /map|global|voxel|terrain|costmap/i.test(topic.topic) ? 0.1 : 0.04;
    this.material = cloudMaterial(this.stage, this.pointSize);
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.object.add(this.points);
    this.fixedBox = new THREE.Box3();
  }

  start() {
    this.listen(this.bus.subscribe(this.topic.key, {delivery: 'latest', encoding: 'dimos_lcm_pointcloud2', maxHz: 12, bandwidthPriority: 0.25}, message => {
      const cloud = message.decoded;
      if (!cloud?.positions) return;
      this.frameId = message.header?.frameId ?? cloud.frameId ?? this.frameId;
      this.setPoints(cloud.positions, cloud.intensity || null);
      this.touch();
    }));
  }

  setPoints(positions, intensity) {
    const count = Math.floor(positions.length / 3), geometry = this.geometry;
    if (!count) { geometry.setDrawRange(0, 0); this.count = 0; this.detail = '0 pts'; return; }
    if (count > this.capacity) {
      // Grow in steps: a scan's size wobbles, and a new buffer per message would churn the GPU.
      this.capacity = Math.max(count, Math.ceil(this.capacity * 1.5), 4096);
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.capacity * 3), 3).setUsage(THREE.DynamicDrawUsage));
      geometry.setAttribute('aIntensity', new THREE.BufferAttribute(new Float32Array(this.capacity), 1).setUsage(THREE.DynamicDrawUsage));
    }
    const target = geometry.attributes.position; target.array.set(positions.subarray(0, count * 3)); target.needsUpdate = true;
    target.clearUpdateRanges?.(); target.addUpdateRange?.(0, count * 3);
    const shade = geometry.attributes.aIntensity;
    if (intensity) { for (let i = 0; i < count; i++) shade.array[i] = intensity[i] / 255; shade.needsUpdate = true; shade.clearUpdateRanges?.(); shade.addUpdateRange?.(0, count); }
    geometry.setDrawRange(0, count); this.count = count;
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
    const low = heights[Math.floor(heights.length * 0.03)], high = heights[Math.floor(heights.length * 0.97)], range = this.material.uniforms.uRange.value;
    // Ease toward the new range so the colours do not flicker from scan to scan.
    range.x += (low - range.x) * 0.2; range.y += (Math.max(high, low + 0.5) - range.y) * 0.2;
  }

  bounds() { return this.count ? this.fixedBox : null; }

  update() {
    if (!this.place(this.points, this.frameId)) return;
    this.material.uniforms.placement.value.copy(this.points.matrix);
    this.material.uniforms.uSize.value = this.pointSize;
  }
}
