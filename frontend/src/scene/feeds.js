// Camera streams as textures. The zenoh-gateway turns a sensor_msgs.Image into an H.264 track (encoded
// on the machine's media engine), so a feed is a <video> the GPU decodes: one subscription per topic,
// shared by the 3D surface, the frustum and any panel that shows the same camera.
import * as THREE from 'three';

export class Feeds {
  constructor(bus) { this.bus = bus; this.feeds = new Map(); }

  // topic: {key, type}. Call release(feed) when done.
  acquire(topic) {
    let feed = this.feeds.get(topic.key);
    if (feed) { feed.users++; return feed; }
    const video = document.createElement('video');
    video.muted = true; video.playsInline = true; video.autoplay = true;
    const texture = new THREE.VideoTexture(video);
    texture.colorSpace = THREE.SRGBColorSpace; texture.generateMipmaps = false; texture.minFilter = THREE.LinearFilter;
    feed = {key: topic.key, video, texture, users: 1, frameId: '', lastAt: 0, width: 0, height: 0, error: null};
    const encoding = topic.type === 'sensor_msgs.CompressedImage' ? 'dimos_lcm_compressed_image' : 'dimos_lcm_image';
    // Bound each camera's bandwidth demand instead of letting full-resolution
    // sources request tens of Mb/s. Keep their pixels; adapt compression first.
    feed.subscription = this.bus.subscribe(topic.key, {
      delivery: 'latest', encoding, maxBitrate: 5_000_000, minResolutionScale: 1,
    }, message => {
      if (message.mediaStream && video.srcObject !== message.mediaStream) { video.srcObject = message.mediaStream; video.play().catch(() => {}); }
      if (message.header?.frameId) feed.frameId = message.header.frameId;
      feed.lastAt = performance.now();
      if (video.videoWidth) { feed.width = video.videoWidth; feed.height = video.videoHeight; }
    });
    feed.subscription.ready?.().catch(error => { feed.error = error.message; });
    this.feeds.set(topic.key, feed);
    return feed;
  }

  release(feed) {
    if (!feed || --feed.users > 0) return;
    feed.subscription.close?.(); feed.video.srcObject = null; feed.texture.dispose();
    this.feeds.delete(feed.key);
  }
}
