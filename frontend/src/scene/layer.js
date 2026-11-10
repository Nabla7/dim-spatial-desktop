// What every layer shares: a place in the scene, a visibility that controls its subscriptions, a status.
import * as THREE from 'three';

export class Layer {
  constructor(layers, {kind, label, topic = null, glyph = 'stream'}) {
    this.layers = layers; this.bus = layers.bus; this.tf = layers.tf; this.stage = layers.stage; this.theme = layers.theme;
    this.kind = kind; this.label = label; this.topic = topic; this.glyph = glyph;
    this.object = new THREE.Group(); this.object.name = `${kind}:${label}`; this.object.visible = false;
    this.visible = false; this.subscriptions = []; this.lastAt = 0; this.detail = '';
  }

  get live() { return this.visible && performance.now() - this.lastAt < 2500; }

  setVisible(on) {
    if (on === this.visible) return;
    this.visible = on; this.object.visible = on;
    if (on) this.start(); else this.stop();
  }

  listen(subscription) { this.subscriptions.push(subscription); return subscription; }
  start() {}
  stop() { for (const subscription of this.subscriptions) subscription.close?.(); this.subscriptions = []; }
  update() {}
  touch() { this.lastAt = performance.now(); }

  // Place a child at a tf frame; hides it while the tree does not reach that frame.
  place(object, frame) {
    const pose = this.tf.lookup(frame);
    if (!pose) { object.visible = false; return false; }
    object.visible = true; object.matrixAutoUpdate = false; object.matrix.copy(pose); object.matrixWorldNeedsUpdate = true;
    return true;
  }

  dispose() {
    this.setVisible(false); this.object.removeFromParent();
    this.object.traverse(child => { child.geometry?.dispose?.(); if (child.material) for (const material of [].concat(child.material)) { this.stage.materials.delete(material); material.map?.dispose?.(); material.dispose?.(); } });
  }
}
