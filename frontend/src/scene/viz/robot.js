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
import {gateway} from '../../data/gateway.js';

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

// "1 2 3" -> [1, 2, 3]; a missing or malformed attribute gives the fallback.
function numbers(text, fallback) {
  const source = String(text ?? '').trim();
  if (!source) return fallback;
  const values = source.split(/\s+/).map(Number);
  return values.every(Number.isFinite) ? values : fallback;
}

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

// Mesh files, kept in the browser between visits: a robot's meshes are megabytes and a room's far more,
// and they change only when their path does (dimos keeps assets under content-hashed folders).
const meshCache = {
  open() {
    return this.db ||= new Promise(resolve => {
      const request = indexedDB.open('spatial-desktop-meshes', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('files');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    });
  },
  async get(uri) {
    const db = await this.open();
    if (!db) return null;
    return new Promise(resolve => {
      const request = db.transaction('files').objectStore('files').get(uri);
      request.onsuccess = () => resolve(request.result ? new Uint8Array(request.result) : null);
      request.onerror = () => resolve(null);
    });
  },
  async put(uri, bytes) {
    const db = await this.open();
    if (!db) return;
    try { db.transaction('files', 'readwrite').objectStore('files').put(bytes.slice().buffer, uri); } catch { /* over quota: the mesh is fetched again next time */ }
  },
  async clear() { const db = await this.open(); db?.transaction('files', 'readwrite').objectStore('files').clear(); },
};

const TRIANGLE_BUDGET = /OculusBrowser|Quest|Pico|Android/i.test(navigator.userAgent) ? 600_000 : 8_000_000;

export class RobotLayer extends Layer {
  constructor(layers, {files, request}) {
    super(layers, {kind: 'robot', label: 'Robot model', topic: files, glyph: 'robot'});
    this.requestTopic = request; this.links = new Map(); this.pending = new Map(); this.queue = [];
    this.style = 'holo'; this.model = null; this.models = new Map(); this.asked = new Set(); this.loaded = 0; this.total = 0;
    this.uniforms = {time: {value: 0}}; this.materials = []; this.triangles = 0; this.wanted = new Set(); this.tries = new Map(); this.sizes = new Set();
  }

  // scenery: a model that is the surroundings rather than the robot is drawn fainter, and never hides the robot.
  material(color, scenery = false) {
    const theme = this.theme, base = new THREE.Color().setRGB(color[0], color[1], color[2], THREE.SRGBColorSpace);
    const holo = this.stage.clip(new THREE.ShaderMaterial({
      uniforms: {base: {value: base.clone().lerp(theme.three.primary, 0.55)}, rim: {value: theme.three.primary.clone()}, time: this.uniforms.time, opacity: {value: scenery ? 0.3 : 0.9}},
      vertexShader: holoVertex, fragmentShader: holoFragment, clipping: true, transparent: true, depthWrite: !scenery,
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
    this.publisher = this.bus.publisher(this.requestTopic.key, {delivery: 'reliable'});
    this.subscriptions.push(this.publisher);
    this.timer = setInterval(() => this.pump(), 400);
    this.findModels();
  }

  stop() { super.stop(); clearInterval(this.timer); this.publisher = null; this.files = null; }

  // Every answer on /file_info goes to everyone listening, whoever asked. So this layer listens only
  // while it is owed something: another page loading ten thousand collision meshes then costs this one nothing.
  listenForFiles(on) {
    if (on === !!this.files) return;
    if (!on) { this.files.close?.(); this.subscriptions = this.subscriptions.filter(subscription => subscription !== this.files); this.files = null; return; }
    // Files are background traffic: they must not squeeze the cameras and clouds while they load.
    this.files = this.listen(this.bus.subscribe(this.topic.key, {delivery: 'reliable', compress: 'zstd', priority: 7, bandwidthPriority: 0.2}, message => {
      let file;
      try { file = decodeFile(message.bytes); } catch { return; }
      this.receive(file);
    }));
  }

  ask(uri) {
    try { this.publisher?.put(this.bus.type('std_msgs.String').encode({data: uri})); } catch (error) { console.debug('robot model request:', error.message); }
    this.pending.set(uri, performance.now()); this.lastAsk = performance.now();
  }

  // Requests go out a few at a time. An answer can be lost on the way (the bus drops under load), so a
  // request that has waited while nothing of this layer's arrived is asked again.
  pump() {
    const now = performance.now(), quiet = now - (this.lastFile || 0) > 1500;
    const owed = !this.model || this.pending.size > 0 || this.queue.length > 0 || this.wanted.size > 0 || !this.names;
    if (owed) this.idleSince = now;
    this.listenForFiles(owed || now - (this.idleSince || 0) < 3000);
    if (!this.files) { this.touch(); return; }
    if (!this.model) { if (now - (this.lastAsk || 0) > 2500) this.ask('*.urdf'); return; }
    for (const name of this.names || []) if (!this.asked.has(name)) { this.asked.add(name); this.wanted.add(`${name}.urdf`); }
    for (const uri of this.wanted) {
      if (now - (this.pending.get(uri) || 0) < 4000 || !quiet) continue;
      // A name the manager does not answer to is given up on after a few tries.
      const tries = this.tries.get(uri) || 0;
      if (tries >= 4) { this.wanted.delete(uri); this.pending.delete(uri); continue; }
      this.tries.set(uri, tries + 1); this.ask(uri);
    }
    for (const [uri, at] of this.pending) if (!this.wanted.has(uri) && now - at > 4000 && quiet) this.ask(uri);
    let busy = [...this.pending.keys()].filter(uri => !this.wanted.has(uri)).length;
    while (busy++ < 3 && this.queue.length) this.ask(this.queue.shift());
    const skipped = this.skipped ? ` · ${this.skipped} too heavy` : '';
    this.detail = (this.loaded < this.total ? `${this.loaded}/${this.total} meshes` : `${this.links.size} links`) + skipped;
    this.touch();
  }

  receive(file) {
    if (file.uri.endsWith('.urdf')) {
      this.pending.delete(file.uri); this.wanted.delete(file.uri);
      // Other pages ask for URDFs too and every answer is broadcast: one already held is recognised by its size.
      if (this.sizes.has(file.data.byteLength)) return;
      this.lastFile = performance.now();
      this.sizes.add(file.data.byteLength);
      const xml = new TextDecoder().decode(file.data);
      if ([...this.models.values()].includes(xml)) return;
      this.models.set(file.uri, xml);
      try { this.build(parseUrdf(xml)); } catch (error) { this.detail = error.message; console.error('urdf:', error); }
      return;
    }
    if (!this.pending.has(file.uri) && !this.queue.includes(file.uri)) return;
    this.lastFile = performance.now();
    this.pending.delete(file.uri); this.queue = this.queue.filter(uri => uri !== file.uri);
    meshCache.put(file.uri, file.data);
    this.accept(file.uri, file.data);
  }

  // "*.urdf" is answered with one model. A UrdfManager given several (a robot and the room it stands in)
  // is asked for each by name, and the names are in the blueprint's config as the gateway reads it.
  async findModels() {
    const blueprint = this.layers.app.blueprint, owner = this.topic.writers[0];
    if (this.names || !owner) return;
    this.names = [];
    try {
      const config = await gateway.blueprintConfig(blueprint.name), modules = config.modules || {};
      const entry = modules[owner] || Object.entries(modules).find(([id]) => id.toLowerCase() === owner)?.[1];
      const models = entry?.args?.models?.value;
      if (models && typeof models === 'object') this.names = Object.keys(models);
    } catch (error) { console.debug('robot model names:', error.message); }
  }

  accept(uri, data) {
    parseMesh(uri, data).then(object => {
      // A standalone headset draws every triangle twice at 72 Hz or more: past its budget a mesh is left out.
      let triangles = 0;
      object.traverse(child => { if (child.isMesh) triangles += (child.geometry.index?.count ?? child.geometry.attributes.position.count) / 3; });
      if (this.triangles + triangles > TRIANGLE_BUDGET) { this.skipped = (this.skipped || 0) + 1; this.loaded++; return; }
      this.triangles += triangles; this.attach(uri, object);
    }).catch(error => { console.warn(`mesh ${uri}:`, error.message); this.loaded++; });
  }

  build(model) {
    this.model ||= model;
    const wanted = new Set(), scenery = model !== this.model && model.links.length === 1;
    for (const {link, visuals} of model.links) {
      if (this.links.has(link)) continue;
      if (scenery) for (const visual of visuals) visual.scenery = true;
      const group = new THREE.Group(); group.name = link; group.matrixAutoUpdate = false; group.visible = false;
      for (const visual of visuals) {
        const holder = new THREE.Group(); holder.matrixAutoUpdate = false; holder.matrix.copy(visual.origin); holder.userData.visual = visual;
        if (visual.primitive) this.adopt(holder, new THREE.Mesh(visual.primitive), visual);
        else { wanted.add(visual.mesh); holder.userData.mesh = visual.mesh; }
        group.add(holder);
      }
      this.links.set(link, group); this.object.add(group);
    }
    this.total += wanted.size;
    // What the browser already holds is used at once; only the rest is asked for.
    for (const uri of wanted) meshCache.get(uri).then(bytes => {
      if (bytes) this.accept(uri, bytes); else if (!this.queue.includes(uri)) this.queue.push(uri);
    });
    this.layers.emit();
  }

  // Give a parsed mesh this layer's materials and hang it on its visual.
  adopt(holder, object, visual) {
    const materials = this.material(visual.color, visual.scenery);
    object.traverse(child => {
      if (!child.isMesh) return;
      if (!child.geometry.attributes.normal) child.geometry.computeVertexNormals();
      child.userData.materials = materials; child.material = materials[this.style]; child.renderOrder = visual.scenery ? 2 : 3;
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

  // Where the robot stands: its root link's place on the ground plane, at the height of its lowest link
  // (a wheel, a foot), since a root link is often a chassis or a pelvis well above the floor.
  position() {
    const root = this.model?.links[0]?.link, pose = root && this.tf.knows(root) ? this.tf.lookup(root) : null;
    if (!pose) return null;
    const at = new THREE.Vector3().setFromMatrixPosition(pose), point = new THREE.Vector3();
    for (const {link} of this.model.links) { const link_pose = this.tf.knows(link) ? this.tf.lookup(link) : null; if (link_pose) at.z = Math.min(at.z, point.setFromMatrixPosition(link_pose).z); }
    return at;
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
