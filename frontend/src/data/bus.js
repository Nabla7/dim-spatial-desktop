// The live side: dimos streams over Desktop's zenoh-gateway (WebRTC, one channel per subscription).
// Desktop serves the client and says where it is; the page is recognised by its URL under /apps/<name>/,
// so there is no token to hold. Messages are LCM; the dimos gateway's msgs.js decodes them.
import {gateway} from './gateway.js';

// "dimos/color_image/sensor_msgs.Image" -> {topic: "/color_image", type: "sensor_msgs.Image"}.
// A stream of a plain Python value (a str, a pydantic model) has no type part: its key is "dimos/<topic>".
export function parseKey(key) {
  const parts = String(key || '').split('/'), last = parts[parts.length - 1];
  const typed = /^[a-z0-9_]+\.[A-Za-z0-9_]+$/.test(last) && parts.length > 2;
  // Hosted runs add their domain before the topic. Keep it in the transport key,
  // but don't let a long run ID hide every camera's name in the panels.
  const topicStart = parts[0] === 'dimos-domains' ? 2 : 1;
  return {key, topic: '/' + parts.slice(topicStart, typed ? -1 : undefined).join('/'), type: typed ? last : null};
}

// "dimos.msgs.sensor_msgs.Image.Image" (a Python class path) -> "sensor_msgs.Image".
export function shortType(type) {
  const parts = String(type || '').split('.');
  if (parts.length >= 3 && parts[parts.length - 1] === parts[parts.length - 2]) return `${parts[parts.length - 3]}.${parts[parts.length - 1]}`;
  return parts.slice(-2).join('.');
}

// files.File is hand-written in dimos: little-endian f64 timestamp, u32 uri length, the uri, then the bytes.
export function decodeFile(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), length = view.getUint32(8, true);
  return {ts: view.getFloat64(0, true), uri: new TextDecoder().decode(bytes.subarray(12, 12 + length)), data: bytes.subarray(12 + length)};
}

export class Bus extends EventTarget {
  constructor() {
    super();
    this.state = 'connecting'; this.error = null; this.client = null; this.msgs = null; this.info = null;
    this.ready = this.open();
  }

  async open() {
    try {
      this.info = await gateway.zenoh();
      if (!this.info.enabled || !this.info.up) throw new Error(this.info.error || 'the zenoh gateway is off (Desktop: Settings)');
      const [{connect}, msgs] = await Promise.all([
        import(new URL(this.info.client, location.href).href),
        import(new URL('../../gateways/dimos/msgs.js', location.href).href),
      ]);
      this.msgs = msgs;
      // The heartbeat is what a publisher's deadman hangs on: if this page stops (a crash, a dead link),
      // the gateway publishes the stored stop value for every drive it had armed.
      this.client = await connect(new URL(this.info.zenohGatewayUrl, location.href).href, {heartbeatHz: 5, heartbeatMisses: 3});
      this.state = this.client.state;
      this.client.onState(state => { this.state = state; this.dispatchEvent(new Event('state')); });
      this.dispatchEvent(new Event('state'));
    } catch (error) {
      this.state = 'failed'; this.error = error.message || String(error);
      console.error('zenoh:', error);
      this.dispatchEvent(new Event('state'));
    }
    return this;
  }

  get live() { return !!this.client && (this.state === 'connected' || this.state === 'degraded'); }
  get rtt() { return this.client?.rttMs ?? null; }

  // callback(message): message.bytes always; message.decoded / mediaStream / header by the encoding asked for.
  subscribe(key, options, callback) {
    if (!this.client) return {close() {}, ready: async () => {}};
    return this.client.subscribe(key, options, callback);
  }

  // A stream decoded with msgs.js; callback(value, message). Types msgs.js lacks are skipped.
  subscribeDecoded(key, options, callback) {
    return this.subscribe(key, options, message => {
      let value;
      try { value = this.msgs.decodeMessage(message); } catch { return; }
      if (value !== undefined) callback(value, message);
    });
  }

  // JSON events: Desktop's and the dimos gateway's (launch phases, settings, apps).
  subscribeEvents(scope, callback) {
    const prefix = this.info?.[scope];
    if (!prefix) return {close() {}};
    const decoder = new TextDecoder();
    return this.subscribe(`${prefix}/events/**`, {delivery: 'reliable'}, message => {
      try { callback(JSON.parse(decoder.decode(message.bytes))); } catch { /* not JSON: not an event */ }
    });
  }

  publisher(key, options = {}) { return this.client.publisher(key, options); }

  type(name) { try { return this.msgs?.lookup(name) ?? null; } catch { return null; } }
  knows(name) { return !!name && !!this.msgs?.getTypeNames().includes(name); }
}
