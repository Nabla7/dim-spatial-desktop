// One pointer model for a mouse, XR controllers, tracked hands and gaze-and-pinch headsets.
// A pointer is a ray plus a primary press. It can hit a panel, pick an object in the scene, or
// (pressed in empty space) take hold of the world on the table: one hand pans, two hands zoom and turn.
// XR presses come from the session's select/squeeze events, not from polling buttons, because those
// events are the user activation that focusing a text box or starting the microphone needs.
import * as THREE from 'three';

const _matrix = new THREE.Matrix4(), _inverse = new THREE.Matrix4(), _a = new THREE.Vector3(), _b = new THREE.Vector3();
const _position = new THREE.Vector3(), _quaternion = new THREE.Quaternion(), _scale = new THREE.Vector3();

export class Pointers {
  constructor({renderer, scene, camera, dock, stage, orbit, text}) {
    Object.assign(this, {renderer, scene, camera, dock, stage, orbit, text});
    this.raycaster = new THREE.Raycaster(); this.raycaster.far = 30;
    this.picks = new Map();          // Object3D -> {onClick, onHover, cursor}
    this.sources = new Map();        // XRInputSource -> pointer
    this.mouse = this.pointer('mouse', 'mouse');
    this.worldGrabs = new Map();     // pointer id -> grabbed robot-frame point (and the hand's position)
    this.twoHand = null;
    this.sticks = {left: [0, 0], right: [0, 0]};
    this.onEmptyClick = null;
    this.bindMouse();
  }

  pointer(id, kind) {
    return {id, kind, ray: new THREE.Ray(), hit: null, down: false, press: null, panelGrab: null, hovered: null,
      grip: new THREE.Vector3(), pose: new THREE.Matrix4(), visual: null, active: false};
  }

  pick(object, handlers) { this.picks.set(object, handlers); object.userData.pickRoot = true; return object; }
  unpick(object) { this.picks.delete(object); }

  // -- hit testing ----------------------------------------------------------------------------------
  cast(pointer) {
    this.raycaster.ray.copy(pointer.ray);
    const meshes = [];
    for (const panel of this.dock.panels) if (!panel.closing && panel.group.visible) meshes.push(panel.mesh);
    const panelHit = this.raycaster.intersectObjects(meshes, false)[0];
    let best = null;
    if (panelHit?.uv) {
      const panel = panelHit.object.userData.panel;
      best = {type: 'panel', panel, x: panelHit.uv.x * panel.dw, y: (1 - panelHit.uv.y) * panel.dh, point: panelHit.point, distance: panelHit.distance};
    }
    if (this.picks.size) {
      const visible = [...this.picks.keys()].filter(object => object.visible && object.parent);
      const hit = this.raycaster.intersectObjects(visible, true)[0];
      if (hit && (!best || hit.distance < best.distance - 0.01)) {
        let object = hit.object;
        while (object && !this.picks.has(object)) object = object.parent;
        if (object) best = {type: 'pick', object, handlers: this.picks.get(object), point: hit.point, distance: hit.distance};
      }
    }
    return best;
  }

  hover(pointer, hit) {
    const before = pointer.hit;
    if (before?.type === 'panel' && before.panel !== hit?.panel) before.panel.pointerLeave(pointer.id);
    if (before?.type === 'pick' && before.object !== hit?.object) before.handlers.onHover?.(false, pointer);
    if (hit?.type === 'panel') hit.panel.pointerMove(pointer.id, hit.x, hit.y);
    if (hit?.type === 'pick' && before?.object !== hit.object) hit.handlers.onHover?.(true, pointer);
    pointer.hit = hit;
  }

  press(pointer, {grabOnly = false} = {}) {
    const hit = pointer.hit;
    pointer.down = true;
    if (hit?.type === 'panel') {
      const result = grabOnly ? 'grab' : hit.panel.pointerDown(pointer.id, hit.x, hit.y);
      if (result === 'grab') this.beginPanelGrab(pointer, hit);
      else pointer.press = {type: 'panel', panel: hit.panel};
      return;
    }
    if (this.text.active) this.text.blur();
    if (hit?.type === 'pick' && !grabOnly) { pointer.press = {type: 'pick', object: hit.object}; return; }
    pointer.press = {type: 'world'};
    if (pointer.kind !== 'mouse') this.beginWorldGrab(pointer);
  }

