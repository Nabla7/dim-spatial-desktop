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
const {Layers} = await import('../frontend/src/scene/layers.js');
const {gateway} = await import('../frontend/src/data/gateway.js');

test('a publishing source does not cancel the gateway negotiation of a quiet viewer', () => {
  const app = {bus: new EventTarget(), blueprint: new EventTarget(),
    stage: {world: new THREE.Group()}, theme: {}};
  app.blueprint.topics = new Map([['camera', {hz: 30}]]);
  const layers = new Layers(app); layers.framed = true; layers.autoFollow = false;
  let restarts = 0;
  layers.layers.set('camera', {visible: true, topic: {key: 'camera'}, subscriptions: [],
    lastAt: 0, shownAt: 0, update() {}, restart() { restarts++; }});
  layers.update(0.02, 30000);
  layers.update(0.02, 60000);
  assert.equal(restarts, 0);
});

test('follow keeps the robot base centered without changing view scale, yaw or floor', t => {
  const app = {bus: new EventTarget(), blueprint: new EventTarget(),
    stage: {world: new THREE.Group(), target: {center: new THREE.Vector3(0, 0, -0.08), scale: .2, yaw: .4}},
    theme: {three: {primary: new THREE.Color()}}};
  app.blueprint.topics = new Map();
  const layers = new Layers(app); layers.framed = true;
  const robot = new RobotLayer(layers, {files: {}, request: {}});
  t.after(() => robot.dispose());
  robot.visible = true;
  robot.model = {links: ['arm', 'base'].map(link => ({link}))};
  layers.layers.set('model', robot);
  const transform = (parent, child, x, y) => ({header: {frame_id: parent}, child_frame_id: child,
    transform: {translation: {x, y, z: 0}, rotation: {x: 0, y: 0, z: 0, w: 1}}});
  layers.tf.add({transforms: [transform('world', 'base', 2, 3), transform('base', 'arm', .8, 0)]}, 0);

  layers.setFollow(true); layers.update(.02, 1);
  assert.equal(layers.follow, 'base');
  assert.deepEqual(app.stage.target.center.toArray(), [2, 3, -.08]);
  layers.tf.add({transforms: [transform('world', 'base', 4, 5)]}, 2);
  layers.update(.02, 2);
  assert.deepEqual(app.stage.target.center.toArray(), [4, 5, -.08]);
  assert.equal(app.stage.target.scale, .2); assert.equal(app.stage.target.yaw, .4);

  app.stage.onManualMove();
  layers.tf.add({transforms: [transform('world', 'base', 8, 9)]}, 3);
  layers.update(.02, 3);
  assert.equal(layers.follow, null);
  assert.deepEqual(app.stage.target.center.toArray(), [4, 5, -.08]);
  layers.setFollow(true); layers.update(.02, 4);
  assert.deepEqual(app.stage.target.center.toArray(), [8, 9, -.08]);
});

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
