// A scene on the table: the visible shapes of a USD stage as the server derived them for a browser, and
// over them what was found out about the scene. The collision shapes, the floor a body reaches, the places
// where what is seen and what is solid disagree, the places the manifest names, the cameras of the
// recording it was made from (each with its picture), the points the user marked, and what a new
// revision changed. The scene is in its own frame (metres, z up), which is the table's.
//
// It is looked at in two ways: as a miniature on the table, cut open from above, or from inside at life
// size (WALK): on a screen the keys move the viewer and a drag turns the head, in a headset the viewer
// stands in it and the sticks move the scene.
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {gateway} from '../data/gateway.js';
import {hologram} from './hologram.js';

const EYE = 1.6;            // metres above the floor point the viewer stands on, on a screen
const KEPT = 2;             // revisions whose shapes stay in memory, so that two can be flipped between
const FRUSTUM = 0.32;       // metres: how far a recorded camera's frustum reaches when it is not the one shown
const PICTURE = 1.6;        // metres in front of its camera that the shown picture hangs
const SPEED = 1.5, FAST = 5;
const KEYS = {KeyW: [0, 1], ArrowUp: [0, 1], KeyS: [0, -1], ArrowDown: [0, -1], KeyA: [-1, 0], ArrowLeft: [-1, 0], KeyD: [1, 0], ArrowRight: [1, 0]};

export class SceneView extends EventTarget {
  constructor(app) {
    super();
    this.app = app; this.scenes = app.scenes; this.stage = app.stage; this.theme = app.theme;
    this.root = new THREE.Group(); this.root.name = 'scene'; this.root.visible = false; this.stage.world.add(this.root);
    this.loader = new GLTFLoader();
    this.models = new Map(); this.model = null; this.loadingKey = null;
    this.uniforms = {time: {value: 0}};
    // Everything drawn here obeys the table's edge, its lid, and a plane just under its surface.
    this.bottom = new THREE.Plane(); this.clips = [...this.stage.clipPlanes, this.bottom]; this.none = []; this.clipped = null; this.materials = new Set();
    this.layers = {};
    for (const name of ['solid', 'floor', 'marks', 'places', 'views', 'pins', 'changes', 'cursor']) { const group = new THREE.Group(); group.name = name; this.root.add(group); this.layers[name] = group; }
    this.sized = [];            // things that keep their size on the table whatever the scale: {object, metres}
    this.walk = {on: false, yaw: 0, pitch: 0, roll: 0, keys: new Set(), saved: null};
    this.pictureOpacity = 0.85;
    this.up = new THREE.Vector3(); this.point = new THREE.Vector3();

    const scenes = this.scenes;
    scenes.addEventListener('open', () => this.opened());
    scenes.addEventListener('close', () => this.closed());
    scenes.addEventListener('view', () => this.load());
    scenes.addEventListener('revision', () => { this.drawPlaces(); this.drawViews(); this.drawPins(); this.drawCursor(); });
    scenes.addEventListener('floor', () => { this.drawFloor(); this.drawMarks(); this.drawPlaces(); });
    scenes.addEventListener('pins', () => this.drawPins());
    scenes.addEventListener('select', () => this.drawCursor());
    scenes.addEventListener('diff', () => this.drawChanges());
    scenes.addEventListener('layers', () => this.apply());
    this.theme.addEventListener('change', () => { if (scenes.active) this.redraw(); });
    this.bindWalk();
  }

  // -- a scene comes and goes ---------------------------------------------------------------------------
  opened() {
    const {app, stage} = this;
    this.before = {ceiling: stage.ceiling, halo: app.halo.enabled};
    app.halo.enabled = false;
    app.layers.root.visible = false; app.layers.follow = null; app.layers.autoFollow = false;
    this.root.visible = true; this.framed = false;
    app.pointers.onWorldClick = pointer => this.click(pointer);
    this.redraw();
  }

  closed() {
    const {app, stage} = this;
    if (this.walk.on) this.leave();
    app.pointers.onWorldClick = null;
    this.root.visible = false;
    if (this.model) { this.root.remove(this.model.group); this.model = null; }
    for (const model of this.models.values()) this.dispose(model);
    this.models.clear();
    for (const name of Object.keys(this.layers)) this.empty(name);
    this.solidKey = null;
    if (this.before) { stage.ceiling = this.before.ceiling; app.halo.enabled = this.before.halo; }
    app.layers.root.visible = !app.replay.active;
  }

