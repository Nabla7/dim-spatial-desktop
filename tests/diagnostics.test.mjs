import test from 'node:test';
import assert from 'node:assert/strict';
import {Diagnostics, rate} from '../frontend/src/data/diagnostics.js';

test('rates distinguish unsupported counters, reconnects, and an actual stalled stream', () => {
  assert.equal(rate(undefined, 60, 2), null);
  assert.equal(rate(60, 0, 2), null);
  assert.equal(rate(60, 60, 2), 0);
  assert.equal(rate(60, 120, 2), 30);
});

test('closing a feed cancels both presentation watchers and discards its counters', () => {
  let cancelled = null, latencyStopped = false;
  const diagnostics = Object.create(Diagnostics.prototype);
  const feed = {key: 'camera', video: {cancelVideoFrameCallback: id => { cancelled = id; }}};
  const watch = {handle: 7, stopLatency: () => { latencyStopped = true; }};
  diagnostics.watches = new Map([[feed, watch]]); diagnostics.previous = new Map([['camera', {}]]);
  diagnostics.unwatch(feed, watch);
  assert.equal(cancelled, 7); assert.ok(latencyStopped);
  assert.equal(diagnostics.watches.size, 0); assert.equal(diagnostics.previous.size, 0);
});

test('viewer telemetry measures display separately from gateway sends and unavailable browser counters', async () => {
  const diagnostics = Object.create(Diagnostics.prototype), feed = {key: 'camera', video: {videoWidth: 640, videoHeight: 480}, subscription: {gatewayStats: {id: 1, stats: {received: 120, sent: 90}}}};
  diagnostics.id = 'viewer'; diagnostics.lastSample = performance.now() - 2000; diagnostics.intervals = [20, 20, 20];
  diagnostics.watches = new Map([[feed, {shown: 11, lastShown: performance.now() - 500, handle: 1}]]);
  diagnostics.previous = new Map([['camera', {shown: 5, input: 60, sent: 30, subscription: 1}]]);
  diagnostics.app = {bus: {client: null, state: 'connected'}, xr: {presenting: true}, blueprint: {topics: new Map([['camera', {hz: 0}]]), runId: 'test'}, layers: {feeds: {feeds: new Map([['camera', feed]])}}};
  diagnostics.app.bus.client = {stats: {depth: {gateway: {key: 'depth', opts: {bandwidthPriority: 0.25}, allocation: {demandBytesPerSec: 20e6, budgetBytesPerSec: 1e6}}}}};
  globalThis.document = {visibilityState: 'visible'};
  const report = await diagnostics.collect();
  assert.equal(report.display.fps, 50); assert.equal(report.immersive, true);
  const camera = report.cameras[0];
  assert.ok(camera.sentFps > 29 && camera.sentFps < 31);
  assert.ok(camera.displayedFps > 2.9 && camera.displayedFps < 3.1);
  assert.equal(camera.decodedFps, null); assert.equal(camera.jitterBufferMs, null);
  assert.ok(camera.sourceFps > 29 && camera.sourceFps < 31);
  assert.equal(report.streams[0].key, 'depth');
  assert.equal(report.streams[0].allocation.demandBytesPerSec, 20e6);
  assert.equal(report.streams[0].bandwidthPriority, 0.25);
  feed.subscription.gatewayStats.id = 2;
  feed.subscription.gatewayStats.stats.received = 300;
  const reconnect = await diagnostics.collect();
  assert.equal(reconnect.cameras[0].sourceFps, null);
  assert.equal(reconnect.cameras[0].sentFps, null);
  delete globalThis.document;
});
