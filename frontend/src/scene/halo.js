// The running blueprint, drawn around the table: one plate per module instance on a ring, and an arc
// for every pair of modules that a topic joins, with pulses that run from the writer to the reader at
// a pace set by the topic's measured rate. Point at a plate and press to open that module.
import * as THREE from 'three';
import {openModule} from '../panels/module.js';
import {hz, words} from '../util.js';

const PLATE = [0.168, 0.056], PIXELS = [420, 140], SEGMENTS = 28, scratch = new THREE.Vector3();

const arcVertex = /* glsl */`
attribute float along, rate, lit, seed;
varying float vAlong, vRate, vLit, vSeed;
void main() { vAlong = along; vRate = rate; vLit = lit; vSeed = seed; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

const arcFragment = /* glsl */`
uniform vec3 color, hot;
uniform float time, dim;
varying float vAlong, vRate, vLit, vSeed;
void main() {
  // Pulses travel from writer (0) to reader (1); a silent topic shows only its faint path.
  float speed = 0.12 + 0.5 * vRate, count = 2.0 + floor(vRate * 4.0);
  float phase = fract(vAlong * count - time * speed * count * 0.5 + vSeed);
  float pulse = vRate > 0.0 ? smoothstep(0.75, 1.0, phase) : 0.0;
  float ends = smoothstep(0.0, 0.08, vAlong) * smoothstep(1.0, 0.92, vAlong);
  float strength = (0.10 + 0.9 * pulse) * mix(dim, 1.0, vLit) * ends;
  gl_FragColor = vec4(mix(color, hot, vLit * 0.6 + pulse * 0.4), strength);
  #include <colorspace_fragment>
}`;

export class Halo {
  constructor(app) {
    this.app = app; this.theme = app.theme; this.stage = app.stage;
    this.group = new THREE.Group(); this.group.name = 'halo'; this.stage.root.add(this.group);
    this.nodes = new Map(); this.hovered = null; this.built = 0; this.enabled = true;
    this.arcUniforms = {color: {value: this.theme.three.primary.clone()}, hot: {value: this.theme.three.fg.clone()}, time: {value: 0}, dim: {value: 1}};
    this.arcs = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.ShaderMaterial({
      uniforms: this.arcUniforms, vertexShader: arcVertex, fragmentShader: arcFragment, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.arcs.frustumCulled = false; this.arcs.renderOrder = 8; this.group.add(this.arcs);
    this.ring = new THREE.LineLoop(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({color: this.theme.three.primary, transparent: true, opacity: 0.22, depthWrite: false}));
    this.group.add(this.ring);
    this.pairs = [];
    app.blueprint.addEventListener('modules', () => this.rebuild());
    app.blueprint.addEventListener('rates', () => this.refreshRates());
    app.addEventListener('select', () => this.highlight());
    app.dock.addEventListener('change', () => this.highlight());
    this.theme.addEventListener('change', () => {
      this.arcUniforms.color.value.copy(this.theme.three.primary); this.arcUniforms.hot.value.copy(this.theme.three.fg);
      this.ring.material.color.copy(this.theme.three.primary);
      for (const node of this.nodes.values()) this.paint(node);
    });
  }

  rebuild() {
    const {blueprint, pointers} = this.app, modules = blueprint.modules;
    for (const node of this.nodes.values()) { pointers.unpick(node.mesh); node.mesh.removeFromParent(); node.texture.dispose(); node.mesh.geometry.dispose(); node.mesh.material.dispose(); }
    this.nodes.clear(); this.built = performance.now();
    const count = modules.length;
    this.group.visible = count > 0;
    if (!count) { this.arcs.geometry.setDrawRange(0, 0); return; }
    // Wide enough that neighbouring plates do not overlap; never tighter than just outside the table.
    const radius = this.radius = Math.max(this.stage.radius * 1.36, count * PLATE[0] * 1.04 / (2 * Math.PI));
    this.ring.geometry.setFromPoints(Array.from({length: 96}, (_, i) => new THREE.Vector3(Math.sin(i / 96 * Math.PI * 2) * radius, 0.205, Math.cos(i / 96 * Math.PI * 2) * radius)));
    modules.forEach((module, index) => {
      const angle = index / count * Math.PI * 2 + Math.PI / count, canvas = document.createElement('canvas');
      [canvas.width, canvas.height] = PIXELS;
      const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 4;
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(...PLATE), new THREE.MeshBasicMaterial({map: texture, transparent: true, depthWrite: false}));
      // Alternate two heights so long names on neighbours do not collide.
      mesh.position.set(Math.sin(angle) * radius, 0.235 + (index % 2) * 0.066, Math.cos(angle) * radius);
      mesh.renderOrder = 12;
      const node = {id: module.id, module, mesh, canvas, texture, index, grow: 0, hover: 0, flash: 0, rate: 0};
      this.nodes.set(module.id, node); this.group.add(mesh);
      pointers.pick(mesh, {
        onClick: () => openModule(this.app, module.id),
        onHover: on => { this.hovered = on ? module.id : this.hovered === module.id ? null : this.hovered; this.highlight(); },
      });
      this.paint(node);
    });
    this.buildArcs(); this.refreshRates();
  }

  // One arc per ordered pair of modules, however many topics join them.
  buildArcs() {
    const pairs = new Map();
    for (const link of this.app.blueprint.links()) {
      const key = `${link.from}>${link.to}`;
      if (!pairs.has(key)) pairs.set(key, {from: link.from, to: link.to, topics: []});
      pairs.get(key).topics.push(link.topic);
    }
    this.pairs = [...pairs.values()].filter(pair => this.nodes.has(pair.from) && this.nodes.has(pair.to));
    const vertices = this.pairs.length * SEGMENTS * 2, position = new Float32Array(vertices * 3), along = new Float32Array(vertices);
    const seed = new Float32Array(vertices), a = new THREE.Vector3(), b = new THREE.Vector3(), control = new THREE.Vector3(), p = new THREE.Vector3(), q = new THREE.Vector3();
    const curve = (t, out) => out.copy(a).multiplyScalar((1 - t) * (1 - t)).addScaledVector(control, 2 * t * (1 - t)).addScaledVector(b, t * t);
    this.pairs.forEach((pair, index) => {
      a.copy(this.nodes.get(pair.from).mesh.position); b.copy(this.nodes.get(pair.to).mesh.position);
      // Bow inward and up, more for modules far apart on the ring: arcs fan out over the table instead of piling at its centre.
      const chord = a.distanceTo(b) / (2 * this.radius);
      control.copy(a).add(b).multiplyScalar(0.5); control.x *= 1 - 0.55 * chord; control.z *= 1 - 0.55 * chord; control.y += 0.07 + 0.22 * chord;
      const random = Math.random();
      for (let i = 0; i < SEGMENTS; i++) {
        const offset = (index * SEGMENTS + i) * 2;
        curve(i / SEGMENTS, p); curve((i + 1) / SEGMENTS, q);
        position.set([p.x, p.y, p.z, q.x, q.y, q.z], offset * 3);
        along[offset] = i / SEGMENTS; along[offset + 1] = (i + 1) / SEGMENTS; seed[offset] = seed[offset + 1] = random;
      }
    });
    const geometry = this.arcs.geometry;
    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geometry.setAttribute('along', new THREE.BufferAttribute(along, 1));
    geometry.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
    geometry.setAttribute('rate', new THREE.BufferAttribute(new Float32Array(vertices), 1));
    geometry.setAttribute('lit', new THREE.BufferAttribute(new Float32Array(vertices), 1));
    geometry.setDrawRange(0, vertices);
    this.highlight();
  }

  refreshRates() {
    const rate = this.arcs.geometry.attributes.rate;
    if (!rate) return;
    this.pairs.forEach((pair, index) => {
      const total = pair.topics.reduce((sum, topic) => sum + (topic.hz || 0), 0);
      // Log scale: 1 Hz and 1 kHz should both read as "alive", not as nothing and a blur.
      const value = total > 0 ? Math.min(1, 0.15 + Math.log10(1 + total) / 3.2) : 0;
      rate.array.fill(value, index * SEGMENTS * 2, (index + 1) * SEGMENTS * 2);
    });
    rate.needsUpdate = true;
    for (const node of this.nodes.values()) {
      let out = 0;
      for (const stream of node.module.streams) if (stream.direction !== 'in') out += this.app.blueprint.topics.get(stream.key)?.hz || 0;
      if (Math.abs(out - node.rate) > Math.max(0.5, node.rate * 0.1)) { node.rate = out; this.paint(node); }
    }
  }

  // Light the selected (or hovered) module's arcs and plates; dim the rest.
  highlight() {
    const focus = this.hovered || this.app.selected, lit = this.arcs.geometry.attributes.lit;
    this.focus = focus && this.nodes.has(focus) ? focus : null;
    if (lit) {
      this.pairs.forEach((pair, index) => lit.array.fill(this.focus && (pair.from === this.focus || pair.to === this.focus) ? 1 : 0, index * SEGMENTS * 2, (index + 1) * SEGMENTS * 2));
      lit.needsUpdate = true;
    }
    this.arcUniforms.dim.value = this.focus ? 0.22 : 1;
    const near = new Set([this.focus]);
    if (this.focus) for (const pair of this.pairs) { if (pair.from === this.focus) near.add(pair.to); if (pair.to === this.focus) near.add(pair.from); }
    for (const node of this.nodes.values()) {
      const state = !this.focus ? 'idle' : node.id === this.focus ? 'focus' : near.has(node.id) ? 'near' : 'far';
      const open = this.app.dock.has(`module:${node.id}`);
      if (state !== node.state || open !== node.open) { node.state = state; node.open = open; this.paint(node); }
    }
  }

  paint(node) {
    const theme = this.theme, [w, h] = PIXELS, ctx = node.canvas.getContext('2d'), {module, state = 'idle'} = node;
    const strong = state === 'focus' || node.open, tone = strong ? 'fg' : 'primary', fade = state === 'far' ? 0.35 : 1;
    ctx.clearRect(0, 0, w, h);
    ctx.globalAlpha = fade;
    ctx.beginPath(); ctx.moveTo(26, 4); ctx.lineTo(w - 4, 4); ctx.lineTo(w - 4, h - 26); ctx.lineTo(w - 26, h - 4); ctx.lineTo(4, h - 4); ctx.lineTo(4, 26); ctx.closePath();
    ctx.fillStyle = theme.c('surface', 0.82); ctx.fill();
    ctx.fillStyle = theme.c('primary', strong ? 0.22 : 0.07); ctx.fill();
    ctx.strokeStyle = theme.c(strong ? 'fg' : 'primary', strong ? 1 : 0.7); ctx.lineWidth = strong ? 5 : 3; ctx.stroke();
    // The hexagon that stands for a module everywhere in this app.
    ctx.beginPath();
    for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + i * Math.PI / 3; ctx[i ? 'lineTo' : 'moveTo'](62 + 30 * Math.cos(a), h / 2 + 30 * Math.sin(a)); }
    ctx.closePath(); ctx.strokeStyle = theme.c(tone); ctx.lineWidth = 4; ctx.stroke();
    const skills = module.rpcs.some(rpc => rpc.skill);
    ctx.fillStyle = theme.c(skills ? 'alt' : 'ok'); ctx.beginPath(); ctx.arc(62, h / 2, 9, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = theme.c('fg'); ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    ctx.font = `600 34px ${theme.font.sans}`;
    let name = words(module.name);
    while (ctx.measureText(name).width > w - 124 && name.length > 4) name = name.slice(0, -2).trimEnd() + '…';
    ctx.fillText(name, 108, h / 2 - 20);
    ctx.font = `400 24px ${theme.font.mono}`; ctx.fillStyle = theme.c('muted');
    let detail = `${module.alias ? module.alias : `${module.rpcs.length} rpc`} · ${node.rate ? hz(node.rate) : `${module.streams.length} streams`}`;
    while (ctx.measureText(detail).width > w - 124 && detail.length > 4) detail = detail.slice(0, -2) + '…';
    ctx.fillText(detail, 108, h / 2 + 24);
    ctx.globalAlpha = 1;
    node.texture.needsUpdate = true;
  }

  pulse(id) { const node = this.nodes.get(id); if (node) node.flash = 1; }

  update(dt, now) {
    if (!this.nodes.size) { this.group.visible = false; return; }
    this.arcUniforms.time.value = now / 1000;
    // Life size puts the viewer inside the world; the ring would be a fence around them.
    this.group.visible = this.enabled && !this.stage.lifeSize;
    const camera = this.app.camera, facing = new THREE.Quaternion(), parent = new THREE.Quaternion();
    camera.getWorldQuaternion(facing); this.group.getWorldQuaternion(parent); facing.premultiply(parent.invert());
    const age = now - this.built, eye = camera.getWorldPosition(new THREE.Vector3());
    let nearest = Infinity;
    for (const node of this.nodes.values()) nearest = Math.min(nearest, node.mesh.getWorldPosition(scratch).distanceTo(eye));
    for (const node of this.nodes.values()) {
      // Plates arrive one after another when a blueprint comes up.
      const target = age > node.index * 55 ? 1 : 0;
      node.grow += (target - node.grow) * Math.min(1, dt * 10);
      node.hover += ((this.hovered === node.id ? 1 : 0) - node.hover) * Math.min(1, dt * 14);
      node.flash = Math.max(0, node.flash - dt * 1.8);
      node.mesh.quaternion.copy(facing);
      // Plates across the ring from the viewer are drawn larger, so every name stays readable.
      const distance = node.mesh.getWorldPosition(scratch).distanceTo(eye), far = THREE.MathUtils.clamp(distance / nearest, 1, 1.9);
      node.mesh.scale.setScalar(Math.max(0.001, node.grow) * far * (1 + node.hover * 0.16 + node.flash * 0.25));
      node.mesh.material.opacity = Math.min(1, node.grow * 1.2);
    }
  }
}
