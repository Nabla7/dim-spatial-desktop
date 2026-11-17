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
