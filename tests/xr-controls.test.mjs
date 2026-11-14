import test from 'node:test';
import assert from 'node:assert/strict';
import {XRControls, controllerSample, xrBinding} from '../frontend/src/data/xr-controls.js';
import {Controls} from '../frontend/src/data/controls.js';
import {gateway} from '../frontend/src/data/gateway.js';

const receiver = {id: 'operator-host:input', streams: [
  {name: 'webxr_pose', key: 'run/custom/poses', direction: 'in', type: 'geometry_msgs.PoseStamped'},
  {name: 'webxr_joy', key: 'run/custom/buttons', direction: 'in', type: 'sensor_msgs.Joy'},
], rpcs: []};
const selector = {id: 'robot-host:control', streams: [], rpcs: [{name: 'select_teleop_source', params: [{name: 'source', choices: ['leader', 'webxr']}]}]};
const pose = {transform: {position: {x: 0.2, y: 1.2, z: -0.5}, orientation: {x: 0, y: 0, z: 0, w: 1}}};
const input = side => ({handedness: side, gripSpace: {side}, gamepad: {mapping: 'xr-standard', axes: [0, 0, 0, 0], buttons: Array.from({length: 7}, () => ({value: 0, pressed: false}))}});
const grip = (input, value) => { input.gamepad.buttons[1] = {value, pressed: value > 0.5}; };

function setup(t) {
  const calls = [], sent = [], deadmen = [], entries = new Map();
  t.mock.method(gateway, 'callRpc', async (id, name, kwargs) => { calls.push({id, name, kwargs}); return {ok: true, result: {source: kwargs.source}}; });
  const c = {
    armed: false, bus: {live: true}, lease: {status: 'off'}, emit() {}, setInput() {},
    app: {xr: {presenting: true}, pointers: {sources: new Map(), cancelGrabs() {}}, toast() {}},
    claim: async () => { c.lease.status = 'held'; },
    entry(target) {
      if (!entries.has(target.publisherKey)) entries.set(target.publisherKey, {publisher: {
        ready: async () => {}, setDeadman: async message => deadmen.push(message),
      }});
      return entries.get(target.publisherKey);
    },
    encode: (type, value) => ({type, value}),
    publish(target, message) { if (!c.armed || !c.bus.live) return false; sent.push({target, ...message}); return true; },
  };
  const xr = new XRControls(c); c.xr = xr; xr.discover([receiver, selector]);
  const left = input('left'), right = input('right');
  const frame = {session: {inputSources: [left, right], visibilityState: 'visible'}, getPose: () => pose};
  let time = 0;
  return {c, xr, calls, sent, deadmen, entries, frame, left, right,
    tick() { xr.frame(frame, {}, time += 20); },
    joy(side) { return sent.filter(m => m.type === 'sensor_msgs.Joy' && m.value.header.frame_id === side).at(-1)?.value; },
    async start() { c.armed = true; await xr.start(); },
  };
}

test('discovers remapped WebXR inputs without choosing between independent robots', () => {
  assert.equal(xrBinding([receiver, selector]).pose.key, 'run/custom/poses');
  assert.equal(xrBinding([receiver, {...receiver, id: 'another'}, selector]), null);
  assert.equal(xrBinding([receiver, selector, {...selector, id: 'another-controller'}]), null);
});

test('opening and entering VR publish nothing; enabling requires an armed control panel', async t => {
  const s = setup(t); s.tick(); await s.xr.start();
  assert.deepEqual(s.calls, []); assert.deepEqual(s.sent, []);
  await s.start();
  assert.deepEqual(s.calls, [{id: selector.id, name: 'select_teleop_source', kwargs: {source: 'webxr'}}]);
  assert.equal(s.xr.enabled, true);
  assert.equal(s.entries.size, 4); // independent latest channels: neither hand overwrites the other
  assert.deepEqual(s.deadmen.map(m => m.value.header.frame_id), ['left', 'right']);
  assert(s.deadmen.every(m => m.value.axes.every(value => value === 0)));
});

test('publishes raw grip poses and the backend button layout only after a fresh release', async t => {
  const s = setup(t); grip(s.left, 1); await s.start(); s.tick();
  assert.equal(s.joy('left').axes[3], 0);
  grip(s.left, 0); s.tick(); grip(s.left, 1);
  s.left.gamepad.buttons[0] = {value: 0.7, pressed: true};
  s.left.gamepad.axes = [0, 0, 0.25, -0.5]; s.tick();
  assert.deepEqual(s.joy('left').axes, [0.25, -0.5, 0.7, 1]);
  assert.deepEqual(s.joy('left').buttons.slice(0, 2), [1, 1]);
  const position = s.sent.filter(m => m.type === 'geometry_msgs.PoseStamped').at(-2).value.pose;
  assert.deepEqual(position, pose.transform);
  grip(s.left, 0); s.tick(); assert.equal(s.joy('left').axes[3], 0);
});

