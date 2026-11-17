// Direct control of the running robot, found the same way as everything else: from the blueprint.
// A stream that some module reads is a command it accepts, and its message type says which control
// fits it: a Twist is driven, a number is set, a pose is pointed at, a JointState is jogged.
//
// Nothing here publishes on its own. Controls are dead until the user arms them, a drive publishes
// only while a pad, a key or a stick is held, and the first drive input stores a stop command on the
// gateway that it sends by itself if this page goes away (the deadman).
import {gateway} from './gateway.js';
import {MotionSpeeds} from './motion-speeds.js';
import {XRControls} from './xr-controls.js';

const DRIVE = ['geometry_msgs.Twist', 'geometry_msgs.TwistStamped'];
const NUMBER = ['std_msgs.Float32', 'std_msgs.Int32', 'std_msgs.Int8', 'std_msgs.UInt32'];
const GOAL = ['geometry_msgs.PoseStamped', 'geometry_msgs.PointStamped'];
const PERIOD = 66; // ms between drive commands

// Desktop's zenoh gateway lets one client at a time publish on a command key: a lease. Every app that
// drives takes one on its first command, and the newest to drive wins. Without it this page's commands
// are dropped whenever another app (Controller, say) drove last. All spatial pages share one group name.
const LEASE_GROUP = 'dim-spatial-desktop';
const LEASE_TIMEOUT_MS = 5000;       // the lease outlives a short stall of the link; a drive's deadman does not
const RETAKE_AFTER_IDLE_MS = 1500;   // taken over, only a new press takes it back, not the hold that was going

// A pose is offered as "point at it on the table" only where a place on the floor is what the stream wants: a
// navigation goal. A pose for an arm (a cartesian command) must never come from a press on the floor.
const FLOOR_GOAL = /goal|waypoint|clicked|destination|nav/;
// A number that is not a quantity (button bits, a mode, a counter) gets no slider.
const NOT_A_QUANTITY = /button|mask|flag|bits|mode|index|count|seq|_id$/;
// A stream of joint states that nothing in the blueprint writes is a state the page should not invent, not a command.
const STATE_TOPIC = /state$/;
// An RPC that sets one named joint: (name: str, position: float), as in arm_joint or set_joint.
const JOINT_NAME = /^(name|joint|joint_name)$/, JOINT_VALUE = /^(position|angle|target|value|q|rad)$/;
// RPCs the blueprint's own start-up uses to hand configuration between modules: not for a person to press.
export const PLUMBING = /^(deliver_|simulation_config$|robot_models$|config_receive$)/;

// RPCs that only report: not offered as actions.
const READS = /^(get|list|is|has|describe|status|statistics|inspect|info|show|read|query|check|peek|deliver|robot_models|simulation_config)(_|$)/;

const stamp = () => { const now = Date.now(); return {sec: Math.floor(now / 1000), nsec: (now % 1000) * 1e6}; };
const header = frame => ({seq: 0, stamp: stamp(), frame_id: frame || ''});

export class Controls extends EventTarget {
  constructor(app) {
    super();
    this.app = app; this.bus = app.bus;
    this.armed = false; this.drives = []; this.numbers = []; this.switches = []; this.goals = []; this.joints = []; this.actions = []; this.statuses = [];
    this.driveKey = null; this.strafe = false; this.speed = {linear: 0.3, angular: 0.8};
    this.motionSpeeds = new MotionSpeeds(this);
    this.inputs = {pad: [0, 0, 0], keys: [0, 0, 0], sticks: [0, 0, 0]};
    this.command = [0, 0, 0]; this.moving = false; this.zeros = 0; this.lastSent = 0;
    this.publishers = new Map(); this.values = new Map(); this.known = new Map(); this.aiming = null; this.jointState = null; this.jointSubscription = null;
    this.lease = {status: 'off', reason: null, keys: [], handle: null, taking: null, again: false}; this.lastCommandAt = -Infinity;
    this.ranges = this.load('spatial.ranges'); this.pins = this.load('spatial.pins'); this.modes = this.load('spatial.modes');
    this.heldNumbers = new Map(); this.zeroing = [];
    this.held = new Set();
    this.xr = new XRControls(this);
    app.blueprint.addEventListener('modules', () => this.discover());
    addEventListener('keydown', event => this.key(event, true));
    addEventListener('keyup', event => this.key(event, false));
    addEventListener('blur', () => { this.held.clear(); this.keys(); });
    addEventListener('pagehide', () => this.disarm());
    this.discover();
  }

