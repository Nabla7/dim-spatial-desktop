// Review-only markers in the robot's body frame. Never publishes a command.
import * as THREE from 'three';

export class ArmCalibrationPreview {
  constructor(app) {
    this.app = app; this.root = new THREE.Group(); this.root.matrixAutoUpdate = false;
    this.root.name = 'arm-calibration-preview'; app.stage.world.add(this.root);
    this.markers = {}; this.materials = [];
    for (const side of ['left', 'right']) {
      this.markers[side] = {};
      for (const name of ['neutral', 'reach', 'preview', 'actual']) {
        const material = app.stage.clip(new THREE.MeshBasicMaterial({color: app.theme.three[side === 'left' ? 'primary' : 'alt'],
          transparent: true, opacity: ['preview', 'actual'].includes(name) ? 0.9 : 0.6, wireframe: !['preview', 'actual'].includes(name), depthWrite: false}));
        this.materials.push([name === 'actual' ? 'actual' : side, material]);
        const marker = new THREE.Mesh(new THREE.SphereGeometry(name === 'actual' ? 0.01 : name === 'preview' ? 0.018 : name === 'neutral' ? 0.025 : 0.035, 12, 8), material);
        this.root.add(marker); this.markers[side][name] = marker;
      }
    }
  }
  update(status) {
    const tf = this.app.layers.tf;
    const pose = status && tf.knows(status.body_frame) && tf.lookup(status.body_frame);
    this.root.visible = !!pose;
    if (!pose) return;
    this.root.matrix.copy(pose); this.root.matrixWorldNeedsUpdate = true;
    for (const [side, material] of this.materials) material.color.copy(this.app.theme.three[side === 'actual' ? 'fg' : side === 'left' ? 'primary' : 'alt']);
    for (const side of ['left', 'right']) for (const [name, marker] of Object.entries(this.markers[side])) {
      const point = name === 'actual' ? status.actual?.[side] : name === 'preview' ? status.preview?.[side] : status.targets?.[side]?.[name];
      marker.visible = !!point;
      if (point) marker.position.fromArray(point.position);
    }
  }
  dispose() {
    this.root.removeFromParent();
    this.root.traverse(child => child.geometry?.dispose());
    for (const [, material] of this.materials) { this.app.stage.materials.delete(material); material.dispose(); }
  }
}