test('tracking loss releases one hand, keeps the other live, and requires release on reacquisition', async t => {
  const s = setup(t); await s.start(); s.tick(); grip(s.left, 1); grip(s.right, 1); s.tick();
  s.frame.getPose = space => space.side === 'left' ? null : pose; s.tick();
  assert.equal(s.joy('left').axes[3], 0); assert.equal(s.joy('right').axes[3], 1);
  s.frame.getPose = () => pose; s.tick(); assert.equal(s.joy('left').axes[3], 0);
  grip(s.left, 0); s.tick(); grip(s.left, 1); s.tick(); assert.equal(s.joy('left').axes[3], 1);
});

test('pressing grip over a panel cannot start an arm; crossing UI during a held motion does not break it', async t => {
  const s = setup(t); await s.start(); s.tick();
  const pointer = {hit: {type: 'panel'}}; s.c.app.pointers.sources.set(s.left, pointer);
  grip(s.left, 1); s.tick(); assert.equal(s.joy('left').axes[3], 0);
  pointer.hit = null; s.tick(); assert.equal(s.joy('left').axes[3], 0);
  grip(s.left, 0); s.tick(); grip(s.left, 1); s.tick(); assert.equal(s.joy('left').axes[3], 1);
  pointer.hit = {type: 'panel'}; s.tick(); assert.equal(s.joy('left').axes[3], 1);
});

test('stop releases both hands and does not hand control back to a leader implicitly', async t => {
  const s = setup(t); await s.start(); s.tick(); grip(s.left, 1); grip(s.right, 1); s.tick();
  s.xr.stop();
  assert.equal(s.joy('left').axes[3], 0); assert.equal(s.joy('right').axes[3], 0);
  const count = s.sent.length; s.tick(); assert.equal(s.sent.length, count);
  assert.equal(s.calls.length, 1);
  await s.xr.selectSource('leader'); assert.equal(s.calls.at(-1).kwargs.source, 'leader');
});

test('losing visibility, the session, or the lease stops input and never automatically re-enables', async t => {
  for (const reason of ['visibility', 'session', 'lease', 'network']) {
    const s = setup(t); await s.start(); s.tick();
    if (reason === 'visibility') s.frame.session.visibilityState = 'visible-blurred';
    if (reason === 'lease') s.c.lease.status = 'takenOver';
    if (reason === 'network') s.c.bus.live = false;
    if (reason === 'session') s.xr.frame(null, {}, 40); else s.tick();
    assert.equal(s.xr.enabled, false, reason);
    s.c.bus.live = true; s.c.lease.status = 'held'; s.frame.session.visibilityState = 'visible'; s.tick();
    assert.equal(s.xr.enabled, false, reason);
  }
});

test('canceling while the source RPC is pending cannot enable movement afterwards', async t => {
  const s = setup(t); let finish;
  gateway.callRpc.mock.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const starting = s.start();
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  s.xr.stop(); s.c.armed = false; finish({ok: true, result: {source: 'webxr'}}); await starting;
  assert.equal(s.xr.enabled, false); assert.equal(s.xr.busy, false);
  const count = s.sent.length; s.tick(); assert.equal(s.sent.length, count);
});

test('a refused source switch leaves headset input off', async t => {
  const s = setup(t);
  gateway.callRpc.mock.mockImplementation(async () => ({ok: false, error: 'Unavailable'}));
  await s.start(); s.tick(); assert.equal(s.xr.enabled, false); assert.equal(s.xr.error, 'Unavailable');
  assert(s.sent.every(m => m.value.axes?.every(value => value === 0)));
});

test('invalid or emulated tracking is rejected rather than inventing a robot pose', () => {
  const left = input('left');
  assert.equal(controllerSample(left, null), null);
  assert.equal(controllerSample(left, {...pose, emulatedPosition: true}), null);
  assert.equal(controllerSample(left, {transform: {...pose.transform, position: {x: NaN, y: 0, z: 0}}}), null);
  assert.equal(controllerSample({...left, hand: {}}, pose), null);
});

test('live poses are dropped while acquiring a lease, with no deferred send after disarming', async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; }), sent = [];
  const c = {armed: true, bus: {live: true}, lease: {status: 'taking'}, claim: () => pending,
    entry: () => ({publisher: {state: 'open', channel: {readyState: 'open', bufferedAmount: 0}, put: bytes => sent.push(bytes)}})};
  const target = {key: 'poses', live: true};
  assert.equal(Controls.prototype.publish.call(c, target, 'old pose'), false);
  c.armed = false; c.lease.status = 'held'; resolve(); await pending;
  assert.deepEqual(sent, []);
  c.armed = true; c.claim = () => null;
  assert.equal(Controls.prototype.publish.call(c, target, 'fresh pose'), true);
  assert.deepEqual(sent, ['fresh pose']);
});
