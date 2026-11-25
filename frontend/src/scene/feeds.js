// One WebRTC subscription, video element and texture per topic, shared by screens and 3D surfaces.
// Lifecycle and view/preview policy follow dimensionalOS/dim-controller's VideoSources.
import * as THREE from 'three';
import {VIDEO_PRESETS, videoOptions, optionChanges, needsNewReceiver} from './video-policy.js';

const QUALITY_KEY = 'spatial.video.quality';

export class Feeds {
  constructor(bus, {document: doc = globalThis.document, storage} = {}) {
    if (storage === undefined) { try { storage = globalThis.localStorage; } catch { /* private mode */ } }
    this.bus = bus; this.feeds = new Map(); this.document = doc; this.storage = storage;
    this.main = null; this.interactive = false; this.xrVisible = null;
    this.hidden = !!doc?.hidden;
    try { this.qualities = JSON.parse(storage?.getItem(QUALITY_KEY) || '{}') || {}; } catch { this.qualities = {}; }
    this.onVisibility = () => this.refreshVisibility();
    doc?.addEventListener('visibilitychange', this.onVisibility);
  }

  acquire(topic, use = 'view') {
    if (!['view', 'preview'].includes(use)) throw new Error(`Unknown camera use: ${use}`);
    let feed = this.feeds.get(topic.key);
    if (!feed) {
      const video = this.document.createElement('video');
      video.muted = true; video.playsInline = true; video.autoplay = true;
      const texture = new THREE.VideoTexture(video);
      texture.colorSpace = THREE.SRGBColorSpace; texture.generateMipmaps = false; texture.minFilter = THREE.LinearFilter;
      feed = {key: topic.key, topic, video, texture, users: 0, uses: {view: 0, preview: 0}, options: {},
        quality: VIDEO_PRESETS[this.qualities[topic.key]] ? this.qualities[topic.key] : 'balanced',
        frameId: '', lastAt: 0, width: 0, height: 0, error: null, subscription: null, generation: 0};
      this.feeds.set(topic.key, feed);
    }
    feed.users++; feed.uses[use]++;
    if (use === 'view' && this.main === null) this.setMain(topic.key);
    this.retune(feed);
    return feed;
  }

  wanted(feed) { return videoOptions(feed.uses, feed.quality, feed.key === this.main, this.interactive); }

  open(feed, options) {
    if (this.hidden || !feed.users) return;
    feed.options = options; feed.error = null;
    const generation = ++feed.generation;
    const encoding = feed.topic.type === 'foxglove_msgs.CompressedVideo' ? 'dimos_lcm_compressed_video'
      : feed.topic.type === 'sensor_msgs.CompressedImage' ? 'dimos_lcm_compressed_image' : 'dimos_lcm_image';
    const subscription = this.bus.subscribe(feed.key, {delivery: 'latest', encoding, ...options}, message => {
      if (feed.generation !== generation) return;
      if (message.mediaStream && feed.video.srcObject !== message.mediaStream) {
        feed.video.srcObject = message.mediaStream; feed.video.play().catch(() => {});
      }
      if (message.header?.frameId) feed.frameId = message.header.frameId;
      feed.lastAt = performance.now();
      feed.width = message.video?.width || feed.video.videoWidth || feed.width;
      feed.height = message.video?.height || feed.video.videoHeight || feed.height;
    });
    feed.subscription = subscription;
    subscription.ready?.().catch(error => { if (feed.generation === generation) feed.error = error.message; });
  }

  close(feed) {
    feed.generation++;
    feed.subscription?.close?.(); feed.subscription = null;
    feed.video.pause(); feed.video.srcObject = null; feed.lastAt = 0;
  }

  retune(feed) {
    if (this.hidden || !feed.users) return;
    const before = feed.options, wanted = this.wanted(feed), subscription = feed.subscription;
    if (!subscription) return this.open(feed, wanted);
    if (JSON.stringify(before) === JSON.stringify(wanted)) return;
    feed.options = wanted;
    const reopen = () => {
      if (feed.subscription !== subscription || feed.options !== wanted || !feed.users || this.hidden) return;
      this.close(feed); this.open(feed, wanted);
    };
    if (!subscription.update || needsNewReceiver(before, wanted)) return reopen();
    Promise.resolve(subscription.update(optionChanges(before, wanted))).catch(reopen);
  }

  setMain(key) {
    if (this.main === key) return;
    const previous = this.main; this.main = key;
    for (const changed of [previous, key]) { const feed = this.feeds.get(changed); if (feed) this.retune(feed); }
  }

  setQuality(feed, quality) {
    if (!VIDEO_PRESETS[quality] || feed.quality === quality) return;
    feed.quality = quality; this.qualities[feed.key] = quality;
    try { this.storage?.setItem(QUALITY_KEY, JSON.stringify(this.qualities)); } catch { /* private mode */ }
    this.retune(feed);
  }

  setInteractive(on) {
    if (this.interactive === !!on) return;
    this.interactive = !!on;
    for (const feed of this.feeds.values()) this.retune(feed);
  }

  // An immersive session's visibility is authoritative: its DOM page can be hidden while XR is visible.
  setXrVisibility(visible) { this.xrVisible = visible; this.refreshVisibility(); }

  refreshVisibility() {
    const hidden = this.xrVisible === null ? !!this.document?.hidden : !this.xrVisible;
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    for (const feed of this.feeds.values()) {
      if (hidden) this.close(feed); else this.retune(feed);
    }
  }

  release(feed, use = 'view') {
    if (!feed || !feed.uses[use]) return;
    feed.uses[use]--; feed.users--;
    if (feed.key === this.main && !feed.uses.view) {
      this.setMain([...this.feeds.values()].find(other => other !== feed && other.uses.view)?.key || null);
    }
    if (feed.users) return this.retune(feed);
    this.close(feed); feed.texture.dispose(); this.feeds.delete(feed.key);
  }

  dispose() {
    this.document?.removeEventListener('visibilitychange', this.onVisibility);
    for (const feed of this.feeds.values()) { this.close(feed); feed.texture.dispose(); }
    this.feeds.clear();
  }
}
