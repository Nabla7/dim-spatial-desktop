import test from 'node:test';
import assert from 'node:assert/strict';
import {describePads, heldPads, padAction, padSample, padSide, PadTeleop} from '../frontend/src/input/gamepads.js';

const buttons = (count, down = {}) => Array.from({length: count}, (_, i) => ({pressed: down[i] === true, value: typeof down[i] === 'number' ? down[i] : down[i] ? 1 : 0}));
// A pair of pads the system gives as one, in the standard layout.
const pair = (axes = [0, 0, 0, 0], down = {}) => ({id: 'Joy-Con (L/R)', mapping: 'standard', connected: true, axes, buttons: buttons(18, down)});
const half = (id, axes = [0, 0], down = {}) => ({id, mapping: 'standard', connected: true, axes, buttons: buttons(17, down)});

test('a pad with both sticks is in both hands: a stick, a trigger and a shoulder button each', () => {
  const held = heldPads([null, pair([0.5, -1, 0, 0.3], {7: true, 4: true})]);
  assert.deepEqual(held.left, {stick: [0.5, -1], select: false, squeeze: true});
  assert.deepEqual(held.right, {stick: [0, 0.3], select: true, squeeze: false});
  // A trigger that reports how far it is pulled, and no 'pressed', is down past half.
  assert.equal(heldPads([pair([0, 0, 0, 0], {6: 0.7})]).left.select, true);
  assert.equal(heldPads([pair([0, 0, 0, 0], {6: 0.3})]).left.select, false);
  // An axis the browser gives no number for is at rest.
  assert.deepEqual(heldPads([pair([NaN, undefined, 0, 0])]).left.stick, [0, 0]);
});

test('a pad with one stick is in the hand its name says, and no hand without a name', () => {
  assert.deepEqual([padSide('Joy-Con (L)'), padSide('Joy-Con (R)'), padSide('Left controller'), padSide('Wireless Controller')], ['left', 'right', 'left', null]);
  const held = heldPads([half('Joy-Con (R)', [0.2, 0.4], {7: true}), half('Joy-Con (L)', [-1, 0], {5: true}), half('Wireless Controller', [1, 1], {6: true})]);
  assert.deepEqual(held.right, {stick: [0.2, 0.4], select: true, squeeze: false});
  assert.deepEqual(held.left, {stick: [-1, 0], select: false, squeeze: true});
});

test('WebKit four-axis Joy-Con halves stay on their own hand in either connection order', () => {
  const left = half('Joy-Con (L) Extended Gamepad', [0.25, -0.5, 0, 0], {6: true});
  const right = half('Joy-Con (R) Extended Gamepad', [0, 0, -0.75, 0.5], {7: true});
  for (const pads of [[left, right], [right, left]]) {
    assert.deepEqual(heldPads(pads), {
      left: {stick: [0.25, -0.5], select: true, squeeze: false},
      right: {stick: [-0.75, 0.5], select: true, squeeze: false},
    });
    assert.deepEqual(describePads(pads).map(p => p.hands), pads.map(p => padSide(p.id)));
  }
  assert.equal(heldPads([right]).left, null);
  assert.equal(padSide('Joy-Con (L/R) Extended Gamepad'), null);
  assert.equal(heldPads([{...right, mapping: ''}]).right.select, true);
});

test('the primary face button also clicks the UI', () => {
  assert.equal(heldPads([pair(undefined, {0: true})]).right.select, true);
  assert.equal(heldPads([half('Joy-Con (R)', [0, 0, 0, 0], {0: true})]).right.select, true);
  assert.equal(padSample([pair(undefined, {0: true})], {right: true}).buttons[0], 0);
});

test('two standard halves form the backend pad without letting one half stand in for both', () => {
  const left = half('Joy-Con (L)', [0.5, -0.5, 0, 0], {6: true, 8: true, 12: true});
  const right = half('Joy-Con (R)', [0, 0, 0.25, -1], {3: true, 7: true, 9: true});
  const sample = padSample([right, left]);
  assert.deepEqual(sample.axes, [0.5, -0.5, 0.25, -1]);
  assert.deepEqual(sample.buttons.flatMap((value, i) => value ? [i] : []), [3, 6, 7, 8, 9, 12]);
  assert.deepEqual(padSample([left, right].map(pad => ({...pad, id: pad.id + ' Gamepad', mapping: ''}))), sample);
  assert.equal(padSample([left]), null);
});