  release(pointer) {
    const press = pointer.press, hit = pointer.hit;
    pointer.down = false; pointer.press = null;
    if (pointer.panelGrab) { this.endPanelGrab(pointer); return; }
    if (press?.type === 'panel') {
      const same = hit?.type === 'panel' && hit.panel === press.panel;
      press.panel.pointerUp(pointer.id, same ? hit.x : null, same ? hit.y : null);
    }
    if (press?.type === 'pick' && hit?.type === 'pick' && hit.object === press.object) hit.handlers.onClick?.(hit, pointer);
    if (press?.type === 'world') {
      this.endWorldGrab(pointer);
      if (pointer.kind === 'mouse' && !pointer.dragged) this.onEmptyClick?.();
    }
  }

  // -- moving a panel -------------------------------------------------------------------------------
  beginPanelGrab(pointer, hit) {
    const group = hit.panel.group, entry = this.dock.entries.get(hit.panel.id);
    if (!entry) return;
    entry.held = true;
    if (pointer.kind === 'mouse') {
      // On the HUD a panel slides in its own plane: keep the offset between the cursor and its centre.
      const local = group.parent.worldToLocal(hit.point.clone());
      pointer.panelGrab = {panel: hit.panel, entry, offset: group.position.clone().sub(local), depth: local.z};
    } else {
      group.updateWorldMatrix(true, false);
      pointer.panelGrab = {panel: hit.panel, entry, offset: _inverse.copy(pointer.pose).invert().multiply(group.matrixWorld).clone()};
    }
  }

  movePanelGrab(pointer, dt) {
    const grab = pointer.panelGrab, group = grab.panel.group;
    if (pointer.kind === 'mouse') {
      // Intersect the cursor ray with the plane the panel slides in (HUD space, constant depth).
      const origin = group.parent.worldToLocal(pointer.ray.origin.clone());
      const direction = pointer.ray.direction.clone().transformDirection(_inverse.copy(group.parent.matrixWorld).invert());
      const t = (grab.depth - origin.z) / direction.z;
      if (!Number.isFinite(t) || t <= 0) return;
      group.position.copy(origin.addScaledVector(direction, t)).add(grab.offset);
    } else {
      // Held like a card on a stick; the thumbstick reels it in and out.
      const stick = this.sticks[pointer.handedness]?.[1] ?? 0;
      if (stick) grab.offset.elements[14] = Math.min(-0.15, grab.offset.elements[14] + stick * dt * 0.9);
      _matrix.copy(pointer.pose).multiply(grab.offset);
      group.parent.updateWorldMatrix(true, false);
      _matrix.premultiply(_inverse.copy(group.parent.matrixWorld).invert()).decompose(_position, _quaternion, _scale);
      group.position.copy(_position); group.quaternion.copy(_quaternion);
    }
    this.dock.release(grab.panel);
  }

  endPanelGrab(pointer) {
    const grab = pointer.panelGrab;
    grab.entry.held = false; this.dock.release(grab.panel);
    grab.panel.pointerUp(pointer.id, null, null);
    pointer.panelGrab = null;
  }

  // -- holding the world ----------------------------------------------------------------------------
  // The hand's position, or for the mouse where its ray meets the table's plane.
  grabPoint(pointer) {
    if (pointer.kind !== 'mouse') return pointer.grip.clone();
    const origin = this.stage.root.worldToLocal(pointer.ray.origin.clone());
    const direction = pointer.ray.direction.clone().transformDirection(_inverse.copy(this.stage.root.matrixWorld).invert());
    const t = -origin.y / direction.y;
    if (!Number.isFinite(t) || t <= 0 || t > 50) return null;
    return this.stage.root.localToWorld(origin.addScaledVector(direction, t));
  }

  beginWorldGrab(pointer) {
    const point = this.grabPoint(pointer);
    if (!point) return;
    this.worldGrabs.set(pointer.id, {pointer, held: this.stage.toRobot(point.clone())});
    this.twoHand = null; this.stage.onManualMove?.();
  }

  endWorldGrab(pointer) {
    if (!this.worldGrabs.delete(pointer.id)) return;
    this.twoHand = null;
    // The remaining hand keeps holding from where it is now, not from where it started.
    for (const grab of this.worldGrabs.values()) { const point = this.grabPoint(grab.pointer); if (point) grab.held = this.stage.toRobot(point); }
  }

