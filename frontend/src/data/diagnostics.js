import {gateway} from './gateway.js';

export function rate(previous, current, seconds) {
  return Number.isFinite(previous) && Number.isFinite(current) && current >= previous && seconds > 0 ? (current - previous) / seconds : null;
}

const fields = (value, names) => Object.fromEntries(names.filter(name => value?.[name] !== undefined).map(name => [name, value[name]]));
const percentile = (values, fraction) => values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))] : null;

// Keep each tab separate: a fast laptop must never overwrite a slow headset's measurements.
// Sampling and uploads run outside the XR animation callback, with at most one request in flight.
export class Diagnostics extends EventTarget {
  constructor(app) {
    super(); this.app = app; this.id = crypto.randomUUID(); this.clients = []; this.latest = null;
    this.watches = new Map(); this.previous = new Map(); this.intervals = []; this.lastFrame = null;
    this.lastSample = performance.now(); this.stopped = false;
    this.timer = setTimeout(() => this.sample(), 2000);
    addEventListener('pagehide', () => this.stop());
    addEventListener('pageshow', () => {
      if (!this.stopped) return;
      this.stopped = false; this.lastFrame = null; this.intervals = []; this.lastSample = performance.now();
      this.timer = setTimeout(() => this.sample(), 2000);
    });
  }

  frame(now) {
    if (this.lastFrame !== null) this.intervals.push(now - this.lastFrame);
    this.lastFrame = now;
    if (this.intervals.length > 1000) this.intervals.shift();
  }

  watch(feed) {
    let watch = this.watches.get(feed);
    if (watch) {
      if (watch.subscription !== feed.subscription) {
        watch.stopLatency?.();
        watch.subscription = feed.subscription;
        watch.stopLatency = feed.subscription?.watchVideoLatency?.(feed.video);
      }
      return watch;
    }
    watch = {shown: 0, lastShown: null, handle: null, stopLatency: null, subscription: feed.subscription};
    if (feed.video.requestVideoFrameCallback) {
      watch.stopLatency = feed.subscription?.watchVideoLatency?.(feed.video);
      const shown = (now, metadata) => {
        watch.shown++; watch.lastShown = now; watch.decodeMs = metadata.processingDuration == null ? null : metadata.processingDuration * 1000;
        watch.handle = feed.video.requestVideoFrameCallback(shown);
      };
      watch.handle = feed.video.requestVideoFrameCallback(shown);
    }
    this.watches.set(feed, watch);
    return watch;
  }

  unwatch(feed, watch) {
    watch.stopLatency?.();
    if (watch.handle !== null) feed.video.cancelVideoFrameCallback(watch.handle);
    this.watches.delete(feed); this.previous.delete(feed.key);
  }

