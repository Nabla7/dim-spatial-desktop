import test from 'node:test';
import assert from 'node:assert/strict';
import {flow} from '../frontend/src/ui/flow.js';

const GAP = 0.016, SIDE = 0.74;
const panel = (id, height, order, kept = false) => ({id, height, order, kept});
const ids = columns => columns.map(column => column.map(entry => entry.id));

test('a tool gives way to the next tool on its side', () => {
  const {columns, closed} = flow([panel('modules', SIDE, 0), panel('layers', SIDE, 1)], SIDE, GAP);
  assert.deepEqual(ids(columns), [['layers']]);
  assert.deepEqual(closed.map(entry => entry.id), ['modules']);
});

test('a kept screen stays when a tool opens: the tool stands beside it', () => {
  const {columns, closed} = flow([panel('screen', 0.36, 0, true), panel('control', SIDE, 1)], SIDE, GAP);
  assert.deepEqual(ids(columns), [['screen'], ['control']]);
  assert.deepEqual(closed, []);
});

test('two kept screens share the column at the edge, and the next tool still replaces the last one', () => {
  const screens = [panel('head', 0.36, 0, true), panel('wrist', 0.36, 1, true)];
  const first = flow([...screens, panel('control', SIDE, 2)], SIDE, GAP);
  assert.deepEqual(ids(first.columns), [['head', 'wrist'], ['control']]);
  const second = flow([...screens, panel('control', SIDE, 2), panel('agent', SIDE, 3)], SIDE, GAP);
  assert.deepEqual(ids(second.columns), [['head', 'wrist'], ['agent']]);
  assert.deepEqual(second.closed.map(entry => entry.id), ['control']);
});

test('a kept tool is not given up either', () => {
  const {columns, closed} = flow([panel('control', SIDE, 0, true), panel('agent', SIDE, 1), panel('logs', 0.44, 2)], SIDE, GAP);
  assert.deepEqual(ids(columns), [['control'], ['logs']]);
  assert.deepEqual(closed.map(entry => entry.id), ['agent']);
});

test('panels that fit under one another stay, the older one above', () => {
  const {columns, closed} = flow([panel('view', 0.3, 0), panel('stats', 0.4, 1)], SIDE, GAP);
  assert.deepEqual(ids(columns), [['view', 'stats']]);
  assert.deepEqual(closed, []);
});

test('a kept panel taller than the side still has a place', () => {
  const {columns} = flow([panel('tall', 0.9, 0, true)], SIDE, GAP);
  assert.deepEqual(ids(columns), [['tall']]);
});
