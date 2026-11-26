import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
const hook = registerHooks({resolve(specifier, context, next) {
  return next(specifier === 'three' ? new URL('../frontend/vendor/three/three.module.min.js', import.meta.url).href : specifier, context);
}});
const THREE = await import('three');
const {cloudMaterial} = await import('../frontend/src/scene/viz/cloud-material.js');
const {makePointMaterial, applyLook} = await import('../frontend/vendor/dimos-react/point-renderer.js');
hook.deregister();

test('uses standard Controller voxel palette, opacity, lighting and depth policy', () => {
  const material = cloudMaterial({clip: m => m}, 0.1), reference = makePointMaterial({value: 1});
  applyLook(reference, {}, [0, 2]);
  for (const name of ['uGradient', 'uOpacity', 'uCubeShade', 'uStyle', 'uColorMode'])
    assert.equal(material.uniforms[name].value, reference.uniforms[name].value);
  assert.equal(material.depthWrite, true); assert.equal(material.transparent, false);
  assert.equal(material.blending, THREE.NormalBlending);
  assert.equal(material.uniforms.uSize.value, 0.1);
  assert.match(material.vertexShader, /placement \* vec4\(position/);
  assert.match(material.vertexShader, /clipping_planes_vertex/);
  assert.match(material.fragmentShader, /clipping_planes_fragment/);
});

test('table translation, rotation and scale preserve map coordinates and size per XR eye', () => {
  const world = new THREE.Group();
  world.position.set(4, 2, -3); world.rotation.set(-Math.PI / 2, 0, 0.8); world.scale.setScalar(0.2); world.updateMatrixWorld();
  const material = cloudMaterial({world, clip: m => m}, 0.1), u = material.uniforms;
  const renderer = {getDrawingBufferSize: v => v.set(1600, 1000)};
  for (const eye of [-1, 1]) {
    const camera = new THREE.PerspectiveCamera(65, 1, 0.01, 100);
    camera.position.set(eye * 0.032, 1.6, 1); camera.updateMatrixWorld();
    camera.viewport = new THREE.Vector4(eye < 0 ? 0 : 800, 0, 800, 900);
    material.onBeforeRender(renderer, null, camera);
    const p = new THREE.Vector3(1.25, -0.5, 0.7);
    const expected = p.clone().applyMatrix4(world.matrixWorld).applyMatrix4(camera.matrixWorldInverse);
    assert(p.clone().applyMatrix4(u.mapView.value).distanceTo(expected) < 1e-9);
    assert(u.mapCamera.value.clone().applyMatrix4(world.matrixWorld).distanceTo(camera.position) < 1e-9);
    assert(Math.abs(u.uPxPerMeter.value - 900 * camera.projectionMatrix.elements[5] * 0.1) < 1e-9);
    assert(Math.abs(new THREE.Vector3().setFromMatrixColumn(u.mapRotation.value, 0).length() - 1) < 1e-9);
    assert(Math.abs(u.uLightWorld.value.length() - 1) < 1e-9);
  }
});