  load(name) { try { return JSON.parse(localStorage.getItem(name) || '{}'); } catch { return {}; } }
  save(name, value) { try { localStorage.setItem(name, JSON.stringify(value)); } catch { /* private mode */ } }
  emit() { this.dispatchEvent(new Event('change')); }

  // -- what can be controlled -----------------------------------------------------------------------
  discover() {
    const blueprint = this.app.blueprint, found = new Map();
    this.motionSpeeds.discover(blueprint.modules);
    this.xr.discover(blueprint.modules);
    for (const module of blueprint.modules) for (const stream of module.streams) {
      if (!stream.key || !stream.type) continue;
      if (!found.has(stream.key)) found.set(stream.key, {key: stream.key, topic: stream.topic, type: stream.type, readers: [], writers: []});
      found.get(stream.key)[stream.direction === 'out' ? 'writers' : 'readers'].push(module.name);
    }
    // Only what something reads; a stream a module of the blueprint already writes is listed last (two writers fight).
    const commands = [...found.values()].filter(target => target.readers.length).sort((a, b) => a.writers.length - b.writers.length || a.topic.localeCompare(b.topic));
    // A target keeps its identity from one look at the blueprint to the next: it carries what is being sent to it.
    const keep = target => { const known = this.known.get(target.key); if (known) return Object.assign(known, target); this.known.set(target.key, target); return target; };
    this.drives = commands.filter(target => DRIVE.includes(target.type)).map(keep);
    this.numbers = commands.filter(target => NUMBER.includes(target.type) && !NOT_A_QUANTITY.test(target.topic)).map(keep);
    this.switches = commands.filter(target => target.type === 'std_msgs.Bool').map(keep);
    this.goals = commands.filter(target => GOAL.includes(target.type) && FLOOR_GOAL.test(target.topic)).map(keep);
    this.joints = commands.filter(target => target.type === 'sensor_msgs.JointState' && !target.writers.length && !STATE_TOPIC.test(target.topic)).map(target => keep({...target, kind: 'stream', label: target.topic.replace(/^\//, '')}));
    this.states = [...found.values()].filter(target => target.type === 'sensor_msgs.JointState' && target.writers.length).sort((a, b) => Number(/joint_state$/.test(b.topic)) - Number(/joint_state$/.test(a.topic)));
    if (!this.drives.some(target => target.key === this.driveKey)) this.driveKey = (this.drives.find(target => /cmd_vel$/.test(target.topic)) || this.drives[0])?.key ?? null;
    this.actions = []; this.statuses = [];
    for (const module of blueprint.modules) for (const rpc of module.rpcs) {
      const pinned = this.pins[`${module.name}.${rpc.name}`], required = rpc.params.filter(param => param.required);
      // An action is an RPC that needs nothing typed: no required parameters, and not a getter. A pin overrides both.
      if (pinned || (!READS.test(rpc.name) && !PLUMBING.test(rpc.name) && !required.length)) this.actions.push({module, rpc, pinned: !!pinned, kwargs: pinned?.kwargs || {}});
      if (/^(get_)?(status|state)$/.test(rpc.name) && !required.length) this.statuses.push({module, rpc});
      // A joint can also be set through an RPC that takes its name and a position.
      const name = required.find(param => param.type === 'str' && JOINT_NAME.test(param.name)), value = required.find(param => param.type === 'float' && JOINT_VALUE.test(param.name));
      if (name && value && required.length === 2) this.joints.push(keep({kind: 'rpc', key: `rpc:${module.id}.${rpc.name}`, label: `${rpc.name}()`, module, rpc, nameParam: name.name, valueParam: value.name, readers: [module.name], writers: []}));
    }
    this.actions.sort((a, b) => Number(b.pinned) - Number(a.pinned) || Number(b.rpc.skill) - Number(a.rpc.skill));
    if (!blueprint.running && this.armed) this.disarm();
    this.emit();
  }

  get any() { return this.xr.available || this.drives.length + this.numbers.length + this.switches.length + this.goals.length + this.joints.length + this.actions.length > 0; }

  get settingNumbers() { const keys = this.motionSpeeds.keys; return this.numbers.filter(target => !keys.has(target.key)); }

  setDriveSpeed(axis, value) {
    if (this.motionSpeeds.provider) this.motionSpeeds.set(this.motionSpeeds.drive[axis], value);
    else this.speed[axis] = value;
  }

  pin(module, rpc, kwargs) {
    const key = `${module.name}.${rpc.name}`;
    if (this.pins[key]) delete this.pins[key]; else this.pins[key] = {kwargs};
    this.save('spatial.pins', this.pins); this.discover();
  }

  pinned(module, rpc) { return !!this.pins[`${module.name}.${rpc.name}`]; }

  // -- arming ---------------------------------------------------------------------------------------
  arm(on) {
    if (on === this.armed) return;
    if (!on) { this.disarm(); return; }
    this.armed = true; this.emit();
  }

  disarm() {
    const was = this.armed;
    this.xr.stop();
    this.armed = false; this.aiming = null; this.held.clear();
    for (const input of Object.values(this.inputs)) input.fill(0);
    if (this.moving) { this.send([0, 0, 0]); this.moving = false; }
    for (const entry of this.publishers.values()) if (entry.deadman) { entry.publisher.clearDeadman?.().catch(() => {}); entry.deadman = false; }
    this.watchJoints(false);
    for (const target of this.joints) target.want = null;
    // Whatever was held gets its stop before the right to send is given back.
    for (const {target} of this.heldNumbers.values()) this.publish(target, this.encode(target.type, {data: 0}));
    this.heldNumbers.clear(); this.zeroing = [];
    this.releaseLease();
    if (was) this.emit();
  }

  // Stop everything that moves by velocity, armed or not.
  stop() {
    this.xr.stop();
    for (const input of Object.values(this.inputs)) input.fill(0);
    this.held.clear(); this.heldNumbers.clear();
    // A stop is worth taking the controls for, from whoever has them. Unarmed, they are given back right after.
    this.stopping = true;
    for (const target of this.drives) this.publish(target, this.twist(target, [0, 0, 0]));
    this.stopping = false;
    if (!this.armed) setTimeout(() => { if (!this.armed) this.releaseLease(); }, 1000);
    this.moving = false; this.command = [0, 0, 0];
    this.app.toast('Headset arms stopped; stop sent on every drive stream', 'warn');
    this.emit();
  }

  // -- the right to command ---------------------------------------------------------------------------
  // A command is about to go out on `key`. Takes the lease when it is not held (after another app took it
  // over: only on a new press). Returns a promise while the lease is being taken, else null.
  claim(key) {
    const now = performance.now(), idle = now - this.lastCommandAt, lease = this.lease, client = this.bus.client;
    this.lastCommandAt = now;
    if (!this.armed && !this.stopping) return null;            // only armed controls, or STOP, may take the robot from another app
    if (typeof client?.lease !== 'function') return null;     // a gateway from before leases: nothing to take
    const keys = Array.isArray(key) ? key : [key], added = keys.some(key => !lease.keys.includes(key));
    if (added) lease.keys = [...new Set([...lease.keys, ...keys])].sort();
    if (lease.status === 'taking') { lease.again ||= added; return lease.taking; }
    if (lease.status === 'held' && !added) return null;
    if ((lease.status === 'takenOver' || lease.status === 'refused') && idle < RETAKE_AFTER_IDLE_MS && !added) return null;
    return this.take();
  }

  take() {
    const lease = this.lease, client = this.bus.client;
    lease.status = 'taking'; lease.again = false;
    lease.taking = client.lease({group: LEASE_GROUP, publish: lease.keys, subscribe: [], allowTakeover: true, timeoutMs: LEASE_TIMEOUT_MS}).then(handle => {
      lease.handle = handle; lease.status = 'held'; lease.reason = null;
      handle.onLost(reason => {
        if (lease.handle !== handle || reason === 'renewed' || reason === 'released') return;
        const taken = reason === 'takenOver' || reason.startsWith('force-expired');
        lease.handle = null; lease.status = taken ? 'takenOver' : 'off'; lease.reason = reason;
        if (taken && this.armed) this.app.toast('Another app took over the robot\'s controls. Your next press takes them back.', 'warn', 6);
        this.emit();
      });
    }).catch(error => { lease.status = 'refused'; lease.reason = error.message; })
      .finally(() => { lease.taking = null; this.emit(); if (lease.again && this.armed) this.take(); });
    this.emit();
    return lease.taking;
  }

  releaseLease() {
    const lease = this.lease, handle = lease.handle;
    lease.handle = null; lease.status = 'off'; lease.reason = null; lease.keys = []; lease.again = false;
    handle?.release?.().catch(() => {});
  }

  // Why commands are not reaching the robot right now, or null.
  get blocked() {
    if (this.motionSpeeds.provider && !this.motionSpeeds.ready) return this.motionSpeeds.error || 'Reading shared speed settings…';
    const lease = this.lease;
    if (lease.status === 'takenOver') return 'Another app is driving. Your next press takes the controls back.';
    if (lease.status === 'refused') return `The gateway refused this page the controls: ${lease.reason}`;
    const publisher = this.publishers.get(this.driveKey)?.publisher;
    if (lease.status !== 'taking' && publisher?.blocked) return /leased by another client/.test(publisher.blocked) ? `Another app holds ${this.drive?.topic} (${/group "([^"]+)"/.exec(publisher.blocked)?.[1] || 'unknown'}).` : String(publisher.blocked);
    return null;
  }

  // -- publishing -----------------------------------------------------------------------------------
  entry(target) {
    const id = target.publisherKey || target.key;
    let entry = this.publishers.get(id);
    if (entry && ['closed', 'tripped', 'rejected'].includes(entry.publisher.state)) { entry.publisher.close(); this.publishers.delete(id); entry = null; }
    if (!entry) { entry = {publisher: this.bus.publisher(target.key, target.options || {delivery: DRIVE.includes(target.type) ? 'latest' : 'reliable'}), deadman: false}; this.publishers.set(id, entry); }
    return entry;
  }

  publish(target, bytes) {
    if (!bytes || !this.bus.live) return false;
    const entry = this.entry(target), put = () => { try { entry.publisher.put(bytes); } catch (error) { console.warn(`publish ${target.topic}:`, error.message); } };
    const taking = this.claim(target.key);
    // Live tracking never waits in a promise and replays old poses after a lease/reconnect.
    if (target.live) {
      if (!this.armed || taking || this.lease.status !== 'held' || entry.publisher.state !== 'open' || entry.publisher.blocked ||
          entry.publisher.channel?.readyState !== 'open' || entry.publisher.channel.bufferedAmount > 16384) return false;
      put(); return true;
    }
    // A stream of velocity commands goes out at once (the next one is 66 ms away); a single command waits for the lease.
    if (taking && !DRIVE.includes(target.type)) taking.then(put); else put();
    return true;
  }

  encode(type, value) { try { return this.bus.type(type)?.encode(value) ?? null; } catch (error) { console.warn(`encode ${type}:`, error.message); return null; } }

  twist(target, [vx, vy, wz]) {
    const twist = {linear: {x: vx, y: vy, z: 0}, angular: {x: 0, y: 0, z: wz}};
    return this.encode(target.type, target.type.endsWith('Stamped') ? {header: header(''), twist} : twist);
  }

  // -- driving --------------------------------------------------------------------------------------
  get drive() { return this.drives.find(target => target.key === this.driveKey) || null; }

  // Pad, keys and sticks each hold an input (forward, left, turn-left; each -1..1). The largest wins per axis.
  setInput(source, forward, left, turn) {
    if (!this.armed) return;
    if (this.xr.ownsInputs) forward = left = turn = 0;
    const input = this.inputs[source];
    if (input[0] === forward && input[1] === left && input[2] === turn) return;
    input[0] = forward; input[1] = left; input[2] = turn; this.emit();
  }

  key(event, down) {
    if (!this.armed || this.app.text.active || event.metaKey || event.ctrlKey) return;
    const code = event.code;
    if (!['KeyW', 'KeyS', 'KeyA', 'KeyD', 'KeyQ', 'KeyE', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(code)) return;
    event.preventDefault();
    if (code === 'Space') { if (down) this.stop(); return; }
    if (down) this.held.add(code); else this.held.delete(code);
    this.keys();
  }

  keys() {
    const on = (...codes) => codes.some(code => this.held.has(code)) ? 1 : 0;
    this.setInput('keys', on('KeyW', 'ArrowUp') - on('KeyS', 'ArrowDown'), on('KeyQ') - on('KeyE'), on('KeyA', 'ArrowLeft') - on('KeyD', 'ArrowRight'));
  }

  // Headset sticks: left stick moves, right stick turns. Returns whether the sticks are taken (armed with a drive).
  sticks(left, right) {
    if (this.xr.ownsInputs) { this.setInput('sticks', 0, 0, 0); return true; }
    if (!this.armed || !this.drive) return false;
    this.setInput('sticks', -left[1], -left[0], -right[0]);
    return true;
  }

  send(command) {
    const target = this.drive;
    if (!target) return;
    if (this.motionSpeeds.provider && !this.motionSpeeds.ready) command = [0, 0, 0];
    this.publish(target, this.twist(target, [command[0] * this.speed.linear, command[1] * this.speed.linear, command[2] * this.speed.angular]));
  }

  tick(now) {
    if (now - this.lastSent < PERIOD) return;
    this.tickNumbers(now);
    const pick = axis => Object.values(this.inputs).reduce((best, input) => Math.abs(input[axis]) > Math.abs(best) ? input[axis] : best, 0);
    const command = this.armed ? [pick(0), pick(1), pick(2)] : [0, 0, 0], active = command.some(value => value !== 0);
    if (!active && !this.moving) { if (this.heldNumbers.size || this.zeroing.length) this.lastSent = now; return; }
    this.lastSent = now;
    const target = this.drive;
    if (!target) return;
    if (active) {
      const entry = this.entry(target);
      if (!entry.deadman) {
        // The first input arms the deadman: a stop the gateway sends for us if this page stops answering.
        entry.deadman = true;
        Promise.resolve().then(() => entry.publisher.setDeadman(this.twist(target, [0, 0, 0]))).catch(error => { entry.deadman = false; console.warn('deadman:', error.message); });
      }
      this.moving = true; this.zeros = 0;
    } else if (++this.zeros >= 3) this.moving = false;   // a stop is sent three times, then silence
    this.command = command; this.send(command);
    this.dispatchEvent(new Event('drive'));
  }

  // -- set points -----------------------------------------------------------------------------------
  range(target) { return this.ranges[target.key] || (target.type === 'std_msgs.Float32' ? [0, 1] : [0, 10]); }
  setRange(target, low, high) { if (Number.isFinite(low) && Number.isFinite(high) && high > low) { this.ranges[target.key] = [low, high]; this.save('spatial.ranges', this.ranges); this.emit(); } }

  setNumber(target, value) {
    if (!this.armed) return;
    const whole = target.type !== 'std_msgs.Float32', data = whole ? Math.round(value) : value;
    this.values.set(target.key, data);
    const now = performance.now();
    // A drag publishes at most ten times a second; the value at release is always sent (see release()).
    if (now - (target.sentAt || 0) < 100) { target.unsent = true; return; }
    target.sentAt = now; target.unsent = false;
    this.publish(target, this.encode(target.type, {data}));
  }

  // A number can be a set point (sent when it changes) or a rate (in effect only while it keeps arriving, like a
  // velocity). The type does not say which; the user does, or an agent that read the handler (panels/control.js).
  mode(target) { return this.modes[target.key] || {}; }
  setMode(target, values) { this.modes[target.key] = {...this.mode(target), ...values}; this.save('spatial.modes', this.modes); this.emit(); }

  // A rate: sent at the drive's pace for as long as the slider is held, then zero three times.
  holdNumber(target, value) {
    if (!this.armed) return;
    const entry = this.entry(target);
    // As for a drive: the gateway sends the zero itself if this page goes away while the slider is held.
    if (!entry.deadman) { entry.deadman = true; Promise.resolve().then(() => entry.publisher.setDeadman(this.encode(target.type, {data: 0}))).catch(error => { entry.deadman = false; console.warn('deadman:', error.message); }); }
    this.heldNumbers.set(target.key, {target, value}); this.values.set(target.key, value);
  }
  releaseNumber(target) {
    if (!this.heldNumbers.delete(target.key)) return;
    this.values.set(target.key, 0); this.zeroing.push({target, left: 3}); this.emit();
  }

  tickNumbers() {
    const send = (target, value) => this.publish(target, this.encode(target.type, {data: target.type === 'std_msgs.Float32' ? value : Math.round(value)}));
    for (const {target, value} of this.heldNumbers.values()) send(target, value);
    for (const entry of this.zeroing) { send(entry.target, 0); entry.left--; }
    this.zeroing = this.zeroing.filter(entry => entry.left > 0);
  }

  release(target) { if (target.unsent && this.armed) { target.unsent = false; this.publish(target, this.encode(target.type, {data: this.values.get(target.key)})); } }

  setSwitch(target, on) { if (!this.armed) return; this.values.set(target.key, on); this.publish(target, this.encode(target.type, {data: on})); this.emit(); }

  // -- goals: the next press on the table is where the pose goes --------------------------------------
  aim(target) { this.aiming = this.aiming === target || !this.armed ? null : target; this.emit(); }

  // point: in the fixed frame. Returns whether a goal was waiting for it.
  place(point) {
    const target = this.aiming;
    if (!target || !this.armed) return false;
    this.aiming = null;
    const frame = this.app.layers.tf.root || 'world', position = {x: point.x, y: point.y, z: point.z};
    const value = target.type === 'geometry_msgs.PointStamped' ? {header: header(frame), point: position} : {header: header(frame), pose: {position, orientation: {x: 0, y: 0, z: 0, w: 1}}};
    const sent = this.publish(target, this.encode(target.type, value));
    this.app.toast(sent ? `${target.topic} ← (${point.x.toFixed(2)}, ${point.y.toFixed(2)}) in ${frame}` : `Could not send to ${target.topic}`, sent ? 'ok' : 'danger');
    this.emit();
    return true;
  }

  // -- joints ---------------------------------------------------------------------------------------
  // The joints and where they are now, from the first JointState stream a module publishes.
  watchJoints(on) {
    if (!on) { this.jointSubscription?.close?.(); this.jointSubscription = null; return; }
    const source = this.states?.[0];
    if (this.jointSubscription || !source) return;
    this.jointSubscription = this.bus.subscribeDecoded(source.key, {delivery: 'latest', maxHz: 8}, message => {
      this.jointState = {names: message.name || [], positions: Array.from(message.position || []), at: performance.now(), topic: source.topic};
      this.dispatchEvent(new Event('joints'));
    });
  }

  // Sends one joint to a position. At most ten a second while a slider moves; the last value always goes out.
  jog(target, name, position) {
    if (!this.armed) return;
    target.want = {name, position};
    if (target.timer || target.calling) return;
    const flush = () => {
      target.timer = null;
      const want = target.want; target.want = null;
      if (!want || !this.armed) return;
      if (target.kind === 'rpc') {
        target.calling = true;
        gateway.callRpc(target.module.id, target.rpc.name, {[target.nameParam]: want.name, [target.valueParam]: want.position})
          .then(answer => { if (answer.ok) delete target.refused?.[want.name]; else this.refuse(target, want.name, answer.error); })
          .catch(error => this.refuse(target, want.name, error.message))
          .finally(() => { target.calling = false; if (target.want) target.timer = setTimeout(flush, 100); });
      } else {
        this.publish(target, this.encode('sensor_msgs.JointState', {header: header(''), name_length: 1, position_length: 1, velocity_length: 0, effort_length: 0, name: [want.name], position: [want.position], velocity: [], effort: []}));
        target.timer = setTimeout(flush, 100);
      }
    };
    flush();
  }

  // The RPC said no for this joint (not one it moves, or out of its limits): say so once, and mark the joint.
  refuse(target, name, message) {
    target.refused ||= {};
    const first = !target.refused[name];
    target.refused[name] = String(message || 'refused').split('\n').pop();
    if (first) this.app.toast(`${target.rpc.name}(${name}): ${target.refused[name]}`, 'warn');
    this.dispatchEvent(new Event('joints'));
  }

  // -- status ---------------------------------------------------------------------------------------
  // What the modules say about themselves (their status() RPCs), read while someone is looking.
  watchStatus(on) {
    if (!on) { clearInterval(this.statusTimer); this.statusTimer = null; return; }
    if (this.statusTimer) return;
    const read = async () => {
      await this.motionSpeeds.refresh();
      for (const entry of this.statuses.slice(0, 4)) {
        try { const answer = await gateway.callRpc(entry.module.id, entry.rpc.name, {}); entry.value = answer.ok ? answer.result : null; entry.error = answer.ok ? null : answer.error; }
        catch (error) { entry.error = error.message; }
      }
      this.dispatchEvent(new Event('status'));
    };
    this.statusTimer = setInterval(read, 1500); read();
  }
}
