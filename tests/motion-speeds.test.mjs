import test from 'node:test';
import assert from 'node:assert/strict';
import {MotionSpeeds} from '../frontend/src/data/motion-speeds.js';
import {gateway} from '../frontend/src/data/gateway.js';

const provider = {id: 'robot', rpcs: [{name: 'get_motion_speeds', params: []}, {name: 'set_motion_speeds', params: []}], streams: [{name: 'speed_input', key: 'speed-topic'}]};
const metadata = () => ({settings: {
  travel: {value: 0.3, min: 0, max: 0.5, port: 'speed_input'},
  rotation: {value: 0.6, min: 0, max: 2},
}, drive: {linear: 'travel', angular: 'rotation'}});
function setup() {
  const controls = {armed: false, speed: {linear: 9, angular: 9}, emit() {}, app: {toast() {}}};
  const speeds = new MotionSpeeds(controls);
  speeds.discover([provider]);
  return {controls, speeds};
}

test('opening reads the robot speed without changing it; a press updates shared and browser speed', async t => {
  const calls = [];
  t.mock.method(gateway, 'callRpc', async (id, name, kwargs) => {
    calls.push({id, name, kwargs});
    return {ok: true, result: name === 'get_motion_speeds' ? metadata() : kwargs};
  });
  const {controls, speeds} = setup();
  assert.deepEqual(calls, []);
  await speeds.refresh();
  assert.deepEqual(controls.speed, {linear: 0.3, angular: 0.6});
  assert.deepEqual([...speeds.keys], ['speed-topic']);
  speeds.set('travel', 0.4);
  assert.equal(calls.length, 1); // unarmed
  controls.armed = true;
  await speeds.set('travel', 0.4);
  assert.deepEqual(calls[1], {id: 'robot', name: 'set_motion_speeds', kwargs: {travel: 0.4}});
  assert.equal(controls.speed.linear, 0.4);
  await speeds.set('travel', 0.8);
  assert.equal(calls.length, 2); // outside the robot's bound
});

test('a rejected setting never increases browser speed', async t => {
  t.mock.method(gateway, 'callRpc', async (id, name) => name === 'get_motion_speeds'
    ? {ok: true, result: metadata()} : {ok: false, error: 'controller unavailable'});
  const {controls, speeds} = setup();
  await speeds.refresh(); controls.armed = true;
  await speeds.set('travel', 0.5);
  assert.equal(controls.speed.linear, 0.3);
  assert.equal(speeds.error, 'controller unavailable');
});

test('slider writes are serialized and the final drag value reaches the robot', async t => {
  let release;
  const sent = [];
  t.mock.method(gateway, 'callRpc', async (id, name, kwargs) => {
    if (name === 'get_motion_speeds') return {ok: true, result: metadata()};
    sent.push(kwargs);
    if (sent.length === 1) await new Promise(resolve => { release = resolve; });
    return {ok: true, result: kwargs};
  });
  const {controls, speeds} = setup();
  await speeds.refresh(); controls.armed = true;
  const writing = speeds.set('travel', 0.35);
  speeds.set('travel', 0.4); speeds.set('travel', 0.45);
  assert.equal(controls.speed.linear, 0.3); // not acknowledged yet
  release(); await writing;
  assert.deepEqual(sent, [{travel: 0.35}, {travel: 0.45}]);
  assert.equal(controls.speed.linear, 0.45);
});

test('a delayed read cannot undo a newer acknowledged write or a new run', async t => {
  let release;
  t.mock.method(gateway, 'callRpc', async (id, name, kwargs) => name === 'get_motion_speeds'
    ? {ok: true, result: metadata()} : {ok: true, result: kwargs});
  const {controls, speeds} = setup();
  await speeds.refresh(); controls.armed = true;
  gateway.callRpc.mock.mockImplementation(async (id, name, kwargs) => {
    if (name === 'get_motion_speeds') { await new Promise(resolve => { release = resolve; }); return {ok: true, result: metadata()}; }
    return {ok: true, result: kwargs};
  });
  const reading = speeds.refresh();
  await speeds.set('travel', 0.45);
  release(); await reading;
  assert.equal(controls.speed.linear, 0.45);
  const oldReading = speeds.refresh();
  speeds.discover([{...provider, id: 'new-run'}]);
  release(); await oldReading;
  assert.equal(speeds.ready, false);
});
