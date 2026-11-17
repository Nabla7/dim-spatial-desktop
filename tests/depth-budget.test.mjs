import test from 'node:test';
import assert from 'node:assert/strict';
import {DEPTH_GRID_COLUMNS, meshDepthQuality} from '../frontend/src/scene/viz/depth-budget.js';

test('depth delivery keeps the mesh grid while avoiding unused full-resolution pixels', () => {
  for (const width of [160, 256, 640, 848, 1280, 1920, 4096]) {
    const quality = meshDepthQuality(width);
    assert.ok(quality >= 0 && quality <= 1);
    const stride = Math.round(1 / (1 / 8 + 7 / 8 * quality));
    assert.ok(Math.ceil(width / stride) >= Math.min(width, DEPTH_GRID_COLUMNS));
    if (width >= 512) assert.ok(stride >= 2);
  }
  const stride = Math.round(1 / (1 / 8 + 7 / 8 * meshDepthQuality(1280)));
  assert.equal(stride, 5);
  assert.equal(Math.ceil(1280 / stride), DEPTH_GRID_COLUMNS);
});