  redraw() { this.drawFloor(); this.drawMarks(); this.drawPlaces(); this.drawViews(); this.drawPins(); this.drawCursor(); this.drawChanges(); this.apply(); }

  track(material) { this.materials.add(material); this.clipped = null; return material; }

  empty(name) {
    const group = this.layers[name];
    for (const child of [...group.children]) {
      child.removeFromParent();
      child.traverse(object => {
        if (object.userData.pick) this.app.pointers.unpick(object);
        object.geometry?.dispose();
        for (const material of [].concat(object.material || [])) { material.map?.dispose(); material.dispose(); this.materials.delete(material); }
      });
    }
    this.sized = this.sized.filter(entry => entry.layer !== name);
  }

  dispose(model) {
    model.group.traverse(object => {
      if (!object.isMesh) return;
      object.geometry.dispose();
      for (const material of [].concat(object.material)) {
        for (const key of ['map', 'normalMap', 'metalnessMap', 'roughnessMap', 'emissiveMap', 'aoMap']) material[key]?.dispose();
        material.dispose(); this.materials.delete(material);
      }
    });
  }

  // -- the shapes ---------------------------------------------------------------------------------------
  async load() {
    const scenes = this.scenes, key = `${scenes.id}:${scenes.open.usd.stamp}`;
    if (this.loadingKey === key) return;
    this.loadingKey = key;
    try {
      let model = this.models.get(key);
      if (!model) {
        const total = scenes.view.report?.seen.bytes || 1;
        const gltf = await new Promise((resolve, reject) => this.loader.load(scenes.fileUrl('scene.glb'), resolve, event => scenes.viewProgress(Math.min(0.98, event.loaded / total)), reject));
        if (!scenes.active || `${scenes.id}:${scenes.open.usd.stamp}` !== key) return;
        // glTF has y up; the scene has z up.
        const group = new THREE.Group(); group.rotation.x = Math.PI / 2; group.add(gltf.scene);
        const sharp = Math.min(4, this.app.renderer.capabilities.getMaxAnisotropy());
        gltf.scene.traverse(object => {
          if (!object.isMesh) return;
          for (const material of [].concat(object.material)) { this.track(material); if (material.map) material.map.anisotropy = sharp; }
        });
        group.updateMatrixWorld(true);
        model = {key, group};
        this.models.set(key, model);
      } else { this.models.delete(key); this.models.set(key, model); }
      // The revision before stays in memory to be flipped back to; older ones go.
      for (const [other, old] of this.models) if (this.models.size > KEPT && other !== key) { this.dispose(old); this.models.delete(other); }
      if (this.model) this.root.remove(this.model.group);
      this.model = model; this.root.add(model.group);
      this.solidKey = null; this.empty('solid');
      this.apply();
      if (!this.framed) { this.framed = true; this.fit(); }
      scenes.viewReady();
    } catch (error) { if (scenes.active) scenes.viewFailed(error.message || 'the shapes could not be loaded'); }
    if (this.loadingKey === key) this.loadingKey = null;
  }

  // The collision shapes, as a ghost over what is seen. Loaded the first time they are asked for.
  async loadSolid() {
    const scenes = this.scenes, key = `${scenes.id}:${scenes.open.usd.stamp}`;
    if (this.solidKey === key || !scenes.view.report?.solid.triangles) return;
    this.solidKey = key;
    try {
      const gltf = await new Promise((resolve, reject) => this.loader.load(scenes.fileUrl('collision.glb'), resolve, undefined, reject));
      if (this.solidKey !== key || !scenes.active) return;
      this.empty('solid');
      const group = new THREE.Group(); group.rotation.x = Math.PI / 2; group.add(gltf.scene);
      const look = this.track(hologram({base: this.theme.three.alt.clone(), rim: this.theme.three.alt.clone(), time: this.uniforms.time, opacity: 0.55, depthWrite: false}));
      gltf.scene.traverse(object => { if (object.isMesh) { object.geometry.computeVertexNormals(); object.material = look; object.renderOrder = 3; } });
      this.layers.solid.add(group);
      this.apply();
    } catch (error) { this.solidKey = null; this.app.toast(`The collision shapes could not be loaded: ${error.message}`, 'warn'); }
  }

