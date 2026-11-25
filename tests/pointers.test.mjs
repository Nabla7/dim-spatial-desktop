import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';

// Use the same vendored Three as the browser's import map, without a renderer or an XR device.
const hook = registerHooks({resolve(specifier, context, next) {
  return next(specifier === 'three' ? new URL('../frontend/vendor/three/three.module.min.js', import.meta.url).href : specifier, context);
}});
const {Pointers} = await import('../frontend/src/input/pointers.js');
hook.deregister();

function setup() {
  const listeners = new Map(), state = {locked: false, clicks: 0, downs: 0, ups: 0};
  const element = {addEventListener() {}, style: {}}, renderer = {domElement: element, xr: {isPresenting: true}};
  const p = new Pointers({renderer, scene: {}, camera: {}, dock: {panels: []}, stage: {}, orbit: {}, text: {}});
  p.sceneInputLocked = () => state.locked; p.teleopOwnsInputs = () => true;
  const panel = {pointerDown() { state.downs++; }, pointerUp(id, x, y) { state.ups++; if (x !== null && y !== null) state.clicks++; }, pointerLeave() {}, pointerMove() {}};
  const hit = {type: 'panel', panel, x: 20, y: 30};
  const pointer = p.pointer('left', 'hand'); Object.assign(pointer, {handedness: 'left', active: true, input: {}});
  p.sources.set(pointer.input, pointer);
  p.sourcePointer = () => pointer;
  p.bindSession({addEventListener(name, callback) { listeners.set(name, callback); }}, {});
  return {p, pointer, hit, state, listeners};
}

test('engaged teleop blocks XR selection, panel grabbing and scene picking', () => {
  const {p, pointer, hit, state, listeners} = setup();
  state.locked = true; p.syncSceneLock();
  // Even a hit left from the prior frame cannot start a press.
  pointer.hit = hit; p.press(pointer); assert.equal(state.downs, 0); assert.equal(pointer.down, false);
  assert.equal(p.cast(pointer), null);
  for (const name of ['selectstart', 'selectend', 'squeezestart', 'squeezeend']) listeners.get(name)({inputSource: {}});
  assert.equal(state.clicks, 0); assert.equal(state.downs, 0); assert.equal(p.worldGrabs.size, 0);
});

test('engaging cancels an existing UI press without committing a click on release', () => {
  const {p, pointer, hit, state} = setup();
  pointer.hit = hit; p.press(pointer); assert.equal(state.downs, 1);
  state.locked = true; p.syncSceneLock();
  assert.equal(pointer.down, false); assert.equal(pointer.hit, null);
  assert.equal(state.ups, 1); assert.equal(state.clicks, 0);
  state.locked = false; pointer.hit = hit; p.release(pointer); assert.equal(state.clicks, 0);
});

test('JoyCon triggers stay with teleop and require release before returning to UI', () => {
  const {p, pointer, hit, state} = setup();
  p.cast = () => hit;
  const held = pressed => ({left: {select: pressed, squeeze: false}});
  p.padButtons(held(false));
  state.locked = true; p.syncSceneLock(); p.padButtons(held(true));
  p.padButtons(held(false)); p.padButtons(held(true)); assert.equal(state.downs, 0);
  state.locked = false; p.syncSceneLock(); p.padButtons(held(true)); p.padButtons(held(false));
  assert.equal(state.downs, 0); assert.equal(state.clicks, 0);
  p.padButtons(held(true)); p.padButtons(held(false)); assert.equal(state.clicks, 1);
  assert.equal(pointer.down, false);
});

test('XR floor navigation sends only on a completed primary click, never a grab, cancel, drag or lock', () => {
  const {p, pointer, state} = setup();
  let goals = 0, picking = true;
  p.stage.toRobot = point => point;
  p.wantsTablePoint = () => picking;
  p.offerTablePoint = () => { goals++; return true; };
  p.press(pointer); assert.equal(goals, 0); p.release(pointer); assert.equal(goals, 1);
  p.press(pointer); p.cancel(pointer); p.release(pointer); assert.equal(goals, 1);
  p.press(pointer); pointer.grip.x += 0.1; p.release(pointer); assert.equal(goals, 1);
  p.press(pointer); state.locked = true; p.release(pointer); assert.equal(goals, 1); state.locked = false;
  p.press(pointer); picking = false; p.release(pointer); assert.equal(goals, 1); picking = true;
  p.press(pointer, {grabOnly: true}); assert.equal(pointer.press.type, 'world'); p.cancel(pointer);
  assert.equal(goals, 1);
});

test('mouse floor navigation ignores drags, middle/right clicks and pointer cancellation', () => {
  const listeners = new Map(), element = {style: {}, setPointerCapture() {},
    getBoundingClientRect: () => ({left: 0, top: 0, width: 100, height: 100}),
    addEventListener: (name, callback) => listeners.set(name, callback)};
  const {p} = setup(); p.renderer = {domElement: element, xr: {isPresenting: false}};
  p.camera = {}; p.raycaster.setFromCamera = () => {};
  p.cast = () => null; p.beginWorldGrab = () => {}; p.moveWorld = () => {};
  p.wantsTablePoint = () => true; p.teleopOwnsInputs = () => false;
  let goals = 0; p.offerTablePoint = () => { goals++; return true; }; p.bindMouse();
  const event = {clientX: 50, clientY: 50, pointerId: 1, button: 0};
  const down = e => listeners.get('pointerdown')(e), up = e => listeners.get('pointerup')(e);
  down(event); assert.equal(goals, 0); up(event); assert.equal(goals, 1);
  down(event); listeners.get('pointermove')({...event, clientX: 60}); up(event); assert.equal(goals, 1);
  down(event); listeners.get('pointercancel')(event); up(event); assert.equal(goals, 1);
  for (const button of [1, 2]) { down({...event, button}); up({...event, button}); } assert.equal(goals, 1);
});

test('a floor pick respects the visible tabletop boundary and converts into robot coordinates', () => {
  const {p, pointer} = setup(); let sent = null;
  p.stage = {clipping: true, lifeSize: false, clipPlanes: [{distanceToPoint: () => -1}],
    toRobot: point => point.addScalar(2)};
  p.tablePoint = () => pointer.grip.clone().set(1, 2, 3);
  p.onTablePoint = point => { sent = point; return true; };
  assert.equal(p.offerTablePoint(pointer), false); assert.equal(sent, null);
  p.stage.clipPlanes = []; assert.equal(p.offerTablePoint(pointer), true);
  assert.deepEqual(sent.toArray(), [3, 4, 5]);
});
