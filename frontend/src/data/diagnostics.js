import {gateway} from './gateway.js';
import {TraceUpload} from './trace-upload.js';

export function rate(previous, current, seconds) {
  return Number.isFinite(previous) && Number.isFinite(current) && current >= previous && seconds > 0 ? (current - previous) / seconds : null;
}

const fields = (value, names) => Object.fromEntries(names.filter(name => value?.[name] !== undefined).map(name => [name, value[name]]));
const percentile = (values, fraction) => values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))] : null;

// A browser stats promise is not cancellable. Keep one outstanding request per peer,
// and bound how long reporting waits for it; a stuck stats call cannot stop telemetry.
export async function withDeadline(promise, milliseconds) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('RTC stats timed out')), milliseconds);
  })]); } finally { clearTimeout(timer); }
}

// Keep each tab separate: a fast laptop must never overwrite a slow headset's measurements.
// Sampling and uploads run outside the XR animation callback, with at most one request in flight.
export class Diagnostics extends EventTarget {
  constructor(app) {
    super(); this.app = app; this.id = crypto.randomUUID(); this.clients = []; this.latest = null;
    this.watches = new Map(); this.previous = new Map(); this.intervals = []; this.lastFrame = null;
    this.lastSample = performance.now(); this.stopped = false; this.generation = 0;
    this.timer = setTimeout(() => this.sample(), 2000);
    this.traceUpload = new TraceUpload(gateway.reportTrace);
    this.traceTimer = setTimeout(() => this.traceSample(), 250);
    addEventListener('pagehide', () => this.stop());
    addEventListener('pageshow', () => {
      if (!this.stopped) return;
      this.stopped = false; this.lastFrame = null; this.intervals = []; this.lastSample = performance.now();
      this.timer = setTimeout(() => this.sample(), 2000);
      this.traceTimer = setTimeout(() => this.traceSample(), 250);
    });
  }

