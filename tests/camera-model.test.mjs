import test from 'node:test';
import assert from 'node:assert/strict';
import {distortion, project, projectGlsl} from '../frontend/src/scene/viz/camera-model.js';

// Pixels from OpenCV (cv2.projectPoints) for the same points, intrinsics and coefficients.
const K = [980, 985, 955, 760];
const points = [[0, 0, 1], [0.4, -0.3, 1], [-0.9, 0.5, 1.2], [1.2, 0.9, 1], [0.05, 0.6, 0.4]];
const opencv = {
  pinhole: {model: 'plumb_bob', D: [0, 0, 0, 0, 0], pixels: [[955, 760], [1347, 464.5], [220, 1170.4167], [2131, 1646.5], [1077.5, 2237.5]]},
  plumb_bob: {model: 'plumb_bob', D: [-0.28, 0.07, 0.0008, -0.0005, -0.006],
    pixels: [[955, 760], [1320.7708, 484.3769], [343.9701, 1101.5717], [1725.6725, 1343.5575], [1034.4258, 1733.1477]]},
  rational_polynomial: {model: 'rational_polynomial', D: [0.52, -0.11, 0.0004, -0.0002, 0.003, 0.88, 0.02, -0.004],
    pixels: [[955, 760], [1315.3313, 488.4343], [366.9428, 1088.5747], [1592.9903, 1242.153], [1020.9045, 1561.1372]]},
};

for (const [name, {model, D, pixels}] of Object.entries(opencv)) {
  test(`a point lands where OpenCV puts it: ${name}`, () => {
    const d = distortion(model, D);
    points.forEach((point, i) => {
      const [u, v] = project(point, K, d);
      // Float32 coefficients: a hundredth of a pixel is the agreement to ask for.
      assert.ok(Math.abs(u - pixels[i][0]) < 0.01 && Math.abs(v - pixels[i][1]) < 0.01, `${name} point ${i}: ${u}, ${v}`);
    });
  });
}

test('a point behind the camera has no pixel', () => {
  assert.equal(project([0.1, 0.1, -1], K, distortion('', [])), null);
  assert.equal(project([0.1, 0.1, 0], K, distortion('', [])), null);
});

test('no coefficients is a pinhole whatever the model is called, and an unknown lens is not guessed', () => {
  assert.deepEqual([...distortion('equidistant', [0, 0, 0, 0])], [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual([...distortion(undefined, undefined)], [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(distortion('equidistant', [0.1, 0.01, 0, 0]), null);
  // Fourteen coefficients are OpenCV's full set; the formula takes the first eight.
  assert.equal(distortion('rational_polynomial', new Array(14).fill(0.5)).length, 8);
});

test('the shader has the formula with the same coefficient places', () => {
  // The JavaScript above is checked against OpenCV; this keeps the GLSL beside it from drifting.
  const places = text => [...text.matchAll(/(?:colorDistortion|d)\[(\d)\]/g)].map(match => Number(match[1]));
  assert.deepEqual(places(projectGlsl.slice(projectGlsl.indexOf('vec2 colorPixel'))), places(project.toString()));
});