  // The floor stays on the table: a hold slides, turns and scales the world, it does not lift it.
  // (Which height is on the table is the View panel's "floor" setting.)
  moveWorld() {
    const grabs = [...this.worldGrabs.values()], stage = this.stage;
    if (!grabs.length) return;
    const points = grabs.map(grab => this.grabPoint(grab.pointer)), floor = stage.view.center.z;
    if (points.some(point => !point)) return;
    if (grabs.length >= 2) {
      const [p, q] = points.map(point => stage.root.worldToLocal(point.clone()));
      const span = p.distanceTo(q), angle = Math.atan2(-(q.z - p.z), q.x - p.x);
      if (!this.twoHand) this.twoHand = {span, angle, scale: stage.view.scale, yaw: stage.view.yaw, held: grabs[0].held.clone().add(grabs[1].held).multiplyScalar(0.5)};
      const start = this.twoHand;
      if (span > 0.04 && start.span > 0.04) {
        stage.view.scale = stage.target.scale = THREE.MathUtils.clamp(start.scale * span / start.span, 0.002, 4);
        if (Math.hypot(q.x - p.x, q.z - p.z) > 0.06) stage.view.yaw = stage.target.yaw = start.yaw + Math.atan2(Math.sin(angle - start.angle), Math.cos(angle - start.angle));
        stage.apply();
      }
      const middle = points[0].clone().add(points[1]).multiplyScalar(0.5);
      stage.view.center.add(start.held.clone().sub(stage.toRobot(middle)));
    } else {
      stage.view.center.add(grabs[0].held.clone().sub(stage.toRobot(points[0].clone())));
    }
    stage.view.center.z = floor;
    stage.target.center.copy(stage.view.center); stage.apply();
  }

  // -- mouse ----------------------------------------------------------------------------------------
  bindMouse() {
    const element = this.renderer.domElement, pointer = this.mouse, ndc = new THREE.Vector2();
    const aim = event => {
      const box = element.getBoundingClientRect();
      ndc.set((event.clientX - box.left) / box.width * 2 - 1, 1 - (event.clientY - box.top) / box.height * 2);
      this.raycaster.setFromCamera(ndc, this.camera);
      pointer.ray.copy(this.raycaster.ray); pointer.active = true;
    };
    // Capturing listeners run before OrbitControls' own, so a press on a panel never also orbits the camera.
    element.addEventListener('pointermove', event => {
      if (this.renderer.xr.isPresenting) return;
      aim(event);
      if (pointer.panelGrab) { this.movePanelGrab(pointer, 0); return; }
      if (pointer.start && Math.hypot(event.clientX - pointer.start[0], event.clientY - pointer.start[1]) > 4) pointer.dragged = true;
      this.hover(pointer, this.cast(pointer));
      if (this.worldGrabs.size) this.moveWorld();
      element.style.cursor = pointer.hit?.type === 'pick' ? 'pointer' : pointer.hit?.type === 'panel' && pointer.hit.panel.regionAt(pointer.hit.x, pointer.hit.y)?.onClick ? 'pointer' : '';
    }, true);
    element.addEventListener('pointerdown', event => {
      if (this.renderer.xr.isPresenting) return;
      aim(event); this.hover(pointer, this.cast(pointer));
      pointer.start = [event.clientX, event.clientY]; pointer.dragged = false;
      if (pointer.hit) { this.orbit.enabled = false; element.setPointerCapture(event.pointerId); if (event.button === 0) this.press(pointer); return; }
      // Empty space: the left button orbits (OrbitControls), the right button slides the world across the table.
      if (event.button === 2) { this.orbit.enabled = false; pointer.press = {type: 'world'}; this.beginWorldGrab(pointer); }
      else { pointer.press = {type: 'world'}; if (this.text.active) this.text.blur(); }
    }, true);
    const up = event => {
      if (this.renderer.xr.isPresenting) return;
      aim(event); this.hover(pointer, this.cast(pointer));
      this.release(pointer); this.orbit.enabled = true; pointer.start = null;
    };
    element.addEventListener('pointerup', up, true);
    element.addEventListener('pointercancel', up, true);
    element.addEventListener('pointerleave', () => { this.hover(pointer, null); pointer.active = false; });
    element.addEventListener('contextmenu', event => event.preventDefault());
    element.addEventListener('wheel', event => {
      if (this.renderer.xr.isPresenting) return;
      aim(event); this.hover(pointer, this.cast(pointer));
      const hit = pointer.hit;
      if (hit?.type === 'panel') { hit.panel.scroll(hit.x, hit.y, event.deltaY * (event.deltaMode ? 30 : 1)); event.preventDefault(); event.stopImmediatePropagation(); return; }
      // A trackpad pinch (or ctrl + wheel) rescales the world about the point under the cursor.
      if (event.ctrlKey || event.metaKey) {
        // A pinch arrives as many small deltas, a wheel notch as one large one: bound what one event may do.
        // While the robot is followed it stays the centre of the zoom; otherwise the point under the cursor does.
        this.stage.scaleAbout(Math.exp(THREE.MathUtils.clamp(-event.deltaY * 0.01, -0.22, 0.22)), this.stage.following?.() ? null : this.grabPoint(pointer));
        this.stage.view.scale = this.stage.target.scale;
        event.preventDefault(); event.stopImmediatePropagation();
      }
    }, {capture: true, passive: false});
  }

