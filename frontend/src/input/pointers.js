// One pointer model for a mouse, XR controllers, tracked hands and gaze-and-pinch headsets.
// A pointer is a ray plus a primary press. It can hit a panel, pick an object in the scene, or
// (pressed in empty space) take hold of the world on the table: one hand pans, two hands zoom and turn.
// XR presses come from the session's select/squeeze events, not from polling buttons, because those
// events are the user activation that focusing a text box or starting the microphone needs.
// A gamepad the browser has, held in hands a headset tracks, is the one exception (input/gamepads.js): its
// buttons are polled, so they press and hold like a trigger and a grip but are no such activation.
import * as THREE from 'three';
import {describePads, heldPads, padAction} from './gamepads.js';

const SIDES = ['left', 'right'];
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
    // A gamepad in the hands: per hand and button, whether it was down last frame and the pointer it holds down.
    this.pads = Object.fromEntries(SIDES.map(side => [side, {select: {was: false, holding: null}, squeeze: {was: false, holding: null}}]));
    this.padInfo = []; this.padKey = '';
    this.padTeleop = false;
    this.onPads = null;              // (pads, added, gone) => void: the gamepads the browser has, or what is pressed, changed
    this.onEmptyClick = null;
    this.onWorldClick = null;        // a press on the scene that did not move it: (pointer) => void
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
    if (this.sceneInputLocked?.()) return null;
    this.raycaster.ray.copy(pointer.ray);
    const meshes = [];
    for (const panel of this.dock.panels) if (!panel.closing && panel.group.visible && panel.group.parent?.visible !== false) meshes.push(panel.mesh);
    const panelHit = this.raycaster.intersectObjects(meshes, false)[0];
    let best = null;
    if (panelHit?.uv) {
      const panel = panelHit.object.userData.panel;
      best = {type: 'panel', panel, x: panelHit.uv.x * panel.dw, y: (1 - panelHit.uv.y) * panel.dh, point: panelHit.point, distance: panelHit.distance};
    }
    if (this.picks.size) {
      const visible = [...this.picks.keys()].filter(object => object.visible && object.parent);
      const hit = this.raycaster.intersectObjects(visible, true)[0];
      // On a screen a panel is drawn over the scene, so it is hit before anything of the scene, however near
      // that is. In a room the nearer of the two is the one in front.
      const panelsFirst = this.dock.mode === 'hud';
      if (hit && (!best || (!panelsFirst && hit.distance < best.distance - 0.01))) {
        let object = hit.object;
        while (object && !this.picks.has(object)) object = object.parent;
        // Many things drawn as one (an instanced mesh) say which of them was hit.
        if (object) best = {type: 'pick', object, handlers: this.picks.get(object), point: hit.point, distance: hit.distance, instanceId: hit.instanceId};
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
    if (this.sceneInputLocked?.()) return;
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
    // A press on the table can be an answer to "point at it" (a goal waiting for a place).
    if (!grabOnly && this.offerTablePoint(pointer)) { pointer.press = {type: 'given'}; return; }
    pointer.press = {type: 'world', at: performance.now(), from: pointer.grip.clone()};
    if (pointer.kind !== 'mouse') this.beginWorldGrab(pointer);
  }

  release(pointer) {
    const locked = this.sceneInputLocked?.();
    const press = locked && pointer.press?.type === 'world' ? null : pointer.press, hit = locked ? null : pointer.hit;
    pointer.down = false; pointer.press = null;
    if (pointer.panelGrab) { this.endPanelGrab(pointer); return; }
    if (press?.type === 'panel') {
      const same = hit?.type === 'panel' && hit.panel === press.panel;
      press.panel.pointerUp(pointer.id, same ? hit.x : null, same ? hit.y : null);
    }
    if (press?.type === 'pick' && hit?.type === 'pick' && hit.object === press.object) hit.handlers.onClick?.(hit, pointer);
    if (press?.type === 'world') {
      this.endWorldGrab(pointer);
      if (pointer.kind === 'mouse' && !pointer.dragged) { this.onEmptyClick?.(); this.onWorldClick?.(pointer); }
      // A hand or a controller: a short press that did not move the world is a press on what it points at.
      else if (pointer.kind !== 'mouse' && press.from && performance.now() - press.at < 400 && pointer.grip.distanceTo(press.from) < 0.02) this.onWorldClick?.(pointer);
    }
  }

  // onTablePoint(point in the robot's fixed frame) returns true when it used the point.
  offerTablePoint(pointer) {
    if (!this.onTablePoint) return false;
    const point = this.tablePoint(pointer);
    return !!point && this.onTablePoint(this.stage.toRobot(point.clone())) === true;
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
    _a.copy(group.position);
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
    // A press on a title bar that moves nothing is not a move: the panel stays in the dock's arrangement.
    if (!grab.moved && _a.distanceTo(group.position) < 0.002) return;
    grab.moved = true;
    this.dock.release(grab.panel);
  }

  endPanelGrab(pointer) {
    const grab = pointer.panelGrab;
    grab.entry.held = false; if (grab.moved) this.dock.release(grab.panel);
    grab.panel.pointerUp(pointer.id, null, null);
    pointer.panelGrab = null;
  }

  // -- holding the world ----------------------------------------------------------------------------
  // The hand's position, or for the mouse where its ray meets the table's plane.
  grabPoint(pointer) {
    return pointer.kind !== 'mouse' ? pointer.grip.clone() : this.tablePoint(pointer);
  }

  // Where a pointer's ray meets the table's plane (scene coordinates), or null if it points away from it.
  tablePoint(pointer) {
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
      else if (this.offerTablePoint(pointer)) { this.orbit.enabled = false; pointer.press = {type: 'given'}; }
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
  syncSceneLock() {
    const locked = !!this.sceneInputLocked?.();
    if (locked && !this.sceneWasLocked) {
      this.cancelGrabs();
      for (const pointer of [this.mouse, ...this.sources.values()]) this.hover(pointer, null);
    }
    this.sceneWasLocked = locked;
    return locked;
  }

  cancelGrabs() {
    for (const pointer of [this.mouse, ...this.sources.values()]) if (pointer.down || pointer.panelGrab) this.cancel(pointer);
    this.worldGrabs.clear(); this.twoHand = null;
  }

  cancel(pointer) {
    this.hover(pointer, null);
    if (pointer.press?.type === 'world') pointer.press = null;
    if (pointer.down) this.release(pointer);
    this.endWorldGrab(pointer);
  }

  bindSession(session, reference) {
    this.reference = reference;
    const source = event => this.sourcePointer(event.inputSource, event.frame);
    session.addEventListener('selectstart', event => {
      const pointer = source(event); this.hover(pointer, this.cast(pointer));
      // A trigger while gripping belongs to the robot gripper, never to a panel behind its ray.
      if (this.teleopOwnsInputs?.() && (event.inputSource.gamepad?.buttons[1]?.value > 0.5 || pointer.hit?.type !== 'panel')) return;
      this.press(pointer);
    });
    session.addEventListener('selectend', event => { const pointer = source(event); if (pointer.kind !== 'gaze') this.hover(pointer, this.cast(pointer)); if (pointer.down) this.release(pointer); });
    // The grip button takes hold of whatever the ray is on: a panel anywhere on its face, else the world.
    session.addEventListener('squeezestart', event => { if (this.teleopOwnsInputs?.()) return; const pointer = source(event); this.hover(pointer, this.cast(pointer)); pointer.squeezing = true; this.press(pointer, {grabOnly: true}); });
    session.addEventListener('squeezeend', event => { const pointer = source(event); if (!pointer.squeezing) return; pointer.squeezing = false; this.release(pointer); });
    session.addEventListener('inputsourceschange', event => { for (const removed of event.removed) this.dropSource(removed); });
    session.addEventListener('end', () => {
      for (const input of [...this.sources.keys()]) this.dropSource(input);
      this.worldGrabs.clear(); this.twoHand = null;
      for (const side of SIDES) { this.sticks[side] = [0, 0]; for (const button of Object.values(this.pads[side])) { button.was = false; button.holding = null; } }
    });
  }

  sourcePointer(input, frame) {
    let pointer = this.sources.get(input);
    if (!pointer) {
      const kind = input.hand ? 'hand' : input.targetRayMode === 'tracked-pointer' ? 'controller' : 'gaze';
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
    if (pointer.down) this.cancel(pointer);
    this.hover(pointer, null); this.endWorldGrab(pointer);
    pointer.visual?.group.removeFromParent();
    this.sources.delete(input);
  }

  poseSource(pointer, frame) {
    const input = pointer.input;
    let rayPose = input.targetRaySpace ? frame.getPose(input.targetRaySpace, this.reference) : null;
    // A hand the headset gives no ray for points as its wrist lies: out along the hand.
    if (!rayPose && input.hand && frame.getJointPose) { const wrist = input.hand.get('wrist'); rayPose = wrist ? frame.getJointPose(wrist, this.reference) : null; }
    pointer.active = !!rayPose;
    if (!rayPose) return;
    pointer.pose.fromArray(rayPose.transform.matrix);
    pointer.ray.origin.setFromMatrixPosition(pointer.pose);
    pointer.ray.direction.set(0, 0, -1).transformDirection(pointer.pose);
    const gripPose = input.gripSpace ? frame.getPose(input.gripSpace, this.reference) : null;
    if (gripPose) pointer.grip.copy(gripPose.transform.position); else pointer.grip.copy(pointer.ray.origin);
  }

  // The gamepads the browser has. A frame that may not ask (a permissions policy) has none.
  gamepads() {
    try { return [...(navigator.getGamepads?.() ?? [])].filter(Boolean); } catch { return []; }
  }

  notePads(pads) {
    const info = describePads(pads), key = JSON.stringify(info);
    if (key === this.padKey) return;
    const before = new Set(this.padInfo.map(pad => pad.id)), after = new Set(info.map(pad => pad.id));
    const added = info.filter(pad => !before.has(pad.id)), gone = this.padInfo.filter(pad => !after.has(pad.id));
    this.padKey = key; this.padInfo = info;
    this.onPads?.(info, added, gone);
  }

  // A gamepad's trigger presses what its hand points at and its shoulder button takes hold of it, as a
  // controller's trigger and grip do. The hand's pointer is the one the headset tracks for that hand.
  padButtons(held) {
    const teleop = this.teleopOwnsInputs?.() === true;
    const locked = !!this.sceneInputLocked?.(), mode = `${teleop}:${locked}`;
    const changedMode = mode !== this.padTeleop; this.padTeleop = mode;
    for (const side of SIDES) {
      const pointer = [...this.sources.values()].find(p => p.handedness === side && p.kind === 'hand' && p.active) ?? null;
      for (const [name, grabOnly] of [['select', false], ['squeeze', true]]) {
        const button = this.pads[side][name], pressed = !!held[side]?.[name];
        if (changedMode) {
          if (button.holding) this.cancel(button.holding);
          button.holding = null; button.was = pressed;
        }
        const action = padAction({was: button.was, pressed, holding: button.holding, pointer});
        button.was = pressed;
        if (action === 'release') {
          const holding = button.holding; button.holding = null;
          if (holding.down && this.sources.get(holding.input) === holding) {
            if (holding === pointer && held[side]) this.release(holding);
            else this.cancel(holding);
          }
        }
        if (action !== 'press' || locked) continue;
        this.hover(pointer, this.cast(pointer));
        // Before arm engagement, panels remain available for setup and calibration.
        if (teleop && (grabOnly || pointer.hit?.type !== 'panel')) continue;
        this.press(pointer, {grabOnly}); button.holding = pointer;
      }
    }
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
    const locked = this.syncSceneLock();
    if (!frame || !this.renderer.xr.isPresenting) {
      if (this.mouse.panelGrab) this.movePanelGrab(this.mouse, dt);
      // A gamepad is used in a headset, where a hand points. It is seen, and said, on a screen too.
      this.notePads(this.gamepads());
      return;
    }
    const session = frame.session, dead = value => Math.abs(value || 0) < 0.18 ? 0 : value, controllers = new Set();
    for (const input of session.inputSources) {
      // A gaze-and-pinch source exists only while pinched; it is posed by its events.
      if (input.targetRayMode !== 'tracked-pointer' && !input.hand) continue;
      this.sourcePointer(input, frame);
      if (input.gamepad && !input.hand && SIDES.includes(input.handedness)) {
        const axes = input.gamepad.axes;
        this.sticks[input.handedness] = [dead(axes[2]), dead(axes[3])]; controllers.add(input.handedness);
      }
    }
    // A gamepad the browser has is in the hands: a hand with no controller has that pad's stick, else none.
    const pads = this.gamepads(), held = heldPads(pads);
    for (const side of SIDES) if (!controllers.has(side)) this.sticks[side] = held[side] ? held[side].stick.map(dead) : [0, 0];
    this.notePads(pads);
    for (const pointer of this.sources.values()) {
      if (pointer.kind === 'gaze' && pointer.down) this.poseSource(pointer, frame);
      const visual = pointer.visual;
      if (!pointer.active || locked) { visual.group.visible = false; continue; }
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
    this.padButtons(held);
    if (locked) return; // No panel scrolling, world movement or UI button consumption during arm teleop.
    this.moveWorld();
    // Thumbsticks: over a panel the stick scrolls it; otherwise the right stick turns and zooms the world
    // and the left stick slides it.
    const overPanel = side => [...this.sources.values()].find(p => p.handedness === side && p.hit?.type === 'panel');
    // While the robot's drive is armed, a stick that is not scrolling a panel drives the robot and no longer moves the view.
    const idle = [0, 0], driving = this.driveSticks?.(overPanel('left') ? idle : this.sticks.left, overPanel('right') ? idle : this.sticks.right) === true;
    for (const side of ['left', 'right']) {
      const [x, y] = this.sticks[side], pointer = overPanel(side);
      if (pointer && y && !pointer.panelGrab) { pointer.hit.panel.scroll(pointer.hit.x, pointer.hit.y, y * dt * 900); continue; }
      if (driving || pointer?.panelGrab || this.worldGrabs.size) continue;
      const stage = this.stage;
      if (side === 'right') {
        if (x) stage.target.yaw = stage.view.yaw -= x * dt * 1.6;
        if (y && !stage.lifeSize) stage.scaleAbout(Math.exp(-y * dt * 1.4));
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
