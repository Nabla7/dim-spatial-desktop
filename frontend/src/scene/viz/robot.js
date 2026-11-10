// The robot's own shape. dimos's UrdfManager answers a request on /render_file_request with the URDF
// and then each mesh it names on /file_info, and puts every link on tf; so the model is built from the
// URDF's visuals and each link simply sits at its tf frame. Drawn as a hologram (a lit rim over a faint
// fill) or as a solid, the user's choice.
import * as THREE from 'three';
import {STLLoader} from 'three/addons/loaders/STLLoader.js';
import {OBJLoader} from 'three/addons/loaders/OBJLoader.js';
import {ColladaLoader} from 'three/addons/loaders/ColladaLoader.js';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {Layer} from '../layer.js';
import {decodeFile} from '../../data/bus.js';

const holoVertex = /* glsl */`
#include <clipping_planes_pars_vertex>
varying vec3 vNormal, vView;
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vNormal = normalize(normalMatrix * normal); vView = normalize(-mvPosition.xyz);
  gl_Position = projectionMatrix * mvPosition;
  #include <clipping_planes_vertex>
}`;

const holoFragment = /* glsl */`
#include <clipping_planes_pars_fragment>
uniform vec3 base, rim;
uniform float time, opacity;
varying vec3 vNormal, vView;
void main() {
  #include <clipping_planes_fragment>
  float facing = abs(dot(normalize(vNormal), normalize(vView)));
  float edge = pow(1.0 - facing, 2.4);
  float scan = 0.88 + 0.12 * sin(gl_FragCoord.y * 1.4 - time * 4.0);
  vec3 color = base * (0.35 + 0.4 * facing) + rim * edge * 1.5;
  gl_FragColor = vec4(color * scan, (0.42 + edge * 0.58) * opacity);
  #include <colorspace_fragment>
}`;

const numbers = (text, fallback) => { const values = String(text ?? '').trim().split(/\s+/).map(Number); return values.length && values.every(Number.isFinite) ? values : fallback; };

function originOf(element) {
  const origin = element?.querySelector(':scope > origin'), xyz = numbers(origin?.getAttribute('xyz'), [0, 0, 0]), rpy = numbers(origin?.getAttribute('rpy'), [0, 0, 0]);
  // URDF roll, pitch, yaw are about fixed axes x, y, z: the rotation is Rz(yaw) Ry(pitch) Rx(roll).
  return new THREE.Matrix4().compose(new THREE.Vector3(...xyz), new THREE.Quaternion().setFromEuler(new THREE.Euler(rpy[0], rpy[1], rpy[2], 'ZYX')), new THREE.Vector3(1, 1, 1));
}

// URDF text -> [{link, visuals: [{origin, color, mesh?, scale?, primitive?}]}]
export function parseUrdf(xml) {
  const document = new DOMParser().parseFromString(xml, 'application/xml'), robot = document.querySelector('robot');
  if (!robot) throw new Error('not a URDF');
  const named = new Map();
  for (const material of robot.querySelectorAll(':scope > material')) {
    const rgba = numbers(material.querySelector('color')?.getAttribute('rgba'), null);
    if (rgba) named.set(material.getAttribute('name'), rgba);
  }
  const links = [];
  for (const link of robot.querySelectorAll(':scope > link')) {
    const visuals = [];
    for (const visual of link.querySelectorAll(':scope > visual')) {
      const geometry = visual.querySelector(':scope > geometry'), material = visual.querySelector(':scope > material');
      if (!geometry) continue;
      const color = numbers(material?.querySelector('color')?.getAttribute('rgba'), null) || named.get(material?.getAttribute('name')) || [0.7, 0.74, 0.8, 1];
      const entry = {origin: originOf(visual), color};
      const mesh = geometry.querySelector('mesh'), box = geometry.querySelector('box'), cylinder = geometry.querySelector('cylinder'), sphere = geometry.querySelector('sphere');
      if (mesh) { entry.mesh = mesh.getAttribute('filename'); entry.scale = numbers(mesh.getAttribute('scale'), [1, 1, 1]); }
      else if (box) entry.primitive = new THREE.BoxGeometry(...numbers(box.getAttribute('size'), [0.1, 0.1, 0.1]));
      else if (cylinder) entry.primitive = new THREE.CylinderGeometry(+cylinder.getAttribute('radius'), +cylinder.getAttribute('radius'), +cylinder.getAttribute('length'), 24).rotateX(Math.PI / 2);
      else if (sphere) entry.primitive = new THREE.SphereGeometry(+sphere.getAttribute('radius'), 24, 16);
      else continue;
      visuals.push(entry);
    }
    links.push({link: link.getAttribute('name'), visuals});
  }
  return {name: robot.getAttribute('name') || 'robot', links};
}

