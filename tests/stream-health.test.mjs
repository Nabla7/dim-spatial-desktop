import test from 'node:test';
import assert from 'node:assert/strict';
import {deliveryRate} from '../frontend/src/scene/stream-health.js';

test('recovery respects paused and throttled depth without mistaking camera-info rates for depth', () => {
  const streams = [
    {gatewayStats: {key: 'camera-info', allocation: {hz: 1}}},
    {gatewayStats: {key: 'depth', allocation: {hz: 0}}},
  ];
  assert.equal(deliveryRate('depth', 5, streams), 0);
  streams[1].gatewayStats.allocation.hz = 0.1;
  assert.equal(deliveryRate('depth', 5, streams), 0.1);
  streams[1].gatewayStats.allocation.hz = 30;
  assert.equal(deliveryRate('depth', 5, streams), 5);
});

test('without gateway allocation, recovery still detects a silent publishing topic', () => {
  assert.equal(deliveryRate('depth', 5, []), 5);
  assert.equal(deliveryRate('depth', 5, [{}]), 5);
  assert.equal(deliveryRate('depth', 5, [{gatewayStats: {key: 'depth'}}]), 5);
});
