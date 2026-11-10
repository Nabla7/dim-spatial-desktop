// The transform tree, from every tf2_msgs.TFMessage on the bus. Layers ask where a frame is in the
// fixed frame (the root that most frames hang from) and are placed there.
import * as THREE from 'three';

const clean = name => String(name || '').replace(/^\/+/, '');
const _scale = new THREE.Vector3(1, 1, 1);

export class TfTree {
  constructor() {
    this.frames = new Map();   // child -> {parent, matrix, at}
    this.parents = new Set();  // every frame something hangs from
    this.version = 0; this.cache = new Map(); this.cacheVersion = -1; this.fixed = ''; this.fixedVersion = -1;
    this.structure = 0; this.depth = 0;  // structure counts changes to who hangs from whom
  }

  clear() { this.frames.clear(); this.parents.clear(); this.version++; this.structure++; }

  // One decoded TFMessage.
  add(message, now) {
    for (const stamped of message.transforms || []) {
      const child = clean(stamped.child_frame_id), parent = clean(stamped.header?.frame_id);
      if (!child || child === parent) continue;
      const t = stamped.transform?.translation, r = stamped.transform?.rotation;
      if (!t || !r) continue;
      let frame = this.frames.get(child);
      if (!frame) { frame = {parent, matrix: new THREE.Matrix4(), position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), at: now}; this.frames.set(child, frame); this.structure++; }
      if (frame.parent !== parent) { frame.parent = parent; this.structure++; }
      this.parents.add(parent);
      frame.position.set(t.x, t.y, t.z); frame.quaternion.set(r.x, r.y, r.z, r.w).normalize();
      frame.matrix.compose(frame.position, frame.quaternion, _scale); frame.at = now;
    }
    this.version++;
  }

  get size() { return this.frames.size; }

  // The root with the most frames under it: "world", "map", "odom", whatever this robot calls it.
  get root() {
    if (this.fixedVersion === this.structure) return this.fixed;
    const counts = new Map();
    for (const child of this.frames.keys()) { const root = this.rootOf(child); counts.set(root, (counts.get(root) || 0) + 1); }
    this.fixed = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] || ''; this.fixedVersion = this.structure;
    return this.fixed;
  }

  rootOf(name) {
    let frame = clean(name), guard = 0;
    while (this.frames.has(frame) && guard++ < 256) frame = this.frames.get(frame).parent;
    return frame;
  }

  // The frame's pose in the fixed frame, or null while the tree does not reach it. A frame the tree has
  // never heard of is taken to be the fixed frame itself (a cloud stamped "world" with no tf at all).
  lookup(name) {
    const frame = clean(name);
    if (this.cacheVersion !== this.version) { this.cache.clear(); this.cacheVersion = this.version; }
    if (this.cache.has(frame)) return this.cache.get(frame);
    let result;
    const entry = this.frames.get(frame);
    if (!entry) result = IDENTITY;
    else {
      // A cycle in the tree (two publishers disagreeing) ends here instead of recursing forever.
      let parent = null;
      if (this.depth < 256) { this.depth++; parent = this.lookup(entry.parent); this.depth--; }
      result = parent ? new THREE.Matrix4().multiplyMatrices(parent, entry.matrix) : null;
    }
    this.cache.set(frame, result);
    return result;
  }

  has(name) { return this.frames.has(clean(name)); }
  // In the tree at all: as a child, or as a root that other frames hang from.
  knows(name) { const frame = clean(name); return this.frames.has(frame) || this.parents.has(frame); }
}

const IDENTITY = new THREE.Matrix4();
