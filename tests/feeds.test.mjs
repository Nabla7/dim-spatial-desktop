import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';

registerHooks({resolve(specifier, context, next) {
  if (specifier === 'three') return {url: new URL('../frontend/vendor/three/three.module.min.js', import.meta.url).href, shortCircuit: true};
  return next(specifier, context);
}});
const {Feeds} = await import('../frontend/src/scene/feeds.js');
const topic = name => ({key: `dimos/${name}/sensor_msgs.CompressedImage`, type: 'sensor_msgs.CompressedImage'});

function setup(t) {
  const doc = new EventTarget(); doc.hidden = false;
  doc.createElement = () => ({play: async () => {}, pause() {}, srcObject: null});
  const subscriptions = [], storage = new Map();
  const bus = {subscribe(key, options, callback) {
    const subscription = {key, options, callback, updates: [], closed: false,
      ready: async () => {}, close() { this.closed = true; },
      update(change) { this.updates.push(change); return Promise.resolve(); }};
    subscriptions.push(subscription); return subscription;
  }};
  const feeds = new Feeds(bus, {document: doc, storage: {getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value)}});
  t.after(() => feeds.dispose());
  const hidden = value => { doc.hidden = value; doc.dispatchEvent(new Event('visibilitychange')); };
  return {feeds, subscriptions, hidden, storage};
}

test('a camera screen shares its preview track and removes the preview caps in place', t => {
  const {feeds, subscriptions} = setup(t), camera = topic('head');
  const preview = feeds.acquire(camera, 'preview');
  assert.equal(subscriptions[0].options.maxHz, 3);
  assert.deepEqual(subscriptions[0].options.maxResolution, [320, 240]);
  const screen = feeds.acquire(camera);
  assert.equal(screen, preview); assert.equal(subscriptions.length, 1);
  assert.deepEqual(subscriptions[0].updates.at(-1), {
    maxResolution: null, maxHz: null, qualityToHzTradeoff: null, bandwidthPriority: 2,
  });
  // Resize acquires the replacement before disposing the old panel.
  feeds.acquire(camera); feeds.release(screen);
  assert.equal(screen.uses.view, 1); assert.equal(subscriptions[0].closed, false);
  feeds.release(screen);
  assert.equal(screen.options.maxHz, 3); assert.equal(subscriptions[0].closed, false);
  feeds.release(preview, 'preview');
  assert.equal(subscriptions[0].closed, true); assert.equal(feeds.feeds.size, 0);
});

test('hidden pages release video; a visible XR session overrides DOM visibility', t => {
  const {feeds, subscriptions, hidden} = setup(t), feed = feeds.acquire(topic('head'));
  hidden(true); assert.equal(subscriptions[0].closed, true); assert.equal(feed.subscription, null);
  // Messages already queued on a closed receiver must not reattach it.
  subscriptions[0].callback({mediaStream: {old: true}});
  assert.equal(feed.video.srcObject, null);
  feeds.setXrVisibility(true); assert.equal(subscriptions.length, 2);
  hidden(false); hidden(true); assert.equal(subscriptions.length, 2); assert.equal(subscriptions[1].closed, false);
  feeds.setXrVisibility(false); assert.equal(subscriptions[1].closed, true);
  feeds.setXrVisibility(null); assert.equal(subscriptions.length, 2);
  hidden(false); assert.equal(subscriptions.length, 3);
});

test('teleop promotes previews and removes buffered playout with a fresh receiver', t => {
  const {feeds, subscriptions} = setup(t), feed = feeds.acquire(topic('wrist'), 'preview');
  feeds.setQuality(feed, 'quality');
  assert.equal(feed.options.maxHz, 3);
  feeds.setInteractive(true);
  assert.equal(feed.options.maxHz, undefined);
  assert.deepEqual(feed.options.playoutDelay, [0, 0]);
  feeds.acquire(topic('wrist'));
  feeds.setInteractive(false);
  assert.deepEqual(feed.options.playoutDelay, [100, 400]);
  const previous = feed.subscription;
  feeds.setInteractive(true);
  assert.equal(previous.closed, true); assert.notEqual(feed.subscription, previous);
  assert.deepEqual(feed.options.playoutDelay, [0, 0]);
  assert.equal(subscriptions.length, 2);
});

test('changing the main camera reallocates priority without opening extra receivers', t => {
  const {feeds, subscriptions} = setup(t);
  const head = feeds.acquire(topic('head')), wrist = feeds.acquire(topic('wrist'));
  assert.equal(head.options.bandwidthPriority, 2); assert.equal(wrist.options.bandwidthPriority, 1);
  feeds.setMain(wrist.key);
  assert.equal(head.options.bandwidthPriority, 1); assert.equal(wrist.options.bandwidthPriority, 2);
  assert.equal(subscriptions.length, 2);
  feeds.release(wrist); assert.equal(head.options.bandwidthPriority, 2);
});

test('a rejected update cannot resurrect a subscription hidden or superseded meanwhile', async t => {
  const {feeds, subscriptions, hidden} = setup(t), feed = feeds.acquire(topic('head'));
  let reject;
  subscriptions[0].update = () => new Promise((_, no) => { reject = no; });
  feeds.setQuality(feed, 'latency'); hidden(true); reject(new Error('old receiver'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(subscriptions.length, 1); assert.equal(feed.subscription, null);
  hidden(false);
  assert.deepEqual(feed.options.maxResolution, [640, 360]);
  assert.equal(subscriptions.length, 2);
});

test('compressed video uses the native video decoder and presets survive manager recreation', t => {
  const {feeds, subscriptions, storage} = setup(t);
  const feed = feeds.acquire({key: 'dimos/video/foxglove_msgs.CompressedVideo', type: 'foxglove_msgs.CompressedVideo'});
  assert.equal(subscriptions[0].options.encoding, 'dimos_lcm_compressed_video');
  feeds.setQuality(feed, 'latency');
  assert.equal(JSON.parse([...storage.values()][0])[feed.key], 'latency');
});
