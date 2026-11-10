// What the running blueprint's streams look like on the table. A layer is made for each topic whose
// message type has a drawing here; nothing is keyed to a robot or a module name. A layer subscribes
// only while it is shown, so a hidden camera or cloud costs no bandwidth.
import * as THREE from 'three';
import {TfTree} from './tf.js';
import {Feeds} from './feeds.js';
import {CloudLayer} from './viz/cloud.js';
import {RgbdLayer, CameraLayer} from './viz/rgbd.js';
import {RobotLayer} from './viz/robot.js';
import {FramesLayer} from './viz/frames.js';
import {PoseLayer, PathLayer, GridLayer} from './viz/nav.js';

const POSE_TYPES = ['nav_msgs.Odometry', 'geometry_msgs.PoseStamped', 'geometry_msgs.PoseWithCovarianceStamped'];
const IMAGE_TYPES = ['sensor_msgs.Image', 'sensor_msgs.CompressedImage'];
const isDepth = topic => /depth/i.test(topic.topic);

export class Layers extends EventTarget {
  constructor(app) {
    super();
    this.app = app; this.bus = app.bus; this.stage = app.stage; this.theme = app.theme;
    this.tf = new TfTree(); this.feeds = new Feeds(app.bus);
    this.layers = new Map(); this.tfSubscriptions = []; this.framed = false; this.follow = null;
    this.root = new THREE.Group(); this.root.name = 'layers'; this.stage.world.add(this.root);
    this.choices = this.loadChoices();
    app.blueprint.addEventListener('modules', () => this.sync());
    app.bus.addEventListener('state', () => { if (app.bus.live) this.sync(); });
  }

  loadChoices() { try { return JSON.parse(localStorage.getItem('spatial.layers') || '{}'); } catch { return {}; } }
  saveChoices() { try { localStorage.setItem('spatial.layers', JSON.stringify(this.choices)); } catch { /* private mode */ } }

  get(key) { return this.layers.get(key) || null; }
  list() { return [...this.layers.values()]; }
  emit() { this.dispatchEvent(new Event('change')); }

  toggle(key, on = null) {
    const layer = this.layers.get(key);
    if (!layer) return;
    const next = on ?? !layer.visible;
    this.choices[`${this.app.blueprint.name}|${key}`] = next; this.saveChoices();
    layer.setVisible(next); this.emit();
  }