  frame(now) {
    this.app.bus.trace?.tick();
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
        watch.lastRtp = metadata.rtpTimestamp;
        watch.shown++; watch.lastShown = now; watch.decodeMs = metadata.processingDuration == null ? null : metadata.processingDuration * 1000;
        watch.handle = feed.video.requestVideoFrameCallback(shown);
      };
      watch.handle = feed.video.requestVideoFrameCallback(shown);
    }
    const previousUpdate = feed.texture.onUpdate;
    watch.previousUpdate = previousUpdate;
    feed.texture.onUpdate = (...args) => {
      previousUpdate?.(...args);
      watch.textureRtp = watch.lastRtp;
      watch.textureUpdated = true;
      feed.subscription?.traceVideoFrame?.(watch.textureRtp, 'video.texture_upload', {correlation_basis: 'latest_presented_frame', physical_display: false});
    };
    this.watches.set(feed, watch);
    return watch;
  }

  unwatch(feed, watch) {
    watch.stopLatency?.();
    this.app?.bus?.trace?.unwatch(`video/${feed.key}`);
    for (const stage of ['video.texture_upload', 'video.render_submit', 'video.xr_submit']) this.app?.bus?.trace?.unwatch(`${stage}/${feed.key}`);
    if (feed.texture) feed.texture.onUpdate = watch.previousUpdate;
    if (watch.handle !== null) feed.video.cancelVideoFrameCallback(watch.handle);
    this.watches.delete(feed); this.previous.delete(feed.key);
  }

  async rtcSnapshot(peer, deadlineMs = 750) {
    if (!peer?.getStats) { this.rtcStatus = {state: 'unavailable'}; return []; }
    if (!this.rtcTask || this.rtcTask.peer !== peer || this.rtcTask.settled) {
      const task = {peer, started: performance.now(), settled: false};
      task.promise = Promise.resolve().then(() => peer.getStats()).then(stats => [...stats.values()]);
      task.promise.then(() => { task.settled = true; }, () => { task.settled = true; });
      this.rtcTask = task;
    }
    try {
      const rtc = await withDeadline(this.rtcTask.promise, deadlineMs);
      this.rtcStatus = {state: 'fresh', durationMs: performance.now() - this.rtcTask.started};
      return rtc;
    } catch (error) {
      this.rtcStatus = {state: 'unavailable', error: error.message, pendingMs: performance.now() - this.rtcTask.started};
      return [];
    }
  }

  async collect() {
    const app = this.app, client = app.bus.client;
    const rtc = await this.rtcSnapshot(client?._peer);
    const now = performance.now(), seconds = (now - this.lastSample) / 1000;
    this.lastSample = now;
    const feeds = [...app.layers.feeds.feeds.values()];
    for (const [feed, watch] of this.watches) if (!feeds.includes(feed)) this.unwatch(feed, watch);
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
      collector: {version: 'r1diag1', rtc: this.rtcStatus, previousUpload: this.uploadStatus ?? null},
      visibility: document.visibilityState, runId: app.blueprint.runId, connection: app.bus.state,
      teleop: xr ? {
        armed: controls.armed, enabled: xr.enabled, busy: xr.busy, startupStage: xr.startupStage, mode: xr.mode, error: xr.error,
        trace: xr.trace ?? null, lastStop: xr.lastStop ?? null,
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
        publishers: [...controls.publishers].map(([key, {publisher, metrics}]) => ({key, metrics,
          state: publisher.state, blocked: publisher.blocked, channel: publisher.channel?.readyState,
          queuedBytes: publisher.channel?.bufferedAmount,
          lifetimeMs: publisher.channel?.maxPacketLifeTime, ordered: publisher.channel?.ordered,
          sent: publisher.sent, dropped: publisher.dropped, attempted: publisher.attempted,
          lastSentAtMs: publisher.lastSentAtMs, lastAttemptAtMs: publisher.lastAttemptAtMs, maxSendGapMs: publisher.maxSendGapMs,
          gateway: publisher.gatewayStats?.stats,
        })),
      } : null,
      display: {fps: elapsed > 0 ? intervals.length * 1000 / elapsed : null, frameMsP95: percentile(intervals, 0.95)},
      streams: Object.values(client?.stats || {}).map(entry => entry.gateway).filter(Boolean).map(stream => ({
        key: stream.key, type: stream.type, channel: stream.opts?.channel, encoding: stream.opts?.encoding,
        maxHz: stream.opts?.maxHz, bandwidthPriority: stream.opts?.bandwidthPriority, allocation: stream.allocation,
        stats: fields(stream.stats, ['received', 'sent', 'bytesSent', 'queuedBytes', 'blockedMs', 'encodingErrors']),
      })),
      link: {rttMs: client?.rttMs ?? null, gateway: client?.gatewayStats ?? null,
        pair: fields(pair, ['id', 'state', 'localCandidateId', 'remoteCandidateId', 'currentRoundTripTime', 'availableIncomingBitrate', 'availableOutgoingBitrate', 'bytesReceived', 'bytesSent', 'packetsReceived', 'packetsSent', 'responsesReceived', 'requestsSent']),
        local: fields(rtc.find(stat => stat.id === pair?.localCandidateId), ['id', 'candidateType', 'protocol', 'relayProtocol', 'address', 'ip', 'port', 'networkType', 'url']),
        remote: fields(rtc.find(stat => stat.id === pair?.remoteCandidateId), ['id', 'candidateType', 'protocol', 'address', 'ip', 'port'])},
      cameras: cameraReports};
  }

  submitted(immersive) {
    const trace = this.app.bus.trace;
    if (!trace) return;
    for (const [feed, watch] of this.watches) {
      // A texture update proves the renderer used the texture this frame. Do not
      // count every watched/hidden panel as an XR submission on every display tick.
      if (!watch.textureUpdated) continue;
      watch.textureUpdated = false;
      feed.subscription.traceVideoFrame?.(watch.textureRtp, immersive ? 'video.xr_submit' : 'video.render_submit', {physical_display: false, correlation_basis:'latest_uploaded_frame'});
    }
  }

  async traceSample() {
    const generation = this.generation;
    this.app.bus.trace?.tick();
    try { await this.traceUpload.flush(this.app.bus.trace); this.traceError = null; }
    catch (error) { this.traceError = error.message; }
    if (!this.stopped && generation === this.generation) this.traceTimer = setTimeout(() => this.traceSample(), 250);
  }

  async sample() {
    const generation = this.generation;
    try {
      this.latest = await this.collect();
      if (this.stopped || generation !== this.generation) return;
      const began = performance.now();
      try {
        const result = await gateway.reportDiagnostics(this.latest);
        this.uploadStatus = {at: Date.now(), roundTripMs: performance.now() - began, ok: true};
        this.clients = result.clients; this.error = null;
      } catch (error) {
        this.uploadStatus = {at: Date.now(), roundTripMs: performance.now() - began, ok: false, error: error.message};
        throw error;
      }
    } catch (error) { this.error = error.message; }
    this.dispatchEvent(new Event('change'));
    if (!this.stopped && generation === this.generation) this.timer = setTimeout(() => this.sample(), 2000);
  }

  stop() {
    this.stopped = true; this.generation++; clearTimeout(this.timer);
    clearTimeout(this.traceTimer);
    for (const [feed, watch] of this.watches) this.unwatch(feed, watch);
  }
}
