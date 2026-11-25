import test from 'node:test';
import assert from 'node:assert/strict';
import {ArmHome, armHomeProvider} from '../frontend/src/data/arm-home.js';
import {gateway} from '../frontend/src/data/gateway.js';

const provider = {id: 'generic-coordinator', rpcs: ['home_arms', 'cancel_arm_home', 'get_arm_home_status'].map(name => ({name}))};
function setup(t) {
  const calls = [], controls = {armed: true, xr: {stop: reason => calls.push(reason)}, setInput() {}, emit() {}, app: {toast() {}}};
  t.mock.method(gateway, 'callRpc', async (_id, method) => { calls.push(method); return {ok: true, result: {state: method === 'cancel_arm_home' ? 'cancelled' : 'reached'}}; });
  const home = new ArmHome(controls); home.discover([provider]);
  t.after(() => clearTimeout(home.timer));
  return {home, calls, controls};
}
test('home is discovered by protocol without actuating; unarmed press cannot move', async t => {
  const {home, calls, controls} = setup(t);
  assert.equal(armHomeProvider([{...provider, rpcs: provider.rpcs.slice(1)}]), null);
  controls.armed = false; await home.start();
  assert.deepEqual(calls, []);
});
test('home stops tracking before requesting motion and never automatically enables it', async t => {
  const {home, calls} = setup(t);
  await home.start();
  assert.deepEqual(calls, ['returning_home', 'home_arms', 'get_arm_home_status']);
  assert.equal(home.active, false);
});
test('STOP racing a pending home request cancels again after its acknowledgement', async t => {
  const {home, calls} = setup(t);
  let finish;
  t.mock.method(gateway, 'callRpc', (_id, method) => {
    calls.push(method);
    return method === 'home_arms' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ok: true, result: {state: 'cancelled'}});
  });
  const starting = home.start();
  await home.cancel();
  finish({ok: true, result: {state: 'moving'}});
  await starting;
  assert.deepEqual(calls, ['returning_home', 'home_arms', 'cancel_arm_home', 'cancel_arm_home']);
  assert.equal(home.active, false);
});
test('home cannot move when it cannot acquire the existing headset command lease', async t => {
  const {home, calls, controls} = setup(t);
  controls.xr.binding = {pose: {key: 'pose'}, joy: {key: 'joy'}};
  controls.claim = async () => {}; controls.lease = {status: 'taken'};
  await home.start();
  assert(!calls.includes('home_arms'));
  assert.match(home.error, /acquire/);
});
