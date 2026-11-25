// The standard Controller's renderer, adapted only for Spatial's movable/scaled map and clipping.
// Grid snapping, height colors and cube lighting stay in the robot's fixed frame, even in XR.
import * as THREE from 'three';
import {makePointMaterial, applyLook} from '../../../vendor/dimos-react/point-renderer.js';

export function cloudMaterial(stage, size) {
  const material = makePointMaterial({value: 1000});
  applyLook(material, {style: 'voxel', size, colorMode: 'height', gradient: 'memworld', cubeShade: 'soft'}, [-0.2, 2.2]);
  const u = material.uniforms;
  u.placement = {value: new THREE.Matrix4()};
  u.mapView = {value: new THREE.Matrix4()};
  u.mapRotation = {value: new THREE.Matrix4()};
  u.mapCamera = {value: new THREE.Vector3()};
  material.vertexShader = '#include <clipping_planes_pars_vertex>\nuniform mat4 placement, mapView;\n' + material.vertexShader
    .replace('modelMatrix * vec4(position, 1.0)', 'placement * vec4(position, 1.0)')
    .replace('viewMatrix * vec4(center, 1.0)', 'mapView * vec4(center, 1.0)')
    .replace('gl_Position = projectionMatrix * mv;', 'vec4 mvPosition = mv;\n#include <clipping_planes_vertex>\ngl_Position = projectionMatrix * mv;');
  material.fragmentShader = '#include <clipping_planes_pars_fragment>\nuniform mat4 mapRotation;\nuniform vec3 mapCamera;\n' + material.fragmentShader
    .replaceAll('viewMatrix', 'mapRotation').replaceAll('cameraPosition', 'mapCamera')
    .replace('void main() {', 'void main() {\n#include <clipping_planes_fragment>');
  material.clipping = true;
  const inverse = new THREE.Matrix4(), viewport = new THREE.Vector2();
  const upstreamBeforeRender = material.onBeforeRender;
  material.onBeforeRender = (renderer, scene, camera) => {
    upstreamBeforeRender(renderer, scene, camera);
    const map = stage.world.matrixWorld;
    inverse.copy(map).invert();
    u.mapView.value.multiplyMatrices(camera.matrixWorldInverse, map);
    u.mapRotation.value.extractRotation(u.mapView.value);
    u.mapCamera.value.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(inverse);
    u.uLightWorld.value.transformDirection(inverse);
    // XR draws once per eye. The active eye's viewport, projection and pose are authoritative.
    const height = camera.viewport ? camera.viewport.w : renderer.getDrawingBufferSize(viewport).y;
    const scale = Math.hypot(map.elements[0], map.elements[1], map.elements[2]);
    u.uPxPerMeter.value = height * camera.projectionMatrix.elements[5] * 0.5 * scale;
    material.uniformsNeedUpdate = true;
  };
  return stage.clip(material);
}
