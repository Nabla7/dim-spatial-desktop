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
    this.layers = new Map(); this.tfSubscriptions = []; this.framed = false; this.follow = null; this.autoFollow = true;
    // Taking hold of the world (a drag, a pinch, a stick) ends following: the user is placing the view now.
    this.stage.onManualMove = () => { if (this.follow) { this.follow = null; this.autoFollow = false; this.emit(); } };
    this.stage.following = () => !!this.follow;
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
    const paired = new Set();
    // The first of the names that is another topic of the wanted kind.
    const named = (own, names, test) => { for (const name of names) { const topic = name !== own.topic && byTopic(name); if (topic && test(topic)) return topic; } return null; };
    const isColor = topic => IMAGE_TYPES.includes(topic.type) && !isDepth(topic), isInfo = topic => topic.type === 'sensor_msgs.CameraInfo';
    for (const topic of topics) {
      if (!IMAGE_TYPES.includes(topic.type) || !isDepth(topic)) continue;
      // A depth image, the colour image beside it and the intrinsics for both make one textured surface.
      // Found by name (/left_wrist_depth + /left_wrist + /left_wrist_info; /depth_image + /color_image +
      // /camera_info; /camera/depth/image_raw + /camera/color/image_raw), else by being the same module's.
      const name = topic.topic, parent = name.replace(/[^/]*$/, '');
      const color = named(topic, [name.replace(/_depth/i, ''), name.replace(/depth/i, 'color'), name.replace(/depth/i, 'rgb'), name.replace(/depth_?/i, '')], isColor)
        || inModule(topic, other => isColor(other) && !paired.has(other.key));
      const info = named(topic, [name.replace(/_depth.*/i, '_info'), name.replace(/depth_image.*/i, 'camera_info'), `${parent}camera_info`, name.replace(/depth/i, 'color').replace(/[^/]*$/, 'camera_info')], isInfo)
        || inModule(topic, isInfo);
      if (!info) continue;
      paired.add(topic.key); if (color) paired.add(color.key);
      add(`rgbd:${topic.key}`, () => new RgbdLayer(this, {depth: topic, color, info}), true);
    }
    for (const topic of topics) {
      if (topic.type === 'sensor_msgs.PointCloud2') add(topic.key, () => new CloudLayer(this, topic), !/raw/i.test(topic.topic));
      else if (IMAGE_TYPES.includes(topic.type) && !paired.has(topic.key)) {
        const name = topic.topic, info = named(topic, [name.replace(/(_image)?$/, '_info'), name.replace(/[^/]*$/, 'camera_info')], isInfo) || inModule(topic, isInfo);
        add(topic.key, () => new CameraLayer(this, {color: topic, info}), false);
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
    if (!blueprint.running) { this.tf.clear(); this.framed = false; this.firstData = 0; this.follow = null; this.autoFollow = true; }
    this.emit();
  }

  // Bring what is drawn onto the table. With a robot model the view is the robot and the few metres around
  // it (a building-sized map would shrink the robot to a dot); without one it is everything drawn.
  frameAll() {
    const box = new THREE.Box3(), robot = this.robotPosition();
    // The lowest link is a wheel's or a foot's centre: the floor is a little under it.
    if (robot) box.setFromCenterAndSize(robot, new THREE.Vector3(5, 5, 0)).min.z = robot.z - 0.08;
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

  robotRoot() {
    for (const layer of this.layers.values()) if (layer.kind === 'robot' && layer.visible && layer.model) return layer.model.links[0]?.link || null;
    return null;
  }

  setFollow(on) { this.autoFollow = false; this.follow = on ? this.robotRoot() : null; this.emit(); }

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
    // Watchdog, every two seconds: a shown layer whose topic is publishing but which has heard nothing lately.
    if (now - (this.checkedAt || 0) > 2000) {
      this.checkedAt = now;
      for (const layer of this.layers.values()) {
        const rate = layer.topic ? this.app.blueprint.topics.get(layer.topic.key)?.hz || 0 : 0;
        if (!layer.visible || layer.kind === 'robot' || rate < 0.5) continue;
        const silence = now - Math.max(layer.lastAt, layer.restartedAt || 0, layer.shownAt || 0);
        if (silence > 8000 + 4000 / rate) { console.warn(`layer ${layer.label}: no data for ${Math.round(silence / 1000)} s while the topic runs at ${rate.toFixed(1)} Hz; subscribing again`); layer.restart(); }
      }
    }
    // A robot that drives is kept at the middle of the table until the user takes hold of the world.
    if (this.autoFollow && !this.follow) { const root = this.robotRoot(); if (root && this.tf.knows(root)) { this.follow = root; this.emit(); } }
    if (this.follow) {
      const pose = this.tf.knows(this.follow) ? this.tf.lookup(this.follow) : null;
      if (pose) { const p = new THREE.Vector3().setFromMatrixPosition(pose); this.stage.target.center.x = p.x; this.stage.target.center.y = p.y; }
    }
  }
}
