// Tracked hands, drawn as their joints and bones in light. (A controller shows only its ray.)
import * as THREE from 'three';

const FINGERS = [
  ['wrist', 'thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip'],
  ['wrist', 'index-finger-metacarpal', 'index-finger-phalanx-proximal', 'index-finger-phalanx-intermediate', 'index-finger-phalanx-distal', 'index-finger-tip'],
  ['wrist', 'middle-finger-metacarpal', 'middle-finger-phalanx-proximal', 'middle-finger-phalanx-intermediate', 'middle-finger-phalanx-distal', 'middle-finger-tip'],
  ['wrist', 'ring-finger-metacarpal', 'ring-finger-phalanx-proximal', 'ring-finger-phalanx-intermediate', 'ring-finger-phalanx-distal', 'ring-finger-tip'],
  ['wrist', 'pinky-finger-metacarpal', 'pinky-finger-phalanx-proximal', 'pinky-finger-phalanx-intermediate', 'pinky-finger-phalanx-distal', 'pinky-finger-tip'],
];
const BONES = FINGERS.flatMap(chain => chain.slice(1).map((joint, i) => [chain[i], joint]));

// A soft round sprite, so a joint is a dot of light and not a square.
function dot() {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d'), gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, 'rgba(255,255,255,1)'); gradient.addColorStop(0.45, 'rgba(255,255,255,0.9)'); gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(canvas);
}

export class Hands {
  constructor(scene, theme) {
    this.theme = theme; this.hands = {};
    for (const side of ['left', 'right']) {
      const joints = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({color: theme.three.primary, size: 0.009, map: dot(), transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending}));
      joints.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(25 * 3), 3));
      const bones = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({color: theme.three.primary, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending}));
      bones.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(BONES.length * 6), 3));
      joints.frustumCulled = bones.frustumCulled = false; joints.visible = bones.visible = false; joints.renderOrder = bones.renderOrder = 55;
      scene.add(joints, bones); this.hands[side] = {joints, bones};
    }
    theme.addEventListener('change', () => { for (const hand of Object.values(this.hands)) { hand.joints.material.color.copy(theme.three.primary); hand.bones.material.color.copy(theme.three.primary); } });
  }

  hide() { for (const hand of Object.values(this.hands)) hand.joints.visible = hand.bones.visible = false; }

  update(frame, reference) {
    const seen = new Set();
    for (const source of frame.session.inputSources) {
      const hand = this.hands[source.handedness];
      if (!source.hand || !hand || !frame.getJointPose) continue;
      const at = {}, joints = hand.joints.geometry.attributes.position;
      let index = 0;
      for (const [name, space] of source.hand) {
        const pose = frame.getJointPose(space, reference);
        if (!pose) continue;
        at[name] = pose.transform.position;
        if (index < 25) joints.setXYZ(index++, at[name].x, at[name].y, at[name].z);
      }
      if (index < 5) continue;
      joints.needsUpdate = true; hand.joints.geometry.setDrawRange(0, index);
      const bones = hand.bones.geometry.attributes.position;
      let vertex = 0;
      for (const [from, to] of BONES) {
        const a = at[from], b = at[to];
        if (!a || !b) continue;
        bones.setXYZ(vertex++, a.x, a.y, a.z); bones.setXYZ(vertex++, b.x, b.y, b.z);
      }
      bones.needsUpdate = true; hand.bones.geometry.setDrawRange(0, vertex);
      hand.joints.visible = hand.bones.visible = true; seen.add(source.handedness);
    }
    for (const [side, hand] of Object.entries(this.hands)) if (!seen.has(side)) hand.joints.visible = hand.bones.visible = false;
  }
}