  async collect() {
    const now = performance.now(), seconds = (now - this.lastSample) / 1000;
    this.lastSample = now;
    const app = this.app, client = app.bus.client, feeds = [...app.layers.feeds.feeds.values()];
    for (const [feed, watch] of this.watches) if (!feeds.includes(feed)) this.unwatch(feed, watch);
    let rtc = [];
    try { rtc = [...(await client?._peer?.getStats())?.values() || []]; } catch { /* reconnecting */ }
    const connection = rtc.find(stat => stat.type === 'transport' && stat.selectedCandidatePairId);
    const pair = rtc.find(stat => stat.id === connection?.selectedCandidatePairId) || rtc.find(stat => stat.type === 'candidate-pair' && stat.nominated && stat.state === 'succeeded');
    const cameraReports = feeds.map(feed => {
      const watch = this.watch(feed), previous = this.previous.get(feed.key), stats = feed.subscription?.gatewayStats;
      const track = feed.video.srcObject?.getVideoTracks()[0];
      const received = rtc.find(stat => stat.type === 'inbound-rtp' && stat.kind === 'video' && stat.trackIdentifier === track?.id);
      const counters = {shown: watch.shown, input: stats?.stats?.received, sent: stats?.stats?.sent, decoded: received?.framesDecoded, received: received?.framesReceived,
        jitterDelay: received?.jitterBufferDelay, jitterCount: received?.jitterBufferEmittedCount, decodeTime: received?.totalDecodeTime};
      const sameReceiver = previous?.receiver === received?.id;
      const delta = name => sameReceiver && previous && counters[name] >= previous[name] ? counters[name] - previous[name] : null;
      const jitterCount = delta('jitterCount'), decoded = delta('decoded');
      const sameSubscription = previous?.subscription === stats?.id;
      this.previous.set(feed.key, {...counters, receiver: received?.id, subscription: stats?.id});
      const latency = feed.subscription?.videoLatency?.(10000) ?? null;
      return {key: feed.key, width: feed.video.videoWidth, height: feed.video.videoHeight,
        // Measure this stream's input directly; the optional topic counter may be absent or stale.
        sourceFps: sameSubscription ? rate(previous?.input, counters.input, seconds) : null,
        sentFps: sameSubscription ? rate(previous?.sent, counters.sent, seconds) : null,
        receivedFps: sameReceiver ? rate(previous?.received, counters.received, seconds) : null,
        decodedFps: sameReceiver ? rate(previous?.decoded, counters.decoded, seconds) : null,
        displayedFps: watch.handle === null ? null : rate(previous?.shown, counters.shown, seconds),
        lastDisplayedAgoMs: watch.lastShown === null ? null : Math.max(0, now - watch.lastShown),
        jitterBufferMs: jitterCount > 0 ? 1000 * delta('jitterDelay') / jitterCount : null,
        decodeMs: decoded > 0 ? 1000 * delta('decodeTime') / decoded : watch.decodeMs ?? null,
        playback: fields(feed.video.getVideoPlaybackQuality?.(), ['totalVideoFrames', 'droppedVideoFrames']),
        receiver: fields(received, ['framesReceived', 'framesDecoded', 'framesDropped', 'packetsLost', 'jitter', 'freezeCount', 'totalFreezesDuration', 'pliCount', 'nackCount', 'decoderImplementation']),
        gateway: stats, latency};
    });
    const intervals = this.intervals.splice(0), elapsed = intervals.reduce((sum, value) => sum + value, 0);
    const controls = app.controls, xr = controls?.xr;
    return {clientId: this.id, at: Date.now(), userAgent: navigator.userAgent, immersive: !!app.xr.presenting,
      visibility: document.visibilityState, runId: app.blueprint.runId, connection: app.bus.state,
      teleop: xr ? {
        armed: controls.armed, enabled: xr.enabled, busy: xr.busy, mode: xr.mode, error: xr.error,
        lease: fields(controls.lease, ['status', 'reason']),
        sessionVisibility: app.xr.session?.visibilityState ?? null,
        frameAgeMs: Number.isFinite(xr.lastFrame) ? Math.max(0, now - xr.lastFrame) : null,
        inputs: [...(app.xr.session?.inputSources || [])].map(input => ({
          side: input.handedness, hand: !!input.hand, grip: !!input.gripSpace,
          ray: input.targetRayMode, profiles: [...(input.profiles || [])],
        })),
        hands: Object.fromEntries(Object.entries(xr.hands).map(([side, hand]) =>
          [side, fields(hand, ['tracked', 'engaged', 'released', 'reason', 'published'])])),
        calibration: {active: xr.calibration.status?.active ?? false, selected: xr.calibration.selected,
          capturing: xr.calibrating, error: xr.calibration.error, readError: xr.calibration.readError},
        publishers: [...controls.publishers].map(([key, {publisher}]) => ({key,
          state: publisher.state, blocked: publisher.blocked, channel: publisher.channel?.readyState,
          queuedBytes: publisher.channel?.bufferedAmount,
        })),
      } : null,
      display: {fps: elapsed > 0 ? intervals.length * 1000 / elapsed : null, frameMsP95: percentile(intervals, 0.95)},
      streams: Object.values(client?.stats || {}).map(entry => entry.gateway).filter(Boolean).map(stream => ({
        key: stream.key, type: stream.type, channel: stream.opts?.channel, encoding: stream.opts?.encoding,
        maxHz: stream.opts?.maxHz, bandwidthPriority: stream.opts?.bandwidthPriority, allocation: stream.allocation,
        stats: fields(stream.stats, ['received', 'sent', 'bytesSent', 'queuedBytes', 'blockedMs', 'encodingErrors']),
      })),
      link: {rttMs: client?.rttMs ?? null, gateway: client?.gatewayStats ?? null,
        pair: fields(pair, ['currentRoundTripTime', 'availableIncomingBitrate', 'availableOutgoingBitrate', 'bytesReceived', 'bytesSent']),
        local: fields(rtc.find(stat => stat.id === pair?.localCandidateId), ['candidateType', 'protocol', 'relayProtocol']),
        remote: fields(rtc.find(stat => stat.id === pair?.remoteCandidateId), ['candidateType', 'protocol'])},
      cameras: cameraReports};
  }

  async sample() {
    try {
      this.latest = await this.collect();
      const result = await gateway.reportDiagnostics(this.latest);
      this.clients = result.clients; this.error = null;
    } catch (error) { this.error = error.message; }
    this.dispatchEvent(new Event('change'));
    if (!this.stopped) this.timer = setTimeout(() => this.sample(), 2000);
  }

  stop() {
    this.stopped = true; clearTimeout(this.timer);
    for (const [feed, watch] of this.watches) this.unwatch(feed, watch);
  }
}