// Mesh file bytes -> an Object3D in the URDF's own (z up) coordinates.
function parseMesh(uri, data) {
  const extension = uri.split('?')[0].split('.').pop().toLowerCase(), buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  const text = () => new TextDecoder().decode(data);
  if (extension === 'stl') return Promise.resolve(new THREE.Mesh(new STLLoader().parse(buffer)));
  if (extension === 'obj') return Promise.resolve(new OBJLoader().parse(text()));
  if (extension === 'dae') {
    // ColladaLoader turns the file to three.js's y-up. Undo that: a URDF places the file's own axes.
    const scene = new ColladaLoader().parse(text(), '').scene, holder = new THREE.Group();
    scene.rotation.set(0, 0, 0); scene.updateMatrix(); holder.add(scene);
    return Promise.resolve(holder);
  }
  if (extension === 'glb' || extension === 'gltf') {
    return new Promise((resolve, reject) => new GLTFLoader().parse(buffer, '', gltf => {
      // glTF is y-up by its spec; a URDF frame is z-up.
      const holder = new THREE.Group(); gltf.scene.rotation.x = Math.PI / 2; holder.add(gltf.scene); resolve(holder);
    }, reject));
  }
  return Promise.reject(new Error(`no loader for .${extension}`));
}

export class RobotLayer extends Layer {
  constructor(layers, {files, request}) {
    super(layers, {kind: 'robot', label: 'Robot model', topic: files, glyph: 'robot'});
    this.requestTopic = request; this.links = new Map(); this.pending = new Map(); this.queue = []; this.meshes = new Map();
    this.style = 'holo'; this.model = null; this.loaded = 0; this.total = 0; this.uniforms = {time: {value: 0}};
    this.materials = [];
  }

  material(color) {
    const theme = this.theme, base = new THREE.Color().setRGB(color[0], color[1], color[2], THREE.SRGBColorSpace);
    const holo = this.stage.clip(new THREE.ShaderMaterial({
      uniforms: {base: {value: base.clone().lerp(theme.three.primary, 0.55)}, rim: {value: theme.three.primary.clone()}, time: this.uniforms.time, opacity: {value: 0.9}},
      vertexShader: holoVertex, fragmentShader: holoFragment, clipping: true, transparent: true,
    }));
    const solid = this.stage.clip(new THREE.MeshStandardMaterial({color: base, roughness: 0.6, metalness: 0.15}));
    this.materials.push({holo, solid, color: base});
    return {holo, solid};
  }

  setStyle(style) {
    this.style = style;
    this.object.traverse(child => { if (child.isMesh && child.userData.materials) child.material = child.userData.materials[style]; });
    this.layers.emit();
  }

  start() {
    this.listen(this.bus.subscribe(this.topic.key, {delivery: 'reliable', compress: 'zstd'}, message => {
      let file;
      try { file = decodeFile(message.bytes); } catch { return; }
      this.touch(); this.receive(file);
    }));
    this.publisher = this.bus.publisher(this.requestTopic.key, {delivery: 'reliable'});
    this.subscriptions.push(this.publisher);
    if (!this.model) this.ask('*.urdf');
    this.timer = setInterval(() => this.pump(), 400);
  }

