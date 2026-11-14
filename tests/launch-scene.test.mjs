import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {sceneModule} from '../frontend/src/data/launch.js';

// What the dimos gateway answered for a blueprint that records on hardware, cut down.
const hardware = JSON.parse(readFileSync(new URL('./fixtures/collection.json', import.meta.url), 'utf8')).config;
const described = (kind, args = {}) => ({class: kind, args});

test('a blueprint that simulates names the module that serves its scene', () => {
  const config = {modules: {
    scene: described('dimos.robot.usd_manager.UsdManager', {model: {type: 'RobotModel | UsdModel', json_compatible: true}}),
    simmodule: described('dimos.sim2.module.SimModule', {joint_ids: {type: 'tuple[str, ...]'}}),
    episodes: described('dimos.imitation.collection.episode_monitor.EpisodeMonitorModule'),
  }};
  // The module is found by what it is, not by its name.
  assert.equal(sceneModule(config), 'scene');
});

test('a robot on hardware has no scene to change, with or without a model server', () => {
  assert.equal(sceneModule(hardware), null);
  assert.equal(sceneModule({modules: {usdmanager: described('dimos.robot.usd_manager.UsdManager', {model: {}})}}), null);
  assert.equal(sceneModule({modules: {simmodule: described('dimos.sim2.module.SimModule')}}), null);
  assert.equal(sceneModule(null), null);
});
