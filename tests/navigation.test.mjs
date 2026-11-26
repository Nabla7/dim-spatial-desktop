import test from 'node:test';
import assert from 'node:assert/strict';
import {Controls} from '../frontend/src/data/controls.js';
import {navigationFrame} from '../frontend/src/data/navigation.js';

const stream = (name, topic, type = 'geometry_msgs.PointStamped', direction = 'in') => ({name, topic, key: topic, type, direction});
function setup(t) {
  const previous = {document: globalThis.document, addEventListener: globalThis.addEventListener};
  globalThis.document = new EventTarget(); globalThis.addEventListener = () => {};
  t.after(() => { for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
  } });
  const sent = [], notices = [], modules = [{id: 'nav', name: 'Navigator', rpcs: [], streams: [
    stream('clicked_point', '/operator/destination'), stream('goal', '/planner/target', 'geometry_msgs.PoseStamped'),
    stream('goal', '/planner/target', 'geometry_msgs.PoseStamped', 'out'),
    stream('pose', '/arm/goal', 'geometry_msgs.PoseStamped'), stream('odom', '/odom', 'geometry_msgs.PoseStamped'),
  ]}];
  const app = {blueprint: Object.assign(new EventTarget(), {modules, running: true}),
    layers: {tf: {root: 'office'}, layers: new Map()}, toast: (...args) => notices.push(args),
    bus: {live: true, client: {}, type: () => ({encode: value => value}),
      publisher: key => ({state: 'open', put: value => sent.push({key, value}), close() {}})}};
  const controls = new Controls(app);
  return {controls, app, sent, notices};
}
const point = {x: 2, y: -3, z: 0.2};
function click(controls, target = controls.goals[0]) { controls.aim(target); return controls.place(point); }

test('discovers remapped navigation ports, prefers operator click, excludes arm and state poses', t => {
  const {controls, sent} = setup(t);
  assert.deepEqual(controls.goals.map(g => g.key), ['/operator/destination', '/planner/target']);
  assert.deepEqual(sent, []);
  assert.equal(click(controls), false);
  controls.arm(true); click(controls);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].key, '/operator/destination');
  assert.equal(sent[0].value.header.frame_id, 'office');
  assert.deepEqual(sent[0].value.point, point);
  assert.equal(controls.place(point), false); // one click per explicit selection
});

test('pose goal gets map coordinates; no live goal from a replay or an unknown frame', t => {
  const {controls, app, sent} = setup(t); controls.arm(true);
  click(controls, controls.goals[1]); assert.deepEqual(sent[0].value.pose.position, point);
  app.replay = {active: true}; assert.equal(click(controls), false); app.replay.active = false;
  app.scenes = {active: true}; assert.equal(click(controls), false); app.scenes.active = false;
  app.layers.tf.root = ''; click(controls); assert.equal(sent.length, 1);
  assert.equal(navigationFrame({tf: {root: ''}, layers: new Map([['map', {visible: true, kind: 'cloud', frameId: 'local'}]])}), 'local');
});

test('waits for a lease and never replays a click after disarm, including rearming', async t => {
  const {controls, app, sent} = setup(t); let grant;
  app.bus.client.lease = () => new Promise(resolve => { grant = resolve; });
  controls.arm(true); click(controls); const taking = controls.lease.taking;
  assert.equal(sent.length, 0); controls.disarm(); controls.arm(true);
  grant({release: async () => {}, onLost() { assert.fail('stale lease'); }}); await taking;
  assert.equal(sent.length, 0);
});

test('refused lease never publishes a goal; success only reported after grant', async t => {
  const {controls, app, sent, notices} = setup(t);
  app.bus.client.lease = async () => { throw Error('refused'); };
  controls.arm(true); click(controls); await controls.lease.taking;
  assert.equal(sent.length, 0); assert.match(notices.at(-1)[0], /not sent/);
  controls.disarm(); controls.arm(true); let grant;
  app.bus.client.lease = () => new Promise(resolve => { grant = resolve; });
  click(controls); const taking = controls.lease.taking;
  assert.equal(sent.length, 0);
  grant({release: async () => {}, onLost() {}}); await taking;
  assert.equal(sent.length, 1); assert.match(notices.at(-1)[0], /Goal sent/);
});

test('STOP and frame changes invalidate a floor click waiting for its lease', async t => {
  const {controls, app, sent} = setup(t);
  for (const invalidate of [() => controls.stop(), () => { app.layers.tf.root = 'new-map'; }]) {
    let grant; app.bus.client.lease = () => new Promise(resolve => { grant = resolve; });
    controls.disarm(); controls.arm(true); click(controls); const taking = controls.lease.taking;
    invalidate(); grant({release: async () => {}, onLost() {}}); await taking;
    assert.equal(sent.length, 0);
  }
});
