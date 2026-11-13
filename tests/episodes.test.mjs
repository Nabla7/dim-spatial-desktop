import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Episodes, findEpisodes, readStatus} from '../frontend/src/data/episodes.js';
import {launchAsks, launchConfig, missing, stamp} from '../frontend/src/data/launch.js';
import {gateway} from '../frontend/src/data/gateway.js';

// What the dimos gateway answered for a blueprint that records (r1pro-openarm-joylo-collect), cut down.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/collection.json', import.meta.url), 'utf8'));

test('the episode control is found by the Spec it answers, and the recorder by the stream it reads', () => {
  const found = findEpisodes(fixture.modules);
  assert.equal(found.control.name, 'episodes');
  assert.equal(found.parameter, 'event');
  assert.equal(found.status.topic, '/status');
  assert.deepEqual(found.recorders.map(recorder => recorder.module.name), ['recorder']);
  const inputs = found.recorders[0].inputs.map(stream => stream.name);
  assert.ok(inputs.includes('left_wrist') && inputs.includes('coordinator_joint_command'));
  assert.ok(!inputs.includes('status'));
});

test('a module that reads the episode events and also writes streams is not a recorder', () => {
  // As the teleop modules of the collection blueprints are: they show the state in the operator's headset.
  const headset = {name: 'armteleopmodule', rpcs: [], streams: [
    {name: 'status', type: 'dimos.msgs.std_msgs.String.String', direction: 'in', topic: '/status'},
    {name: 'teleop_buttons', type: 'dimos.teleop.webxr.controller_types.Buttons', direction: 'out', topic: '/teleop_buttons'},
  ]};
  assert.deepEqual(findEpisodes([...fixture.modules, headset]).recorders.map(recorder => recorder.module.name), ['recorder']);
});

test('a blueprint without that Spec has no episodes', () => {
  assert.equal(findEpisodes(fixture.modules.filter(module => module.name !== 'episodes')), null);
  // The same method names with another answer are not it.
  const other = [{name: 'thing', rpcs: [{name: 'get_status', params: [], return_type: 'dict'}, {name: 'command', params: [{name: 'event', required: true}], return_type: 'dict'}], streams: []}];
  assert.equal(findEpisodes(other), null);
});

test('a status is read from the stream\'s JSON and from an RPC\'s answer', () => {
  const json = '{"schema_version": 1, "ts": 12.5, "state": "recording", "episodes_saved": 2, "episodes_discarded": 1, "last_event": "start", "task_label": "Pick"}';
  assert.deepEqual(readStatus(json), {state: 'recording', saved: 2, discarded: 1, event: 'start', task: 'Pick', ts: 12.5});
  assert.deepEqual(readStatus(JSON.parse(json)), readStatus(json));
  assert.equal(readStatus('not a status'), null);
  assert.equal(readStatus({state: 'elsewhere'}), null);
});

function setup() {
  const blueprint = Object.assign(new EventTarget(), {modules: [], topics: new Map(), runId: 'run', ratesUp: true, module: () => null});
  const app = {blueprint, bus: Object.assign(new EventTarget(), {live: false}), toast() {}};
  return new Episodes(app);
}
const status = (state, saved, discarded, event, ts) => ({state, saved, discarded, event, task: 'Pick', ts});

test('episodes that end while the page watches are listed with how long they ran', () => {
  const episodes = setup();
  episodes.take(status('idle', 0, 0, 'init', 100), false);
  episodes.take(status('recording', 0, 0, 'start', 110), true);
  assert.ok(episodes.recording && episodes.elapsed() !== null);
  episodes.take(status('idle', 1, 0, 'save', 122.5), true);
  episodes.take(status('recording', 1, 0, 'start', 130), true);
  episodes.take(status('idle', 1, 1, 'discard', 133), true);
  assert.deepEqual(episodes.log, [{number: 2, result: 'discarded', seconds: 3}, {number: 1, result: 'saved', seconds: 12.5}]);
  assert.equal(episodes.elapsed(), null);
});

test('an episode that was already recording when the page came has no time', () => {
  const episodes = setup();
  episodes.take(status('recording', 3, 0, 'start', 500), false);
  assert.equal(episodes.elapsed(), null);
  episodes.take(status('idle', 4, 0, 'save', 520), true);
  assert.deepEqual(episodes.log, [{number: 4, result: 'saved', seconds: null}]);
});

test('a command is one RPC with the event, and does nothing without a control', async t => {
  const calls = [];
  t.mock.method(gateway, 'callRpc', async (id, name, kwargs) => { calls.push({id, name, kwargs}); return {ok: true, result: {state: 'recording', episodes_saved: 0, episodes_discarded: 0, last_event: 'start', task_label: 'Pick', ts: 1}}; });
  const episodes = setup();
  await episodes.command('start');
  assert.deepEqual(calls, []);
  episodes.app.blueprint.modules = [{id: 'episodes', name: 'EpisodeMonitorModule', rpcs: fixture.modules.find(module => module.name === 'episodes').rpcs.map(rpc => ({...rpc, returns: rpc.return_type})), streams: []}];
  episodes.discover();
  assert.deepEqual(calls, []);   // finding the control calls nothing
  await episodes.command('start');
  assert.deepEqual(calls, [{id: 'episodes', name: 'command', kwargs: {event: 'start'}}]);
  assert.ok(episodes.recording);
});

test('a launch is told what the blueprint requires and does not give', () => {
  const asks = launchAsks(fixture.config, fixture.modules);
  assert.deepEqual(asks.map(ask => [ask.key, ask.required, ask.role]), [['episodes.task', true, 'task'], ['recorder.recording', true, 'folder']]);
  assert.deepEqual(missing(asks, {'episodes.task': 'Pick the cup'}).map(ask => ask.key), ['recorder.recording']);
  assert.deepEqual(launchConfig(asks, {'episodes.task': ' Pick the cup ', 'recorder.recording': '/data/r1-20261113-101500'}),
    {modules: {episodes: {task: 'Pick the cup'}, recorder: {recording: '/data/r1-20261113-101500'}}});
  assert.equal(launchConfig(asks, {}), undefined);
});

test('what the blueprint gives itself is asked for as a choice, not a need', () => {
  const config = structuredClone(fixture.config);
  config.modules.episodes.args.task.value = 'Teleoperate';
  config.modules.recorder.args.recording.value = '/data/session';
  const asks = launchAsks(config, fixture.modules);
  assert.deepEqual(asks.map(ask => [ask.key, ask.required, ask.was]), [['episodes.task', false, 'Teleoperate'], ['recorder.recording', false, '/data/session']]);
  assert.deepEqual(missing(asks, {}), []);
});

test('a folder name carries a time that sorts', () => {
  assert.equal(stamp(new Date(2026, 10, 13, 9, 5, 7)), '20261113-090507');
});
