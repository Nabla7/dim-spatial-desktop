import test from 'node:test';
import assert from 'node:assert/strict';
import {rankDriveTargets} from '../frontend/src/data/drive-routing.js';
import {Controls} from '../frontend/src/data/controls.js';

const stream = (key, direction, type = 'geometry_msgs.Twist') => ({name: key, key, topic: `/${key}`, direction, type});
const module = (name, streams) => ({id: name, name, streams, rpcs: []});
// Arbitrary keys deliberately put the hardware input first alphabetically. The adapter's writer
// is absent from discovery, as with transport adapters in older coordinators.
const modules = [
  module('Driver', [stream('a-wheels', 'in')]),
  module('Controller', [stream('coordinated', 'in')]),
  module('Mux', [stream('z-operator', 'in'), stream('navigation', 'in'), stream('coordinated', 'out')]),
  module('Planner', [stream('navigation', 'out')]),
];

function setup(t, source = modules) {
  const previous = {document: globalThis.document, addEventListener: globalThis.addEventListener};
  const document = Object.assign(new EventTarget(), {visibilityState: 'visible'}), window = new EventTarget();
  globalThis.document = document; globalThis.addEventListener = window.addEventListener.bind(window);
  t.after(() => { for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete globalThis[name]; else globalThis[name] = value;
  } });
  const sent = [], blueprint = Object.assign(new EventTarget(), {modules: source, running: true});
  const app = {blueprint, xr: {presenting: false}, toast() {}, bus: {
    live: true, client: {}, type: () => ({encode: value => value}),
    publisher: key => ({state: 'open', put: value => sent.push({key, value}), close() {},
      setDeadman: async () => {}, clearDeadman: async () => {}}),
  }};
  return {controls: new Controls(app), app, sent, document};
}

test('fresh page chooses the unwritten operator input upstream of the controller', t => {
  const {controls, sent} = setup(t);
  assert.equal(controls.driveKey, 'z-operator');
  assert.deepEqual(sent, []); // discovery never commands the robot
  controls.arm(true); controls.setInput('pad', 1, 0, 0); controls.tick(1000);
  assert.equal(sent[0].key, 'z-operator');
  assert.equal(sent[0].value.linear.x, 0.3);
});

test('single direct driver still works and discovery preserves an explicit choice', t => {
  const {controls, app} = setup(t, [modules[0]]);
  assert.equal(controls.driveKey, 'a-wheels');
  app.blueprint.modules = modules; controls.discover();
  assert.equal(controls.driveKey, 'a-wheels');
  controls.selectDrive('z-operator'); controls.discover();
  assert.equal(controls.driveKey, 'z-operator');
});

test('route ranking follows remapped stamped and unstamped command streams and terminates on cycles', () => {
  const targets = ['hardware', 'operator', 'middle'].map(key => ({key, writers: key === 'middle' ? ['mux'] : []}));
  const graph = [
    module('relay', [stream('operator', 'in', 'geometry_msgs.TwistStamped'), stream('middle', 'out')]),
    module('cycle', [stream('middle', 'in'), stream('operator', 'out')]),
  ];
  assert.equal(rankDriveTargets(targets, graph)[0].key, 'operator');
  assert.deepEqual(rankDriveTargets([], graph), []);
});

test('changing target stops the previous route and requires arming with a fresh input', t => {
  const {controls, sent} = setup(t);
  controls.arm(true); controls.setInput('pad', 1, 0, 0); controls.tick(1000);
  controls.selectDrive('a-wheels'); controls.tick(2000);
  assert.equal(controls.armed, false);
  assert.deepEqual(sent.map(s => [s.key, s.value.linear.x]), [['z-operator', 0.3], ['z-operator', 0]]);
  controls.arm(true); controls.tick(3000);
  assert.equal(sent.length, 2);
});

test('hiding a desktop page stops held inputs, releases ownership, and never resumes on return', async t => {
  const {controls, document, sent} = setup(t);
  let releases = 0;
  controls.lease = {...controls.lease, status: 'held', handle: {release: async () => { releases++; }}};
  controls.arm(true); controls.held.add('KeyW'); controls.setInput('pad', 1, 0, 0); controls.tick(1000);
  await Promise.resolve();
  document.visibilityState = 'hidden'; document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(controls.armed, false); assert.equal(releases, 1);
  assert.equal(controls.held.size, 0);
  assert(Object.values(controls.inputs).every(v => v.every(x => x === 0)));
  assert.equal(sent.at(-1).value.linear.x, 0);
  const count = sent.length;
  document.visibilityState = 'visible'; document.dispatchEvent(new Event('visibilitychange')); controls.tick(2000);
  assert.equal(controls.armed, false); assert.equal(sent.length, count);
});

test('an immersive session keeps its own visibility lifecycle', t => {
  const {controls, app, document} = setup(t);
  app.xr.presenting = true; controls.arm(true);
  document.visibilityState = 'hidden'; document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(controls.armed, true);
});

test('a lease granted after leaving the page is released, not held by the hidden tab', async t => {
  const {controls, app, document} = setup(t);
  let grant, releases = 0;
  app.bus.client.lease = () => new Promise(resolve => { grant = resolve; });
  controls.arm(true);
  const taking = controls.claim('z-operator');
  document.visibilityState = 'hidden'; document.dispatchEvent(new Event('visibilitychange'));
  grant({release: async () => { releases++; }, onLost() { assert.fail('must not adopt the late lease'); }});
  await taking;
  assert.equal(releases, 1); assert.equal(controls.lease.status, 'off');
  assert.equal(controls.lease.handle, null);
});