  // -- XR -------------------------------------------------------------------------------------------
  bindSession(session, reference) {
    this.reference = reference;
    const source = event => this.sourcePointer(event.inputSource, event.frame);
    session.addEventListener('selectstart', event => { const pointer = source(event); this.hover(pointer, this.cast(pointer)); this.press(pointer); });
    session.addEventListener('selectend', event => { const pointer = source(event); if (pointer.kind !== 'gaze') this.hover(pointer, this.cast(pointer)); this.release(pointer); });
    // The grip button takes hold of whatever the ray is on: a panel anywhere on its face, else the world.
    session.addEventListener('squeezestart', event => { const pointer = source(event); this.hover(pointer, this.cast(pointer)); pointer.squeezing = true; this.press(pointer, {grabOnly: true}); });
    session.addEventListener('squeezeend', event => { const pointer = source(event); pointer.squeezing = false; this.release(pointer); });
    session.addEventListener('inputsourceschange', event => { for (const removed of event.removed) this.dropSource(removed); });
    session.addEventListener('end', () => { for (const input of [...this.sources.keys()]) this.dropSource(input); this.worldGrabs.clear(); this.twoHand = null; });
  }

  sourcePointer(input, frame) {
    let pointer = this.sources.get(input);
    if (!pointer) {
      const kind = input.targetRayMode === 'tracked-pointer' ? (input.hand ? 'hand' : 'controller') : 'gaze';
      pointer = this.pointer(`xr-${input.handedness}-${kind}-${this.sources.size}`, kind);
      pointer.handedness = input.handedness; pointer.input = input;
      pointer.visual = this.makeRay(); this.scene.add(pointer.visual.group);
      this.sources.set(input, pointer);
    }
    if (frame) this.poseSource(pointer, frame);
    return pointer;
  }

  dropSource(input) {
    const pointer = this.sources.get(input);
    if (!pointer) return;
    if (pointer.down) this.release(pointer);
    this.hover(pointer, null); this.endWorldGrab(pointer);
    pointer.visual?.group.removeFromParent();
    this.sources.delete(input);
  }

  poseSource(pointer, frame) {
    const input = pointer.input, rayPose = frame.getPose(input.targetRaySpace, this.reference);
    pointer.active = !!rayPose;
    if (!rayPose) return;
    pointer.pose.fromArray(rayPose.transform.matrix);
    pointer.ray.origin.setFromMatrixPosition(pointer.pose);
    pointer.ray.direction.set(0, 0, -1).transformDirection(pointer.pose);
    const gripPose = input.gripSpace ? frame.getPose(input.gripSpace, this.reference) : null;
    if (gripPose) pointer.grip.copy(gripPose.transform.position); else pointer.grip.copy(pointer.ray.origin);
  }

