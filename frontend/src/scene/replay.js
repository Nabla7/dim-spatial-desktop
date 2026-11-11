// The world of a replayed episode, on the table. The server sends the shapes of the episode's compiled
// physics model (boxes, cylinders, meshes, each fixed to a body) and where every body was at every world
// snapshot; this builds the shapes once and moves the bodies to the playhead. Beside the measured world it
// can draw the pose the command asked for (a ghost of the commanded bodies), the path of each thing that
// travelled, and each camera as a frustum with its picture of that moment.
// Nothing here names a robot: bodies, shapes and cameras are whatever the model holds.
import * as THREE from 'three';
import {hologram} from './hologram.js';

const DEFAULTS = {style: 'solid', ghost: true, trails: true, cameras: true, surroundings: true};
const SCREEN_DEPTH = 0.1;   // metres in front of a camera that its picture hangs

// MuJoCo quaternions are (w, x, y, z).
const quaternion = (target, source, at = 0) => target.set(source[at + 1], source[at + 2], source[at + 3], source[at]);

export class ReplayScene extends EventTarget {
  constructor(app) {
    super();
    this.app = app; this.replay = app.replay; this.stage = app.stage; this.theme = app.theme;
    this.root = new THREE.Group(); this.root.name = 'replay'; this.root.visible = false; this.stage.world.add(this.root);
    this.options = {...DEFAULTS, ...this.saved()};
    this.uniforms = {time: {value: 0}};
    this.geometries = new Map(); this.geometryKey = null; this.materials = []; this.built = false;
    // The table shows what stands on it: a plane just under its surface hides legs and floors below.
    this.bottom = new THREE.Plane(); this.clips = [...this.stage.clipPlanes, this.bottom]; this.none = []; this.clipped = null;
    this.up = new THREE.Vector3(); this.point = new THREE.Vector3(); this.one = new THREE.Vector3(1, 1, 1);
    this.from = new THREE.Vector3(); this.to = new THREE.Vector3(); this.turnFrom = new THREE.Quaternion(); this.turnTo = new THREE.Quaternion();
    this.replay.addEventListener('open', () => this.clear());
    this.replay.addEventListener('close', () => this.clear());
    this.replay.addEventListener('world', () => this.build());
    this.theme.addEventListener('change', () => { if (this.built) this.build(false); });
  }

  saved() { try { return JSON.parse(localStorage.getItem('spatial.replay.view') || '{}'); } catch { return {}; } }

  set(name, value) {
    this.options[name] = value;
    try { localStorage.setItem('spatial.replay.view', JSON.stringify(this.options)); } catch { /* private mode */ }
    this.apply(); this.dispatchEvent(new Event('change'));
  }

  // -- building -----------------------------------------------------------------------------------------
  clear() {
    // Meshes of the model are kept for the next episode; the boxes and cylinders made for this one go.
    this.root.traverse(child => { if (child.isMesh && child.userData.looks && !child.geometry.userData.shared) child.geometry.dispose(); });
    for (const child of [...this.root.children]) child.removeFromParent();
    for (const entry of this.materials) { entry.holo.dispose(); entry.solid.dispose(); }
    for (const rig of this.rigs || []) { rig.texture.dispose(); rig.screen.material.dispose(); rig.screen.geometry.dispose(); rig.lines.geometry.dispose(); rig.lines.material.dispose(); }
    for (const trail of this.trails || []) { trail.past.geometry.dispose(); trail.all.geometry.dispose(); trail.past.material.dispose(); trail.all.material.dispose(); }
    this.materials = []; this.bodies = []; this.ghosts = []; this.rigs = []; this.trails = []; this.built = false; this.clipped = null;
    this.root.visible = false;
    // The live layers share the table: they come back when no episode is open.
    this.app.layers.root.visible = !this.replay.active;
  }