  // What is shown, as the layer switches are now.
  apply() {
    const shown = this.scenes.layers;
    if (this.model) this.model.group.visible = shown.seen;
    for (const name of ['solid', 'floor', 'marks', 'places', 'views', 'pins']) this.layers[name].visible = !!shown[name];
    // A pointer finds a thing by its own switch, not its layer's: what is hidden must not be pressed.
    for (const name of ['places', 'views', 'pins']) this.layers[name].traverse(object => { if (object.userData.pick) object.visible = !!shown[name]; });
    if (shown.solid && this.scenes.active && this.scenes.view.state === 'ready') this.loadSolid();
    this.clipped = null;
  }

  // -- what was found out, drawn over the shapes ---------------------------------------------------------
  // A word in the scene that keeps its size on screen and shows through walls.
  label(layer, text, tone, {anchor = 0, size = 0.022} = {}) {
    const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d'), font = '500 34px "IBM Plex Mono", ui-monospace, monospace';
    ctx.font = font;
    canvas.width = Math.ceil(ctx.measureText(text).width) + 36; canvas.height = 56;
    ctx.font = font; ctx.textBaseline = 'middle';
    ctx.fillStyle = this.theme.c('bg', 0.82); ctx.beginPath(); ctx.roundRect(1, 1, canvas.width - 2, canvas.height - 2, 10); ctx.fill();
    ctx.strokeStyle = this.theme.c(tone); ctx.lineWidth = 3; ctx.stroke();
    ctx.fillStyle = this.theme.c(tone === 'muted' ? 'muted' : 'fg'); ctx.fillText(text, 18, canvas.height / 2 + 2);
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
    // Not cut by the table's planes (half a word says nothing): update() hides a label whose point is outside.
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({map: texture, depthTest: false, sizeAttenuation: false, transparent: true}));
    sprite.center.set(0.5, anchor); sprite.renderOrder = 30;
    // A sprite's size is multiplied by the table's scale: update() divides it out again.
    this.sized.push({layer, object: sprite, wide: size * canvas.width / canvas.height, tall: size});
    return sprite;
  }

  // Something small to press, at a point of the scene: it keeps a size on the table that a pointer can hit.
  handle(layer, position, onClick, radius = 0.014) {
    const proxy = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 8), new THREE.MeshBasicMaterial({colorWrite: false, depthWrite: false}));
    proxy.position.fromArray(position); proxy.userData.pick = true;
    this.app.pointers.pick(proxy, {onClick});
    this.sized.push({layer, object: proxy, metres: radius, least: 0.12});
    return proxy;
  }

  drawFloor() {
    this.empty('floor');
    const cells = this.scenes.floor, half = (this.scenes.result('walkable')?.data.cell_m || 0.05) / 2;
    if (!cells?.length) return;
    const count = cells.length / 3, positions = new Float32Array(count * 12), index = new Uint32Array(count * 6);
    for (let cell = 0; cell < count; cell++) {
      const x = cells[cell * 3], y = cells[cell * 3 + 1], z = cells[cell * 3 + 2] + 0.012, at = cell * 12, corner = cell * 4;
      positions[at] = x - half; positions[at + 1] = y - half; positions[at + 2] = z;
      positions[at + 3] = x + half; positions[at + 4] = y - half; positions[at + 5] = z;
      positions[at + 6] = x + half; positions[at + 7] = y + half; positions[at + 8] = z;
      positions[at + 9] = x - half; positions[at + 10] = y + half; positions[at + 11] = z;
      index.set([corner, corner + 1, corner + 2, corner, corner + 2, corner + 3], cell * 6);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3)); geometry.setIndex(new THREE.BufferAttribute(index, 1));
    const mesh = new THREE.Mesh(geometry, this.track(new THREE.MeshBasicMaterial({color: this.theme.three.primary, transparent: true, opacity: 0.38, depthWrite: false, side: THREE.DoubleSide})));
    mesh.renderOrder = 4;
    this.layers.floor.add(mesh);
  }

  // Where a ray to what is seen and a ray to what is solid end apart: a body stops at nothing there
  // (red), or passes through what is seen (amber).
  drawMarks() {
    this.empty('marks');
    const marks = this.scenes.result('seen is solid')?.data.marks;
    if (!marks?.length) return;
    const mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.035, 8, 6), this.track(new THREE.MeshBasicMaterial({transparent: true, opacity: 0.9})), marks.length);
    const matrix = new THREE.Matrix4(), colours = [new THREE.Color(this.theme.c('danger')), new THREE.Color(this.theme.c('warn'))];
    marks.forEach(([x, y, z, kind], at) => { mesh.setMatrixAt(at, matrix.makeTranslation(x, y, z)); mesh.setColorAt(at, colours[kind] || colours[0]); });
    mesh.renderOrder = 5;
    this.layers.marks.add(mesh);
  }

  drawPlaces() {
    this.empty('places');
    const scenes = this.scenes;
    if (!scenes.active) return;
    const lost = new Set(scenes.result('walkable')?.data.not_reached || []);
    for (const place of scenes.open.manifest?.places || []) {
      if (!Array.isArray(place.position)) continue;
      const sprite = this.label('places', place.name, lost.has(place.name) ? 'warn' : 'primary');
      sprite.position.fromArray(place.position);
      this.layers.places.add(sprite, this.handle('places', place.position, () => scenes.select([...place.position])));
    }
  }

  // The cameras of the recording the scene was made from: each a small frustum, and one of them with its picture.
  drawViews() {
    this.empty('views');
    const scenes = this.scenes, evidence = scenes.open?.evidence;
    if (!evidence?.views.length) return;
    const points = [], eye = new THREE.Vector3();
    const proxies = new THREE.InstancedMesh(new THREE.SphereGeometry(0.045, 8, 6), this.track(new THREE.MeshBasicMaterial({color: this.theme.three.alt, transparent: true, opacity: 0.85})), evidence.views.length);
    const matrix = new THREE.Matrix4();
    evidence.views.forEach((view, at) => {
      const corners = this.corners(view, FRUSTUM);
      eye.set(view.pose[0][3], view.pose[1][3], view.pose[2][3]);
      if (view.name) corners.forEach((point, index) => points.push(eye.clone(), point, point, corners[(index + 1) % 4]));
      proxies.setMatrixAt(at, matrix.makeTranslation(eye.x, eye.y, eye.z));
      if (view.name) { const sprite = this.label('views', view.name, 'alt', {anchor: -0.6, size: 0.017}); sprite.position.copy(eye); this.layers.views.add(sprite); }
    });
    const lines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(points), this.track(new THREE.LineBasicMaterial({color: this.theme.three.alt, transparent: true, opacity: 0.45})));
    lines.renderOrder = 6; proxies.renderOrder = 6; proxies.userData.pick = true;
    this.app.pointers.pick(proxies, {onClick: hit => { if (hit.instanceId != null) this.show(hit.instanceId); }});
    this.layers.views.add(lines, proxies);
    this.drawPicture();
  }

  // The four corners of a recorded picture at `depth` metres in front of its camera, in the scene's frame.
  corners(view, depth) {
    const camera = view.camera || this.scenes.open.evidence.camera, pose = view.pose;
    return [[0, 0], [camera.width, 0], [camera.width, camera.height], [0, camera.height]].map(([u, v]) => {
      const x = (u - camera.cx) / camera.fx * depth, y = (v - camera.cy) / camera.fy * depth;
      return new THREE.Vector3(pose[0][0] * x + pose[0][1] * y + pose[0][2] * depth + pose[0][3], pose[1][0] * x + pose[1][1] * y + pose[1][2] * depth + pose[1][3], pose[2][0] * x + pose[2][1] * y + pose[2][2] * depth + pose[2][3]);
    });
  }

  show(k) { this.scenes.shown = this.scenes.shown === k ? null : k; this.drawPicture(); this.dispatchEvent(new Event('shown')); this.scenes.emit(); }

  // The picture of the chosen recorded view, hung in front of its camera. Seen from that camera it lies
  // exactly over the scene, so its opacity blends the recording with the reconstruction.
  drawPicture() {
    if (this.picture) { this.picture.removeFromParent(); this.picture.traverse(object => { object.geometry?.dispose(); if (object.material) { object.material.map?.dispose(); object.material.dispose(); this.materials.delete(object.material); } }); this.picture = null; }
    const scenes = this.scenes, view = scenes.open?.evidence?.views[scenes.shown];
    if (!view) return;
    const corners = this.corners(view, PICTURE), eye = new THREE.Vector3(view.pose[0][3], view.pose[1][3], view.pose[2][3]);
    const plane = new THREE.BufferGeometry().setFromPoints(corners);
    plane.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 1, 1, 1, 0, 0, 0], 2)); plane.setIndex([0, 2, 1, 0, 3, 2]);
    const texture = new THREE.TextureLoader().load(gateway.scenes.evidenceUrl(scenes.id, view.k)); texture.colorSpace = THREE.SRGBColorSpace;
    const screen = new THREE.Mesh(plane, this.track(new THREE.MeshBasicMaterial({map: texture, side: THREE.DoubleSide, transparent: true, opacity: this.pictureOpacity, depthTest: false})));
    screen.renderOrder = 20;
    const points = []; corners.forEach((point, index) => points.push(eye, point, point, corners[(index + 1) % 4]));
    const lines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(points), this.track(new THREE.LineBasicMaterial({color: this.theme.three.alt, depthTest: false, transparent: true})));
    lines.renderOrder = 21;
    this.picture = new THREE.Group(); this.picture.add(screen, lines); this.picture.userData.screen = screen;
    this.layers.views.add(this.picture);
  }

  setPictureOpacity(value) { this.pictureOpacity = value; if (this.picture) this.picture.userData.screen.material.opacity = value; }

  drawPins() {
    this.empty('pins');
    const scenes = this.scenes;
    for (const pin of scenes.pins) {
      const open = pin.state === 'open', focus = scenes.pinFocus === pin.n;
      const sprite = this.label('pins', `#${pin.n}`, open ? (focus ? 'fg' : 'agent') : 'muted', {anchor: -0.25, size: focus ? 0.03 : 0.024});
      sprite.position.fromArray(pin.position);
      const dot = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), this.track(new THREE.MeshBasicMaterial({color: this.theme.c(open ? 'agent' : 'muted'), depthTest: false, transparent: true})));
      dot.position.fromArray(pin.position); dot.renderOrder = 29;
      this.sized.push({layer: 'pins', object: dot, metres: 0.005, least: 0.03});
      this.layers.pins.add(sprite, dot, this.handle('pins', pin.position, () => { scenes.pinFocus = pin.n; scenes.emit('pins'); scenes.emit(); }));
    }
  }

  // The point the user pressed: a mark there, and how far behind it the solid shape is when the two differ.
  drawCursor() {
    this.empty('cursor');
    const selected = this.scenes.selected;
    if (!selected) return;
    // A ring with a cross that keeps its size on screen, so the point shows in a picture taken of the view.
    const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
    canvas.width = canvas.height = 96;
    for (const [colour, width] of [[this.theme.c('bg', 0.9), 9], [this.theme.c('fg'), 4]]) {
      ctx.strokeStyle = colour; ctx.lineWidth = width;
      ctx.beginPath(); ctx.arc(48, 48, 30, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); for (const [x0, y0, x1, y1] of [[48, 4, 48, 34], [48, 62, 48, 92], [4, 48, 34, 48], [62, 48, 92, 48]]) { ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); } ctx.stroke();
    }
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
    const ring = new THREE.Sprite(new THREE.SpriteMaterial({map: texture, depthTest: false, sizeAttenuation: false, transparent: true}));
    ring.position.fromArray(selected.point); ring.renderOrder = 31;
    this.sized.push({layer: 'cursor', object: ring, wide: 0.034, tall: 0.034, always: true});
    this.layers.cursor.add(ring);
    if (selected.seen && selected.solid && Math.abs(selected.gap) > 0.02) {
      const points = [new THREE.Vector3().fromArray(selected.seen.point), new THREE.Vector3().fromArray(selected.solid.point)];
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), this.track(new THREE.LineBasicMaterial({color: this.theme.c('warn'), depthTest: false, transparent: true})));
      line.renderOrder = 28;
      const end = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), this.track(new THREE.MeshBasicMaterial({color: this.theme.c('warn'), depthTest: false, transparent: true})));
      end.position.copy(points[1]); end.renderOrder = 28;
      this.sized.push({layer: 'cursor', object: end, metres: 0.0035, least: 0.02});
      this.layers.cursor.add(line, end);
    }
  }

  // What the revision on the table changed against the one it is compared with: boxes around what came
  // (green) and around what went (red), for what is seen and for what is solid.
  drawChanges() {
    this.empty('changes');
    const diff = this.scenes.diff;
    if (!diff) return;
    const box = new THREE.BoxGeometry(1, 1, 1), edges = new THREE.EdgesGeometry(box);
    for (const [kind, tone] of [['added', 'ok'], ['removed', 'danger']]) {
      const list = [...(diff.seen?.[kind] || []), ...(diff.solid?.[kind] || [])];
      if (!list.length) continue;
      const fill = new THREE.InstancedMesh(box, this.track(new THREE.MeshBasicMaterial({color: this.theme.c(tone), transparent: true, opacity: 0.2, depthWrite: false})), list.length);
      const matrix = new THREE.Matrix4(), size = new THREE.Vector3(), middle = new THREE.Vector3(), turn = new THREE.Quaternion(), frame = [];
      list.forEach(([x0, y0, z0, x1, y1, z1], at) => {
        middle.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2); size.set(x1 - x0 + 0.02, y1 - y0 + 0.02, z1 - z0 + 0.02);
        fill.setMatrixAt(at, matrix.compose(middle, turn, size));
        const positions = edges.attributes.position;
        for (let index = 0; index < positions.count; index++) frame.push(new THREE.Vector3().fromBufferAttribute(positions, index).multiply(size).add(middle));
      });
      const lines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(frame), this.track(new THREE.LineBasicMaterial({color: this.theme.c(tone), transparent: true, depthTest: false})));
      fill.renderOrder = 8; lines.renderOrder = 9;
      this.layers.changes.add(fill, lines);
    }
  }

  // -- where the viewer is ------------------------------------------------------------------------------
  // Bring the whole scene onto the table, standing on its lowest named place (else on its lowest point).
  fit() {
    const bounds = this.scenes.view.report?.bounds;
    if (!bounds || this.walk.on) return;
    const box = new THREE.Box3(new THREE.Vector3().fromArray(bounds.min), new THREE.Vector3().fromArray(bounds.max));
    this.stage.frame(box);
    const heights = (this.scenes.open.manifest?.places || []).map(place => place.position?.[2]).filter(Number.isFinite);
    this.setFloor(heights.length ? Math.min(...heights) : bounds.min[2]);
  }

  // Which height of the scene lies on the table's surface (a storey's floor), a little under it so the floor shows.
  setFloor(height) { this.stage.target.center.z = height - 0.04; }

  // Centre a point of the scene on the table, or stand at it when walking.
  goTo(point) {
    const stage = this.stage;
    if (this.walk.on) { stage.target.center.set(point[0], point[1], point[2]); stage.view.center.copy(stage.target.center); return; }
    stage.target.center.x = point[0]; stage.target.center.y = point[1];
  }

  // Where the viewer is and looks, in the scene's frame.
  viewer() {
    const {camera} = this.app, stage = this.stage, position = stage.toRobot(camera.getWorldPosition(new THREE.Vector3()));
    const ahead = stage.toRobot(camera.getWorldPosition(new THREE.Vector3()).add(camera.getWorldDirection(new THREE.Vector3())));
    const round = vector => vector.toArray().map(value => Math.round(value * 1000) / 1000);
    return {position: round(position), forward: round(ahead.sub(position).normalize()), walking: this.walk.on, scale: this.walk.on ? 1 : Math.round(stage.view.scale * 1e4) / 1e4};
  }

  // A picture of the scene as it is on screen now, without the panels.
  snapshot() {
    return new Promise((resolve, reject) => {
      const {renderer, scene, camera, dock} = this.app;
      if (renderer.xr.isPresenting) { reject(new Error('no picture is taken inside a headset')); return; }
      const shown = dock.hud.visible;
      dock.hud.visible = false;
      renderer.render(scene, camera);
      renderer.domElement.toBlob(blob => blob ? resolve(blob) : reject(new Error('no picture')), 'image/jpeg', 0.86);
      dock.hud.visible = shown;
    });
  }

  // A press on the scene: ask what is there. The ray starts where it enters what is shown, since the lid
  // and the table's edge cut the rest away.
  click(pointer) {
    if (!this.scenes.active || this.scenes.view.state !== 'ready') return;
    const ray = pointer.ray, origin = ray.origin.clone();
    if (this.clipped && this.clipped.length) {
      let enter = 0;
      for (const plane of this.clipped) {
        const side = plane.distanceToPoint(origin), toward = plane.normal.dot(ray.direction);
        if (side >= 0) continue;
        if (toward <= 1e-9) return;   // the ray never comes into what is shown
        enter = Math.max(enter, -side / toward);
      }
      origin.addScaledVector(ray.direction, enter + 1e-4);
    }
    const stage = this.stage, start = stage.toRobot(origin.clone()), ahead = stage.toRobot(origin.clone().add(ray.direction));
    this.scenes.pick(start.toArray(), ahead.sub(start).normalize().toArray());
  }

  // -- walking ------------------------------------------------------------------------------------------
  // Stand in the scene at a point of its floor, looking along `forward` (a direction in the scene's frame).
  enter(point = null, forward = null) {
    const {app, stage, walk} = this, xr = app.xr.presenting;
    if (!walk.on) {
      walk.saved = {center: stage.target.center.clone(), scale: stage.target.scale, yaw: stage.target.yaw, root: stage.root.position.clone(), turn: stage.root.rotation.y, fov: app.camera.fov, rotate: app.orbit.enableRotate, zoom: app.orbit.enableZoom};
      walk.on = true;
      stage.setLifeSize(true);
    }
    const at = point || [stage.target.center.x, stage.target.center.y, stage.target.center.z + 0.04];
    stage.view.scale = stage.target.scale = 1; stage.view.yaw = stage.target.yaw = 0;
    stage.target.center.set(at[0], at[1], at[2]); stage.view.center.copy(stage.target.center);
    if (xr) {
      // In a headset the viewer's own feet are the point: the scene is put under them.
      const head = app.viewer?.head || new THREE.Vector3(0, EYE, 0);
      stage.root.position.set(head.x, 0, head.z); stage.root.rotation.set(0, app.viewer?.yaw || 0, 0);
    } else {
      stage.root.position.set(0, 0, 0); stage.root.rotation.set(0, 0, 0);
      app.orbit.enableRotate = false; app.orbit.enableZoom = false;
      walk.roll = 0; walk.pitch = 0;
      if (forward) { walk.yaw = Math.atan2(forward[1], forward[0]); walk.pitch = Math.asin(THREE.MathUtils.clamp(forward[2], -1, 1)); }
    }
    stage.apply();
    this.clipped = null;
    this.scenes.emit();
  }

  // Stand where a recorded camera stood and look as it looked, so that its picture lies over the scene.
  enterView(k) {
    const view = this.scenes.open?.evidence?.views[k];
    if (!view) return;
    const pose = view.pose, camera = view.camera || this.scenes.open.evidence.camera;
    this.enter([pose[0][3], pose[1][3], pose[2][3] - EYE], [pose[0][2], pose[1][2], pose[2][2]]);
    if (this.app.xr.presenting) return;
    // The camera's own turn about its axis: its picture's down, as seen from where the viewer now looks.
    const down = new THREE.Vector3(pose[0][1], pose[1][1], pose[2][1]), three = new THREE.Vector3(-down.y, down.z, -down.x);
    const turn = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.walk.pitch, this.walk.yaw, 0, 'YXZ')).invert();
    three.applyQuaternion(turn);
    this.walk.roll = Math.atan2(three.x, -three.y);
    this.app.camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(camera.height / (2 * camera.fy))) * 1.04;
    this.app.camera.updateProjectionMatrix(); this.app.dock.layout();
    if (this.scenes.shown !== k) { this.scenes.shown = k; this.drawPicture(); }
    this.scenes.emit();
  }

  leave() {
    const {app, stage, walk} = this, saved = walk.saved;
    if (!walk.on) return;
    walk.on = false; walk.keys.clear(); app.dock.hud.visible = true;
    stage.setLifeSize(false);
    stage.target.scale = saved.scale; stage.target.yaw = saved.yaw;
    // Back on the table, the place the viewer stood at is in its middle.
    stage.target.center.z = saved.center.z; stage.view.center.copy(stage.target.center); stage.view.scale = saved.scale;
    if (app.xr.presenting) app.xr.recenter();
    else {
      stage.root.position.copy(saved.root); stage.root.rotation.set(0, saved.turn, 0);
      app.orbit.enableRotate = saved.rotate; app.orbit.enableZoom = saved.zoom;
      app.camera.fov = saved.fov; app.camera.updateProjectionMatrix(); app.resetCamera(); app.dock.layout();
    }
    stage.apply();
    this.clipped = null;
    this.scenes.emit();
  }

  bindWalk() {
    const {app, walk} = this, element = app.renderer.domElement;
    const idle = () => !walk.on || app.xr.presenting || app.text.active || app.controls.armed;
    addEventListener('keydown', event => {
      if (idle() || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.code === 'Escape') { this.leave(); return; }
      // The panels ride in front of the eyes: H puts them away and brings them back.
      if (event.code === 'KeyH') { app.dock.hud.visible = !app.dock.hud.visible; return; }
      if (KEYS[event.code] || ['KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight'].includes(event.code)) { walk.keys.add(event.code); event.preventDefault(); }
    });
    addEventListener('keyup', event => walk.keys.delete(event.code));
    addEventListener('blur', () => walk.keys.clear());
    // A drag on the scene turns the head (the pointer code has already taken a press on a panel).
    element.addEventListener('pointermove', event => {
      if (idle() || !(event.buttons & 1) || app.pointers.mouse.press?.type !== 'world') return;
      walk.yaw -= event.movementX * 0.0032; walk.pitch = THREE.MathUtils.clamp(walk.pitch - event.movementY * 0.0032, -1.45, 1.45); walk.roll = 0;
    });
    element.addEventListener('wheel', event => {
      if (idle() || event.ctrlKey || event.metaKey || app.pointers.mouse.hit) return;
      this.step(0, -Math.sign(event.deltaY) * 0.35, 0);
    }, {passive: true});
  }

  // Move the viewer by metres to its right, ahead and up. The viewer stays; the scene moves the other way.
  step(right, ahead, up) {
    const {stage, walk} = this, cos = Math.cos(walk.yaw), sin = Math.sin(walk.yaw);
    // Scene x is ahead when the yaw is zero and scene y is to the left.
    stage.target.center.x += ahead * cos + right * sin; stage.target.center.y += ahead * sin - right * cos; stage.target.center.z += up;
  }

  // -- every frame --------------------------------------------------------------------------------------
  update(now, dt) {
    if (!this.scenes.active) return;
    const {app, stage, walk} = this;
    this.uniforms.time.value = now / 1000;
    if (walk.on) {
      stage.target.scale = stage.view.scale = 1;
      if (!app.xr.presenting) {
        let right = 0, ahead = 0;
        for (const code of walk.keys) if (KEYS[code]) { right += KEYS[code][0]; ahead += KEYS[code][1]; }
        const pace = (walk.keys.has('ShiftLeft') || walk.keys.has('ShiftRight') ? FAST : SPEED) * dt;
        const up = (walk.keys.has('KeyE') ? 1 : 0) - (walk.keys.has('KeyQ') ? 1 : 0);
        if (right || ahead || up) this.step(right * pace, ahead * pace, up * pace);
        // A camera looks along its -z; with no yaw that is the scene's x.
        app.camera.position.set(0, EYE, 0);
        app.camera.quaternion.setFromEuler(new THREE.Euler(walk.pitch, walk.yaw, walk.roll, 'YXZ'));
      }
    }
    // Marks and handles keep a size on the table that can be seen and hit, whatever the scale.
    const scale = stage.view.scale;
    // Clipping: the table's edges, its lid and its surface; nothing when the viewer is inside.
    const root = stage.root, up = this.up.set(0, 1, 0).applyQuaternion(root.quaternion);
    this.bottom.setFromNormalAndCoplanarPoint(up, this.point.copy(root.position).addScaledVector(up, -0.006));
    const planes = stage.lifeSize || !stage.clipping ? this.none : this.clips;
    if (planes !== this.clipped) {
      this.clipped = planes;
      for (const material of this.materials) { material.clippingPlanes = planes; material.needsUpdate = true; }
    }
    for (const entry of this.sized) {
      if (!entry.wide) { entry.object.scale.setScalar(Math.max(entry.least, entry.metres / scale)); continue; }
      entry.object.scale.set(entry.wide / scale, entry.tall / scale, 1);
      // A label shows whole or not at all: it is hidden when its point is outside what the table shows.
      const at = entry.object.getWorldPosition(this.point);
      entry.object.visible = entry.always || planes.every(plane => plane.distanceToPoint(at) >= 0);
    }
  }
}
