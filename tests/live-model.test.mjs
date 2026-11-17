import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';

registerHooks({resolve(specifier, context, next) {
  if (specifier === 'three') return {url: new URL('../frontend/vendor/three/three.module.min.js', import.meta.url).href, shortCircuit: true};
  if (specifier.startsWith('three/addons/')) return {url: new URL(`../frontend/vendor/${specifier}`, import.meta.url).href, shortCircuit: true};
  return next(specifier, context);
}});
const THREE = await import('three');
const {GLTFLoader} = await import('three/addons/loaders/GLTFLoader.js');
const {RobotLayer} = await import('../frontend/src/scene/viz/robot.js');
const {gateway} = await import('../frontend/src/data/gateway.js');

test('a live USD body follows TF and keeps the source solid material', async t => {
  const pose = new THREE.Matrix4().makeTranslation(2, 3, 4);
  const layers = {bus: {}, tf: {knows: frame => frame === 'robot/arm', lookup: () => pose},
    stage: {clip: value => value, materials: new Set()}, theme: {three: {primary: new THREE.Color()}}, emit() {}};
  const layer = new RobotLayer(layers, {files: {}, request: {}});
  const scene = new THREE.Group(), solid = new THREE.MeshStandardMaterial();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), solid);
  mesh.userData.frame = 'robot/arm'; scene.add(mesh);
  t.mock.method(GLTFLoader.prototype, 'loadAsync', async () => ({scene}));
  t.mock.method(gateway.liveModel, 'file', () => 'model.glb');
  t.after(() => layer.dispose());

  await layer.loadUsd(async () => ({id: 'model', ready: true, frames: ['robot/arm']}));
  layer.update(0);

  assert.equal(layer.links.get('robot/arm').visible, true);
  assert.deepEqual(layer.links.get('robot/arm').matrix.elements, pose.elements);
  assert.equal(mesh.parent.rotation.x, Math.PI / 2);
  assert.equal(mesh.userData.materials.solid, solid);
  layer.setStyle('solid');
  assert.equal(mesh.material, solid);
  assert.equal(layer.pending.size, 0);
});