  geometry(geom, shapes) {
    const [a, b, c] = geom.size;
    switch (geom.type) {
      case 'box': return new THREE.BoxGeometry(2 * a, 2 * b, 2 * c);
      case 'sphere': return new THREE.SphereGeometry(a, 24, 16);
      case 'ellipsoid': return new THREE.SphereGeometry(1, 24, 16).scale(a, b, c);
      // three.js builds these along y; a MuJoCo cylinder or capsule runs along its z.
      case 'cylinder': return new THREE.CylinderGeometry(a, a, 2 * b, 32).rotateX(Math.PI / 2);
      case 'capsule': return new THREE.CapsuleGeometry(a, 2 * b, 8, 16).rotateX(Math.PI / 2);
      case 'plane': return new THREE.PlaneGeometry(2 * a || 20, 2 * b || 20);
      case 'mesh': {
        // Meshes are shared between shapes, between the world and its ghost, and from episode to episode.
        let geometry = this.geometries.get(geom.mesh);
        if (!geometry) {
          const {vertices, faces} = shapes.meta.meshes[geom.mesh];
          geometry = new THREE.BufferGeometry();
          geometry.setAttribute('position', new THREE.BufferAttribute(shapes.vertices.subarray(vertices[0], vertices[0] + vertices[1]), 3));
          geometry.setIndex(new THREE.BufferAttribute(shapes.faces.subarray(faces[0], faces[0] + faces[1]), 1));
          geometry.computeVertexNormals();
          geometry.userData.shared = true;
          this.geometries.set(geom.mesh, geometry);
        }
        return geometry;
      }
      default: return null;
    }
  }

  // The two looks of one colour: a hologram and a lit solid. `role` is world (the fixed surroundings),
  // body (what moves) or ghost (the commanded pose).
  material(rgba, role) {
    const key = `${role}:${rgba.map(value => value.toFixed(3)).join(',')}`;
    let entry = this.materials.find(candidate => candidate.key === key);
    if (entry) return entry;
    const theme = this.theme, base = new THREE.Color().setRGB(rgba[0], rgba[1], rgba[2], THREE.SRGBColorSpace);
    if (role === 'ghost') {
      const ghost = hologram({base: theme.three.alt.clone(), rim: theme.three.alt.clone(), time: this.uniforms.time, opacity: 0.34, depthWrite: false});
      entry = {key, holo: ghost, solid: ghost};
    } else {
      const faint = role === 'world';
      entry = {
        key,
        holo: hologram({base: base.clone().lerp(theme.three.primary, 0.5), rim: theme.three.primary.clone(), time: this.uniforms.time, opacity: faint ? 0.3 : 0.9, depthWrite: !faint}),
        solid: new THREE.MeshStandardMaterial({color: base, roughness: 0.62, metalness: 0.1, transparent: rgba[3] < 1, opacity: rgba[3], side: THREE.DoubleSide}),
      };
      entry.solid.clipShadows = false;
    }
    this.materials.push(entry);
    return entry;
  }

