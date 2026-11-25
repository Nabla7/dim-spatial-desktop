import test from 'node:test';
import assert from 'node:assert/strict';
import {ArmCalibrationUI, inputIdentity, calibrationProvider} from '../frontend/src/data/arm-calibration.js';
import {gateway} from '../frontend/src/data/gateway.js';

const methods = ['get_arm_calibration', 'begin_arm_calibration', 'capture_arm_calibration', 'save_arm_calibration',
  'activate_arm_calibration', 'cancel_arm_calibration', 'delete_arm_calibration'];
const provider = {id: 'generic-input', rpcs: methods.map(name => ({name, params: []}))};
const controllerSession = {inputSources: ['left', 'right'].map(handedness => ({handedness, targetRayMode: 'tracked-pointer', gamepad: {}, profiles: ['generic-trigger-squeeze']}))};

function setup(t) {
  const calls = [], status = {version: 2, profiles: [], profile_id: null, session: 'server-session'};
  t.mock.method(gateway, 'callRpc', async (id, method, args) => { calls.push({id, method, args}); return {ok: true, result: status}; });
  const controls = {armed: true, bus: {live: true}, lease: {status: 'held'}, app: {xr: {presenting: true, session: controllerSession}},
    emit() {}, claim: async () => {}};
  const xr = {controls, binding: {pose: {key: 'poses'}, joy: {key: 'buttons'}}, enabled: false, calibrating: false,
    stop() { this.enabled = this.calibrating = false; }, async start({calibrating} = {}) { this.enabled = true; this.calibrating = !!calibrating; }};
  const c = new ArmCalibrationUI(xr); c.discover(provider);
  return {c, xr, controls, calls, status};
}

test('calibration is discovered by protocol and input identity is independent of headset brand', () => {
  assert.equal(calibrationProvider(provider), provider);
  assert.equal(calibrationProvider({...provider, rpcs: provider.rpcs.slice(1)}), null);
  assert.deepEqual(inputIdentity(controllerSession), {input_kind: 'controllers', device: 'generic-trigger-squeeze'});
  assert.deepEqual(inputIdentity({inputSources: [{handedness: 'left', hand: {}}]}), {input_kind: 'hands', device: 'tracked-hand'});
});

test('reading calibration never activates it; an incompatible input profile is refused', async t => {
  const {c, calls, status} = setup(t);
  status.profiles = [{id: 'saved', schema_version: 2, input_kind: 'hands', device: 'tracked-hand'}]; status.profile_id = 'saved';
  await c.refresh();
  assert.deepEqual(calls.map(c => c.method), ['get_arm_calibration']);
  await assert.rejects(c.activate(), /Choose a calibration/);
  assert(!calls.some(c => c.method === 'activate_arm_calibration'));
});

test('calibration cannot hold another operator robot without a control lease', async t => {
  const {c, controls, calls} = setup(t);
  controls.lease.status = 'takenOver';
  await c.begin();
  assert.equal(calls.length, 0);
  assert.match(c.error, /acquire/);
});

test('entering XR waits for both tracked inputs before choosing a calibration source', async t => {
  const {c, controls, calls} = setup(t);
  controls.app.xr.session = {inputSources: []};
  await c.begin();
  assert.equal(calls.length, 0);
  assert.match(c.error, /both tracked/);
  controls.app.xr.session = {inputSources: controllerSession.inputSources.slice(0, 1)};
  assert.equal(c.inputsReady, false);
  controls.app.xr.session = controllerSession;
  assert.equal(c.inputsReady, true);
});

test('begin holds before tracking starts and delayed capture is canceled on loss of ownership', async t => {
  const {c, xr, controls, calls} = setup(t);
  await c.begin();
  assert.equal(calls[0].method, 'begin_arm_calibration');
  assert.equal(xr.calibrating, true);
  c.capture('neutral', 0); c.frame(2999);
  assert.equal(calls.length, 1);
  controls.lease.status = 'lost'; c.frame(3001);
  assert.equal(c.countdown, null);
  assert.equal(calls.length, 1);
});

test('a capture countdown submits once with its session; save stops input without activation', async t => {
  const {c, xr, calls, status} = setup(t);
  await c.begin();
  c.capture('left_reach', 0); c.frame(3001); c.frame(4001);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.filter(c => c.method === 'capture_arm_calibration').length, 1);
  assert.equal(calls.at(-1).args.session, c.session);
  status.profile_id = 'saved'; await c.save();
  assert.equal(xr.enabled, false);
  assert.equal(c.selected, 'saved');
  assert(!calls.some(c => c.method === 'activate_arm_calibration'));
});

test('a delayed response from a previous robot cannot replace current calibration', async t => {
  const {c} = setup(t);
  let finish;
  t.mock.method(gateway, 'callRpc', () => new Promise(resolve => { finish = resolve; }));
  const reading = c.refresh();
  c.discover({...provider, id: 'second-robot'});
  finish({ok: true, result: {version: 2, profiles: [{id: 'wrong'}]}});
  await reading;
  assert.equal(c.status, null);
});

test('status polling preserves capture rejection messages and reviews the selected profile', async t => {
  const {c, status, calls} = setup(t);
  c.error = 'left: Hold still'; c.selected = 'saved'; status.profiles = [{id: 'saved'}];
  await c.refresh();
  assert.equal(c.error, 'left: Hold still');
  assert.deepEqual(calls.at(-1).args, {profile_id: 'saved'});
});


test('canceling startup during calibration refresh cannot later activate the robot', async t => {
  const {c, status} = setup(t); let finish; let current = true;
  status.profiles = [{id: 'saved', schema_version: 2, input_kind: 'controllers', device: 'generic-trigger-squeeze'}];
  status.profile_id = 'saved';
  gateway.callRpc.mock.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const activating = c.activate(() => current);
  current = false; finish({ok: true, result: status});
  await assert.rejects(activating, /startup canceled/);
  assert.deepEqual(gateway.callRpc.mock.calls.map(call => call.arguments[1]), ['get_arm_calibration']);
});