test('UI clicks and buttons held on entry cannot become robot commands until released', () => {
  const routing = new PadTeleop();
  routing.reset([pair(undefined, {3: true})]);
  assert.equal(routing.sample([pair(undefined, {3: true})]).buttons[3], 0);
  routing.sample([pair()]);
  assert.equal(routing.sample([pair(undefined, {3: true})]).buttons[3], 1);
  assert.equal(routing.sample([pair(undefined, {7: true})], {right: true}).buttons[7], 0);
  assert.equal(routing.sample([pair(undefined, {7: true})]).buttons[7], 0);
  routing.sample([pair()]);
  assert.equal(routing.sample([pair(undefined, {7: true})]).buttons[7], 1);
  routing.sample([]);
  assert.equal(routing.sample([pair(undefined, {3: true})]).buttons[3], 0);
});

test('no pad, a pad that is gone and a second pad for a hand change nothing', () => {
  assert.deepEqual(heldPads([]), {left: null, right: null});
  assert.deepEqual(heldPads(undefined), {left: null, right: null});
  assert.deepEqual(heldPads([null, {...pair(), connected: false}]), {left: null, right: null});
  assert.deepEqual(heldPads([pair([0.1, 0, 0, 0]), pair([0.9, 0, 0, 0])]).left.stick, [0.1, 0]);
});

test('what the page shows of a pad: its name, its size, the hands it is read for and what is down', () => {
  assert.deepEqual(describePads([null, pair([0, 0, 0, 0], {7: true, 12: 0.9})]),
    [{id: 'Joy-Con (L/R)', mapping: 'standard', axes: 4, buttons: 18, hands: 'both', pressed: [7, 12]}]);
  assert.equal(describePads([half('Joy-Con (R)')])[0].hands, 'right');
  assert.equal(describePads([half('Wireless Controller')])[0].hands, null);
  assert.equal(describePads([{id: 'Remote', axes: [], buttons: buttons(2)}])[0].hands, null);
});

test('what a backend is given: the standard pad as it is, less what the page uses of a hand', () => {
  const sample = padSample([null, pair([0.5, -1.2, 0.25, NaN], {3: true, 6: 0.8, 7: true})]);
  assert.equal(sample.layout, 'standard');
  assert.deepEqual(sample.axes, [0.5, -1, 0.25, 0]);
  assert.deepEqual(sample.buttons.flatMap((value, i) => value ? [i] : []), [3, 6, 7]);
  assert.equal(sample.buttons.length, 18);
  const mine = padSample([pair([0.5, -1, 0.25, 0.1], {3: true, 4: true, 6: true, 7: true})], {left: true});
  assert.deepEqual(mine.axes, [0, 0, 0.25, 0.1]);
  assert.deepEqual(mine.buttons.flatMap((value, i) => value ? [i] : []), [3, 4, 7]);
  // One half of a pair, a pad in another layout and no pad are not given.
  assert.equal(padSample([half('Joy-Con (R)')]), null);
  assert.equal(padSample([{...pair(), mapping: ''}]), null);
  assert.equal(padSample([]), null);
});

test('a button presses on a new push, holds while it is down and lets go with the button or the hand', () => {
  const pointer = {down: false}, other = {down: false};
  assert.equal(padAction({was: false, pressed: true, holding: null, pointer}), 'press');
  // Held down from before, no hand to point with, or a pointer a pinch already holds down: no press.
  assert.equal(padAction({was: true, pressed: true, holding: null, pointer}), null);
  assert.equal(padAction({was: false, pressed: true, holding: null, pointer: null}), null);
  assert.equal(padAction({was: false, pressed: true, holding: null, pointer: {down: true}}), null);
  assert.equal(padAction({was: false, pressed: false, holding: null, pointer}), null);
  // While it holds: nothing, until the button comes up or the hand's pointer is lost or another.
  assert.equal(padAction({was: true, pressed: true, holding: pointer, pointer}), null);
  assert.equal(padAction({was: true, pressed: false, holding: pointer, pointer}), 'release');
  assert.equal(padAction({was: true, pressed: true, holding: pointer, pointer: null}), 'release');
  assert.equal(padAction({was: true, pressed: true, holding: pointer, pointer: other}), 'release');
});
