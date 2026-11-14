// The WebXR input contract: raw grip-space poses and xr-standard buttons. The backend owns
// coordinate conversion, clutch references, IK, speed limits and recording. No scene transform
// belongs here: moving or scaling the hologram must never change the operator's arm targets.
import {gateway} from './gateway.js';

const SIDES = ['left', 'right'], PERIOD = 1000 / 60;
const header = (side, now) => ({seq: 0, stamp: {sec: Math.floor(now / 1000), nsec: (now % 1000) * 1e6}, frame_id: side});
export const neutralJoy = (side, now = Date.now()) => ({header: header(side, now), axes_length: 4, axes: [0, 0, 0, 0], buttons_length: 7, buttons: Array(7).fill(0)});

// Match the input protocol, not a robot/class or a deployment's topic names. Remapped keys stay intact.
export function xrBinding(modules) {
  const inputs = modules.map(module => ({module,
    pose: module.streams.find(s => s.name === 'webxr_pose' && s.direction === 'in' && s.type === 'geometry_msgs.PoseStamped' && s.key),
    joy: module.streams.find(s => s.name === 'webxr_joy' && s.direction === 'in' && s.type === 'sensor_msgs.Joy' && s.key),
  })).filter(input => input.pose && input.joy);
  const selectors = modules.filter(module => module.rpcs.some(rpc => rpc.name === 'select_teleop_source' &&
    rpc.params.some(param => param.name === 'source' && param.choices?.includes('webxr'))));
  if (inputs.length !== 1 || selectors.length > 1) return null;
  return {...inputs[0], selector: selectors[0] ?? null};
}

export function controllerSample(input, pose, now = Date.now()) {
  if (!SIDES.includes(input.handedness) || input.hand || !input.gamepad || !pose || pose.emulatedPosition) return null;
  const {position: p, orientation: q} = pose.transform, values = [p.x, p.y, p.z, q.x, q.y, q.z, q.w];
  if (!values.every(Number.isFinite) || Math.abs(Math.hypot(q.x, q.y, q.z, q.w) - 1) > 0.01) return null;
  const pad = input.gamepad, offset = pad.mapping === 'xr-standard' ? 2 : 0;
  const axes = [pad.axes[offset] ?? 0, pad.axes[offset + 1] ?? 0, pad.buttons[0]?.value ?? 0, pad.buttons[1]?.value ?? 0];
  if (!axes.every(Number.isFinite)) return null;
  const buttons = Array.from({length: 7}, (_, i) => pad.buttons[i]?.pressed ? 1 : 0);
  return {pose: {header: header(input.handedness, now), pose: {position: {x: p.x, y: p.y, z: p.z}, orientation: {x: q.x, y: q.y, z: q.z, w: q.w}}},
    joy: {header: header(input.handedness, now), axes_length: 4, axes, buttons_length: buttons.length, buttons}};
}

export class XRControls {
  constructor(controls) {
    this.controls = controls; this.binding = null; this.enabled = false; this.busy = false;
    this.generation = 0; this.targets = {}; this.hands = {}; this.error = null; this.lastSent = -Infinity;
    this.resetHands();
  }

  resetHands() { for (const side of SIDES) this.hands[side] = {released: false, tracked: false, engaged: false, input: null}; }
  get ownsInputs() { return this.enabled || this.busy; }
  get available() { return !!this.binding; }

  discover(modules) {
    const binding = xrBinding(modules);
    const identity = b => b ? [b.module.id, b.pose.key, b.joy.key, b.selector?.id].join('|') : '';
    if (identity(binding) !== identity(this.binding)) this.stop();
    this.binding = binding;
  }