  stop() { super.stop(); clearInterval(this.timer); this.publisher = null; }

  ask(uri) {
    try { this.publisher?.put(this.bus.type('std_msgs.String').encode({data: uri})); } catch (error) { console.debug('robot model request:', error.message); }
    this.pending.set(uri, performance.now());
  }

  // Requests go out a few at a time; one that gets no answer is asked again.
  pump() {
    const now = performance.now();
    if (!this.model) { if (now - (this.pending.get('*.urdf') || 0) > 2500) this.ask('*.urdf'); return; }
    for (const [uri, at] of this.pending) if (now - at > 6000) { this.pending.delete(uri); this.queue.push(uri); }
    while (this.pending.size < 4 && this.queue.length) this.ask(this.queue.shift());
    this.detail = this.total ? (this.loaded < this.total ? `${this.loaded}/${this.total} meshes` : `${this.links.size} links`) : `${this.links.size} links`;
  }

  receive(file) {
    if (file.uri.endsWith('.urdf')) {
      if (this.model) return;
      this.pending.delete(file.uri); this.pending.delete('*.urdf');
      try { this.build(parseUrdf(new TextDecoder().decode(file.data))); } catch (error) { this.detail = error.message; console.error('urdf:', error); }
      return;
    }
    if (!this.pending.has(file.uri) && !this.queue.includes(file.uri)) return;
    this.pending.delete(file.uri); this.queue = this.queue.filter(uri => uri !== file.uri);
    parseMesh(file.uri, file.data).then(object => this.attach(file.uri, object)).catch(error => { console.warn(`mesh ${file.uri}:`, error.message); this.loaded++; });
  }

  build(model) {
    this.model = model;
    const wanted = new Set();
    for (const {link, visuals} of model.links) {
      const group = new THREE.Group(); group.name = link; group.matrixAutoUpdate = false; group.visible = false;
      for (const visual of visuals) {
        const holder = new THREE.Group(); holder.matrixAutoUpdate = false; holder.matrix.copy(visual.origin); holder.userData.visual = visual;
        if (visual.primitive) this.adopt(holder, new THREE.Mesh(visual.primitive), visual);
        else { wanted.add(visual.mesh); holder.userData.mesh = visual.mesh; }
        group.add(holder);
      }
      this.links.set(link, group); this.object.add(group);
    }
    this.queue = [...wanted]; this.total = wanted.size; this.loaded = 0;
    this.layers.emit();
  }

  // Give a parsed mesh this layer's materials and hang it on its visual.
  adopt(holder, object, visual) {
    const materials = this.material(visual.color);
    object.traverse(child => {
      if (!child.isMesh) return;
      if (!child.geometry.attributes.normal) child.geometry.computeVertexNormals();
      child.userData.materials = materials; child.material = materials[this.style]; child.renderOrder = 3;
    });
    if (visual.scale) object.scale.set(...visual.scale);
    holder.add(object);
  }

  attach(uri, object) {
    this.loaded++;
    for (const group of this.links.values()) for (const holder of group.children) {
      if (holder.userData.mesh !== uri) continue;
      this.adopt(holder, object.clone(true), holder.userData.visual);
    }
  }

  position() {
    const root = this.model?.links[0]?.link, pose = root && this.tf.knows(root) ? this.tf.lookup(root) : null;
    return pose ? new THREE.Vector3().setFromMatrixPosition(pose) : null;
  }

  bounds() {
    const box = new THREE.Box3(), point = new THREE.Vector3();
    for (const [link, group] of this.links) if (group.visible) box.expandByPoint(point.setFromMatrixPosition(group.matrix));
    return box.isEmpty() ? null : box.expandByScalar(0.35);
  }

  update(now) {
    this.uniforms.time.value = now / 1000;
    for (const [link, group] of this.links) {
      const pose = this.tf.knows(link) ? this.tf.lookup(link) : null;
      group.visible = !!pose;
      if (pose) { group.matrix.copy(pose); group.matrixWorldNeedsUpdate = true; }
    }
  }
}