  // Rebuild the set of layers from the blueprint's topics.
  sync() {
    const blueprint = this.app.blueprint, topics = [...blueprint.topics.values()], wanted = new Map();
    if (!this.bus.live) return;
    const add = (key, make, visible) => wanted.set(key, {make, visible});
    const byTopic = name => topics.find(topic => topic.topic === name);
    const inModule = (topic, test) => {
      for (const id of topic.writers) for (const stream of blueprint.module(id)?.streams || []) {
        const other = blueprint.topics.get(stream.key);
        if (other && other !== topic && stream.direction !== 'in' && test(other)) return other;
      }
      return null;
    };
    const robotModel = topics.some(topic => topic.type === 'files.File');
    const depthUsed = new Set(), colorUsed = new Set();
    for (const topic of topics) {
      if (!IMAGE_TYPES.includes(topic.type) || !isDepth(topic)) continue;
      // A depth image, the colour image beside it and the intrinsics for both: one textured surface.
      const stem = topic.topic.replace(/_?depth_?/i, '_').replace(/_image|_$/g, '').replace(/__+/g, '_');
      const color = byTopic(topic.topic.replace(/_depth/i, '')) || byTopic(topic.topic.replace(/depth/i, 'color')) || byTopic(topic.topic.replace(/depth/i, 'rgb'))
        || inModule(topic, other => IMAGE_TYPES.includes(other.type) && !isDepth(other) && other.topic.startsWith(stem || '/'));
      const info = byTopic(topic.topic.replace(/_depth.*/i, '_info')) || byTopic(topic.topic.replace(/depth_image.*/i, 'camera_info')) || byTopic(topic.topic.replace(/depth.*/i, 'camera_info'))
        || inModule(topic, other => other.type === 'sensor_msgs.CameraInfo' && other.topic.startsWith(stem || '/'))
        || inModule(topic, other => other.type === 'sensor_msgs.CameraInfo');
      if (!info) continue;
      depthUsed.add(topic.key); if (color) colorUsed.add(color.key);
      add(`rgbd:${topic.key}`, () => new RgbdLayer(this, {depth: topic, color, info}), true);
    }
    for (const topic of topics) {
      if (topic.type === 'sensor_msgs.PointCloud2') add(topic.key, () => new CloudLayer(this, topic), !/raw/i.test(topic.topic));
      else if (IMAGE_TYPES.includes(topic.type) && !depthUsed.has(topic.key)) {
        const info = !isDepth(topic) && (byTopic(topic.topic.replace(/(_image)?$/, '_info')) || byTopic(topic.topic.replace(/[^/]*$/, 'camera_info')) || inModule(topic, other => other.type === 'sensor_msgs.CameraInfo'));
        add(topic.key, () => new CameraLayer(this, {color: topic, info: info || null, paired: colorUsed.has(topic.key)}), false);
      }
      else if (POSE_TYPES.includes(topic.type)) add(topic.key, () => new PoseLayer(this, topic), true);
      else if (topic.type === 'nav_msgs.Path') add(topic.key, () => new PathLayer(this, topic), true);
      else if (topic.type === 'nav_msgs.OccupancyGrid') add(topic.key, () => new GridLayer(this, topic), true);
      else if (topic.type === 'files.File') {
        const request = topics.find(other => other.type === 'std_msgs.String' && /render_file_request$/.test(other.topic));
        if (request) add(topic.key, () => new RobotLayer(this, {files: topic, request}), true);
      }
    }
    const tfTopics = topics.filter(topic => topic.type === 'tf2_msgs.TFMessage');
    if (tfTopics.length) add('frames', () => new FramesLayer(this), !robotModel);

    for (const [key, layer] of this.layers) if (!wanted.has(key)) { layer.dispose(); this.layers.delete(key); }
    for (const [key, {make, visible}] of wanted) {
      if (this.layers.has(key)) continue;
      const layer = make(); layer.key = key; this.layers.set(key, layer); this.root.add(layer.object);
      layer.setVisible(this.choices[`${blueprint.name}|${key}`] ?? visible);
    }
    // The transform tree is always fed while something runs: every other layer is placed by it.
    for (const subscription of this.tfSubscriptions) subscription.close();
    this.tfSubscriptions = tfTopics.map(topic => this.bus.subscribeDecoded(topic.key, {delivery: 'reliable'}, message => this.tf.add(message, performance.now())));
    if (!tfTopics.length) this.tf.clear();
    if (!blueprint.running) { this.tf.clear(); this.framed = false; this.firstData = 0; }
    this.emit();
  }

  // Bring what is drawn onto the table. With a robot model the view is the robot and the few metres around
  // it (a building-sized map would shrink the robot to a dot); without one it is everything drawn.
  frameAll() {
    const box = new THREE.Box3(), robot = this.robotPosition();
    if (robot) box.setFromCenterAndSize(robot, new THREE.Vector3(5, 5, 0)).min.z = robot.z;
    else {
      for (const layer of this.layers.values()) if (layer.visible && layer.bounds) { const bounds = layer.bounds(); if (bounds && !bounds.isEmpty()) box.union(bounds); }
      if (box.isEmpty()) return false;
      const size = box.getSize(new THREE.Vector3()), limit = 14;
      if (Math.max(size.x, size.y) > limit) {
        const focus = box.getCenter(new THREE.Vector3());
        box.min.set(focus.x - limit / 2, focus.y - limit / 2, box.min.z); box.max.set(focus.x + limit / 2, focus.y + limit / 2, box.max.z);
      }
    }
    this.stage.frame(box);
    return true;
  }

  robotPosition() {
    for (const layer of this.layers.values()) if (layer.kind === 'robot' && layer.visible) { const position = layer.position?.(); if (position) return position; }
    return null;
  }

  update(dt, now) {
    for (const layer of this.layers.values()) if (layer.visible) layer.update(now, dt);
    // The first framing waits a moment for data, and for the robot's pose when there is a robot to wait for.
    if (!this.framed && this.layers.size) {
      const waited = now - (this.firstData || (this.firstData = now)), robot = [...this.layers.values()].some(layer => layer.kind === 'robot' && layer.visible);
      if (waited > 1500 && (!robot || this.robotPosition() || waited > 8000)) this.framed = this.frameAll();
    }
    if (this.follow) {
      const pose = this.tf.lookup(this.follow);
      if (pose && this.tf.has(this.follow)) { const p = new THREE.Vector3().setFromMatrixPosition(pose); this.stage.target.center.x = p.x; this.stage.target.center.y = p.y; }
    }
  }
}