  // Called only by the HEADSET ARMS button. Never select a source or acquire command rights on load.
  async start() {
    const c = this.controls, binding = this.binding;
    if (!c.armed || !c.app.xr.presenting || !binding || this.ownsInputs) return;
    const generation = ++this.generation;
    this.busy = true; this.error = null; this.resetHands(); for (const source of ['pad', 'keys', 'sticks']) c.setInput(source, 0, 0, 0); c.emit();
    const current = () => generation === this.generation && c.armed && c.app.xr.presenting && c.bus.live;
    try {
      if (!c.bus.live) throw new Error('The robot connection is offline.');
      // One channel per hand: "latest" must not replace the other hand's message on the shared topic.
      for (const side of SIDES) {
        this.targets[side] = {};
        for (const kind of ['pose', 'joy']) {
          const stream = binding[kind];
          this.targets[side][kind] = {...stream, publisherKey: `${stream.key}#${side}`, live: true,
            options: {delivery: 'latest', latencyLimit: 100}};
        }
      }
      await c.claim([binding.pose.key, binding.joy.key]);
      if (!current()) return;
      if (c.lease.status !== 'held') throw new Error(c.lease.reason || 'Could not acquire the controls.');
      await Promise.all(SIDES.flatMap(side => ['pose', 'joy'].map(kind => c.entry(this.targets[side][kind]).publisher.ready())));
      if (!current()) return;
      // The two deadmen clear both hands if the page/link disappears. The backend also expires input.
      await Promise.all(SIDES.map(async side => {
        const target = this.targets[side].joy, entry = c.entry(target);
        const bytes = c.encode(target.type, neutralJoy(side));
        if (!bytes) throw new Error('Controller message encoding is unavailable.');
        await entry.publisher.setDeadman(bytes); entry.deadman = true;
      }));
      if (!current()) return;
      if (binding.selector) {
        const answer = await gateway.callRpc(binding.selector.id, 'select_teleop_source', {source: 'webxr'});
        if (!current()) return;
        if (!answer.ok || answer.result?.source !== 'webxr') throw new Error(answer.error || 'Headset input was not selected.');
      }
      this.enabled = true; this.lastSent = -Infinity; this.lastFrame = null;
      c.app.pointers?.cancelGrabs?.();
      c.app.toast('Headset arms on. Release both grips, then hold both to move the arms.', 'info', 7);
    } catch (error) {
      if (generation === this.generation) { this.stop(); this.error = error.message; c.app.toast(`Headset arms: ${error.message}`, 'danger'); }
    } finally {
      if (generation === this.generation) this.busy = false;
      c.emit();
    }
  }

  neutral(side) {
    const target = this.targets[side]?.joy;
    if (target) this.controls.publish(target, this.controls.encode(target.type, neutralJoy(side)));
  }

  stop() {
    const was = this.ownsInputs;
    this.generation++; this.enabled = false; this.busy = false;
    if (was) for (const side of SIDES) this.neutral(side);
    this.resetHands();
    if (was) this.controls.emit();
  }

  // Explicit return to another device. Stopping headset input alone never silently enables a leader.
  async selectSource(source) {
    if (!this.controls.armed || this.busy || !this.binding?.selector) return;
    this.stop();
    try {
      const answer = await gateway.callRpc(this.binding.selector.id, 'select_teleop_source', {source});
      if (!answer.ok) throw new Error(answer.error || 'Input selection failed');
      this.controls.app.toast(`${source} input selected`, 'info');
    } catch (error) { this.error = error.message; }
    this.controls.emit();
  }

  frame(frame, reference, now) {
    if (!this.enabled) return;
    const c = this.controls;
    if (!c.armed || !c.bus.live || !frame || !reference || frame.session.visibilityState !== 'visible' || c.lease.status !== 'held') {
      this.stop(); return;
    }
    if (this.lastFrame !== null && now - this.lastFrame > 150) this.resetHands();
    this.lastFrame = now;
    if (now - this.lastSent < PERIOD) return;
    this.lastSent = now;
    let changed = false;
    for (const side of SIDES) {
      const hand = this.hands[side], input = [...frame.session.inputSources].find(input => input.handedness === side && !input.hand);
      const pose = input?.gripSpace ? frame.getPose(input.gripSpace, reference) : null;
      const sample = input && controllerSample(input, pose);
      const was = `${hand.tracked}:${hand.released}:${hand.engaged}`;
      if (input !== hand.input) { hand.released = false; hand.engaged = false; hand.input = input; }
      hand.tracked = !!sample;
      if (!sample) {
        this.neutral(side); hand.released = false; hand.engaged = false;
      } else {
        const pointer = c.app.pointers?.sources.get(input);
        const overPanel = pointer?.hit?.type === 'panel';
        const uiBusy = !!pointer?.panelGrab || (pointer?.down && pointer?.press?.type === 'panel');
        const held = sample.joy.axes[3] > 0.5;
        // A grip first pressed on UI stays blocked until released. Once engaged, crossing a panel
        // with the ray does not interrupt a deliberate arm movement.
        if (uiBusy || (overPanel && !hand.engaged && held)) hand.released = false;
        if (!uiBusy && !held && sample.joy.axes[2] <= 0.5 && !sample.joy.buttons[3]) hand.released = true;
        hand.engaged = hand.released && held;
        if (!hand.released || uiBusy) sample.joy = neutralJoy(side);
        else if (overPanel) { sample.joy.axes[0] = sample.joy.axes[1] = 0; sample.joy.buttons[3] = 0; }
        c.publish(this.targets[side].pose, c.encode(this.targets[side].pose.type, sample.pose));
        c.publish(this.targets[side].joy, c.encode(this.targets[side].joy.type, sample.joy));
      }
      changed ||= was !== `${hand.tracked}:${hand.released}:${hand.engaged}`;
    }
    if (changed) c.emit();
  }
}