  build(fit = true) {
    const {shapes, motion, recording} = this.replay;
    this.clear();
    if (!recording || !shapes || !motion || this.replay.world.state !== 'ready') return;
    if (this.geometryKey !== shapes.meta.key) { for (const geometry of this.geometries.values()) geometry.dispose(); this.geometries.clear(); this.geometryKey = shapes.meta.key; }
    const meta = shapes.meta, commanded = new Set(motion.meta.commanded);
    this.bodies = meta.bodies.map(body => { const group = new THREE.Group(); group.name = body.name; group.matrixAutoUpdate = false; this.root.add(group); return group; });
    this.ghosts = meta.bodies.map((body, index) => {
      if (!commanded.has(index) || !motion.ghost) return null;
      const group = new THREE.Group(); group.name = `${body.name} (commanded)`; group.matrixAutoUpdate = false; this.root.add(group); return group;
    });
    const position = new THREE.Vector3(), rotation = new THREE.Quaternion();
    for (const geom of meta.geoms) {
      const geometry = this.geometry(geom, shapes);
      if (!geometry) continue;
      const make = (role, parent, order) => {
        const mesh = new THREE.Mesh(geometry, null);
        mesh.userData.looks = this.material(geom.rgba, role); mesh.renderOrder = order;
        mesh.position.fromArray(geom.pos); quaternion(mesh.quaternion, geom.quat); mesh.userData.world = geom.body === 0;
        parent.add(mesh);
      };
      make(geom.body === 0 ? 'world' : 'body', this.bodies[geom.body], geom.body === 0 ? 2 : 3);
      if (this.ghosts[geom.body]) make('ghost', this.ghosts[geom.body], 4);
    }

    // Each camera that has pictures in the episode: its frustum, with the picture of the moment as its screen.
    for (const camera of meta.cameras) {
      const pictures = this.replay.pictures.find(entry => camera.name.split('/').pop() === entry.name);
      if (!pictures) continue;
      const rig = new THREE.Group();
      rig.position.fromArray(camera.pos); quaternion(rig.quaternion, camera.quat);
      // A MuJoCo camera looks along its -z with y up, as a three.js camera does.
      const half = Math.tan(THREE.MathUtils.degToRad(camera.fovy) / 2) * SCREEN_DEPTH, wide = half * (pictures.width / pictures.height || 4 / 3);
      const corners = [[-wide, half], [wide, half], [wide, -half], [-wide, -half]].map(([x, y]) => new THREE.Vector3(x, y, -SCREEN_DEPTH));
      const points = [];
      corners.forEach((corner, index) => points.push(new THREE.Vector3(), corner, corner, corners[(index + 1) % 4]));
      const lines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({color: this.theme.three.alt, transparent: true, opacity: 0.9}));
      const texture = new THREE.CanvasTexture(pictures.canvas); texture.colorSpace = THREE.SRGBColorSpace;
      const plane = new THREE.BufferGeometry().setFromPoints(corners);
      plane.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 1, 1, 1, 0, 0, 0], 2)); plane.setIndex([0, 2, 1, 0, 3, 2]);
      const screen = new THREE.Mesh(plane, new THREE.MeshBasicMaterial({map: texture, side: THREE.DoubleSide, transparent: true, opacity: 0.96}));
      screen.renderOrder = 5; lines.renderOrder = 5;
      rig.add(lines, screen); this.bodies[camera.body].add(rig);
      this.rigs.push({rig, lines, screen, texture, pictures, version: -1});
    }

    // The path of each thing that travelled: all of it faintly, the part behind the playhead brightly.
    const {poses, times} = motion, bodies = motion.meta.bodies, free = new Set(motion.meta.free);
    for (const body of motion.meta.trails) {
      const path = new Float32Array(times.length * 3);
      for (let index = 0; index < times.length; index++) path.set(poses.subarray((index * bodies + body) * 7, (index * bodies + body) * 7 + 3), index * 3);
      const attribute = new THREE.BufferAttribute(path, 3), color = free.has(body) ? this.theme.three.alt : this.theme.three.primary;
      const line = opacity => { const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', attribute); const object = new THREE.Line(geometry, new THREE.LineBasicMaterial({color, transparent: true, opacity, depthWrite: false})); object.frustumCulled = false; object.renderOrder = 6; this.root.add(object); return object; };
      this.trails.push({all: line(0.22), past: line(0.95)});
    }
    this.built = true; this.apply();
    this.app.layers.root.visible = false; this.root.visible = true;
    this.update(performance.now());
    if (fit) this.fit();
  }

  // The options as they are now: which look, and what is shown.
  apply() {
    if (!this.built) return;
    const {style, ghost, trails, cameras, surroundings} = this.options;
    this.root.traverse(child => { if (child.isMesh && child.userData.looks) { child.material = child.userData.looks[style]; if (child.userData.world) child.visible = surroundings; } });
    for (const group of this.ghosts) if (group) group.visible = ghost;
    for (const trail of this.trails) trail.all.visible = trail.past.visible = trails;
    for (const {rig} of this.rigs) rig.visible = cameras;
    this.clipped = null;
  }

  // Bring the part of the world where things happen onto the table: everywhere a moving body went.
  fit() {
    const motion = this.replay.motion;
    if (!motion) return;
    const {poses, meta} = motion, box = new THREE.Box3(), point = new THREE.Vector3();
    const moving = new Set([...meta.trails, ...meta.free, ...meta.commanded]);
    for (let index = 0; index < meta.count; index += 4) for (const body of moving) box.expandByPoint(point.fromArray(poses, (index * meta.bodies + body) * 7));
    if (box.isEmpty()) return;
    box.expandByScalar(0.12);
    // The table's surface is where the lowest object stands, not below it.
    let floor = Infinity;
    for (const body of meta.free) for (let index = 0; index < meta.count; index += 8) floor = Math.min(floor, poses[(index * meta.bodies + body) * 7 + 2]);
    if (Number.isFinite(floor)) box.min.z = floor - 0.004;
    this.app.layers.follow = null; this.app.layers.autoFollow = false;
    this.stage.frame(box);
  }

  // -- every frame --------------------------------------------------------------------------------------
  update(now) {
    if (!this.built) return;
    const replay = this.replay, {poses, ghost, times, meta} = replay.motion, count = meta.bodies;
    this.uniforms.time.value = now / 1000;

    // The two snapshots around the playhead, and how far between them it is.
    const time = replay.time;
    let low = 0, high = times.length - 1;
    while (low < high) { const mid = (low + high + 1) >> 1; if (times[mid] <= time) low = mid; else high = mid - 1; }
    const next = Math.min(low + 1, times.length - 1), span = times[next] - times[low];
    this.place(this.bodies, poses, low * count, next * count, span > 0 ? Math.min(1, Math.max(0, (time - times[low]) / span)) : 0);
    if (ghost && this.options.ghost) {
      const frame = replay.frame, after = Math.min(frame + 1, replay.times.length - 1), step = replay.times[after] - replay.times[frame];
      this.place(this.ghosts, ghost, frame * count, after * count, step > 0 ? Math.min(1, Math.max(0, (time - replay.times[frame]) / step)) : 0);
    }
    for (const trail of this.trails) trail.past.geometry.setDrawRange(0, low + 1);
    for (const rig of this.rigs) if (rig.version !== rig.pictures.version) { rig.version = rig.pictures.version; rig.texture.needsUpdate = true; }

    // Clipping: the table's edges and its surface; nothing at life size.
    const root = this.stage.root, up = this.up.set(0, 1, 0).applyQuaternion(root.quaternion);
    this.bottom.setFromNormalAndCoplanarPoint(up, this.point.copy(root.position).addScaledVector(up, -0.012));
    const planes = this.stage.lifeSize || !this.stage.clipping ? this.none : this.clips;
    if (planes !== this.clipped) {
      this.clipped = planes;
      const set = material => { material.clippingPlanes = planes; material.needsUpdate = true; };
      for (const entry of this.materials) { set(entry.holo); set(entry.solid); }
      for (const rig of this.rigs) { set(rig.lines.material); set(rig.screen.material); }
      for (const trail of this.trails) { set(trail.all.material); set(trail.past.material); }
    }
  }

  // Move each group to its body's pose between two rows of a pose table (7 numbers per body).
  place(groups, table, rowA, rowB, share) {
    const {from, to, turnFrom, turnTo, one} = this;
    for (let body = 0; body < groups.length; body++) {
      const group = groups[body];
      if (!group) continue;
      const a = (rowA + body) * 7, b = (rowB + body) * 7;
      from.fromArray(table, a).lerp(to.fromArray(table, b), share);
      quaternion(turnFrom, table, a + 3).slerp(quaternion(turnTo, table, b + 3), share);
      group.matrix.compose(from, turnFrom, one); group.matrixWorldNeedsUpdate = true;
    }
  }
}