  makeRay() {
    const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]);
    geometry.setAttribute('color', new THREE.Float32BufferAttribute([1, 1, 1, 0, 0, 0], 3));
    const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false}));
    const dot = new THREE.Mesh(new THREE.RingGeometry(0.006, 0.009, 24), new THREE.MeshBasicMaterial({color: 0xffffff, transparent: true, depthTest: false, side: THREE.DoubleSide}));
    dot.renderOrder = 60; line.renderOrder = 59; line.frustumCulled = false;
    const group = new THREE.Group(); group.add(line, dot);
    return {group, line, dot};
  }

  update(dt, frame, tint) {
    if (!frame || !this.renderer.xr.isPresenting) { if (this.mouse.panelGrab) this.movePanelGrab(this.mouse, dt); return; }
    const session = frame.session;
    for (const input of session.inputSources) {
      // A gaze-and-pinch source exists only while pinched; it is posed by its events.
      if (input.targetRayMode !== 'tracked-pointer') continue;
      const pointer = this.sourcePointer(input, frame);
      if (input.gamepad && !input.hand && (input.handedness === 'left' || input.handedness === 'right')) {
        const axes = input.gamepad.axes, dead = value => Math.abs(value || 0) < 0.18 ? 0 : value;
        this.sticks[input.handedness] = [dead(axes[2]), dead(axes[3])];
      }
    }
    for (const pointer of this.sources.values()) {
      if (pointer.kind === 'gaze' && pointer.down) this.poseSource(pointer, frame);
      const visual = pointer.visual;
      if (!pointer.active) { visual.group.visible = false; continue; }
      if (pointer.panelGrab) this.movePanelGrab(pointer, dt);
      else if (!this.worldGrabs.has(pointer.id)) this.hover(pointer, this.cast(pointer));
      // Ray and cursor.
      const hit = pointer.hit, holding = pointer.panelGrab || this.worldGrabs.has(pointer.id);
      const length = holding ? 0.12 : hit ? hit.distance : 0.9;
      const positions = visual.line.geometry.attributes.position, colors = visual.line.geometry.attributes.color;
      _a.copy(pointer.ray.origin); _b.copy(pointer.ray.origin).addScaledVector(pointer.ray.direction, length);
      positions.setXYZ(0, _a.x, _a.y, _a.z); positions.setXYZ(1, _b.x, _b.y, _b.z); positions.needsUpdate = true;
      const strength = hit ? 1 : 0.35;
      colors.setXYZ(0, tint.r * strength, tint.g * strength, tint.b * strength); colors.setXYZ(1, hit ? tint.r : 0, hit ? tint.g : 0, hit ? tint.b : 0); colors.needsUpdate = true;
      visual.group.visible = true;
      visual.dot.visible = !!hit && !holding;
      if (hit) {
        visual.dot.position.copy(hit.point);
        if (hit.type === 'panel') hit.panel.group.getWorldQuaternion(visual.dot.quaternion); else visual.dot.lookAt(pointer.ray.origin);
        visual.dot.scale.setScalar((pointer.down ? 0.7 : 1) * Math.max(1, hit.distance));
        visual.dot.material.color.copy(tint);
      }
    }
    this.moveWorld();
    // Thumbsticks: over a panel the stick scrolls it; otherwise the right stick turns and zooms the world
    // and the left stick slides it.
    const overPanel = side => [...this.sources.values()].find(p => p.handedness === side && p.hit?.type === 'panel');
    for (const side of ['left', 'right']) {
      const [x, y] = this.sticks[side], pointer = overPanel(side);
      if (pointer && y && !pointer.panelGrab) { pointer.hit.panel.scroll(pointer.hit.x, pointer.hit.y, y * dt * 900); continue; }
      if (pointer?.panelGrab || this.worldGrabs.size) continue;
      const stage = this.stage;
      if (side === 'right') {
        if (x) stage.target.yaw = stage.view.yaw -= x * dt * 1.6;
        if (y) stage.scaleAbout(Math.exp(-y * dt * 1.4));
      } else if (x || y) {
        const step = dt * 0.5 / stage.view.scale, c = Math.cos(-stage.view.yaw), s = Math.sin(-stage.view.yaw);
        // Stick right/forward in the viewer's frame -> robot x/y through the view's yaw.
        const right = x * step, forward = -y * step;
        stage.onManualMove?.();
        stage.target.center.x += forward * c - right * s; stage.target.center.y += -(right * c + forward * s);
      }
    }
  }
}
