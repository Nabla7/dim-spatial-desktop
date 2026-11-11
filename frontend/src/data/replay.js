// Replay: recorded episodes instead of the live blueprint. The server finds datasets on this machine and
// reads an episode's frames, images and world (server/replay.ts). This is the page's side of it: which
// episode is open, where the playhead is, and the images around the playhead. It knows no robot and no
// file format: an episode arrives as a clock with named cameras, signals, bands, checks and facts.
import {gateway} from './gateway.js';

const BATCH = 48;      // images asked for in one request
const DECODED = 96;    // decoded images kept per camera
const REQUESTS = 2;    // image requests in flight at once

// One camera of the open episode: every frame's picture as it was stored, decoded when the playhead needs it.
class Pictures {
  constructor(name, count, width, height) {
    this.name = name; this.width = width; this.height = height;
    this.blobs = new Array(count).fill(null); this.bitmaps = new Map(); this.decoding = new Set(); this.asked = new Set();
    // What this camera shows now, for a panel and for a screen in the scene. `shown` is the frame on it.
    this.canvas = document.createElement('canvas'); this.canvas.width = width || 320; this.canvas.height = height || 240;
    this.shown = -1; this.version = 0; this.loaded = 0;
  }

  dispose() { for (const bitmap of this.bitmaps.values()) bitmap.close?.(); this.bitmaps.clear(); this.blobs = []; }
}

export class Replay extends EventTarget {
  constructor(app) {
    super();
    this.app = app;
    this.datasets = null; this.dataset = null; this.rows = []; this.error = ''; this.loading = null; this.busy = false;
    this.recording = null; this.name = null; this.times = new Float64Array(0); this.pictures = [];
    this.time = 0; this.frame = 0; this.playing = false; this.scrubbing = false; this.speed = 1; this.loop = false;
    this.world = {state: 'none', note: ''}; this.shapes = null; this.motion = null;
    this.audit = null; this.token = 0; this.requests = 0;
    addEventListener('keydown', event => this.key(event));
  }

  get active() { return !!this.recording; }
  get start() { return this.times.length ? this.times[0] : 0; }
  get end() { return this.times.length ? this.times[this.times.length - 1] : 0; }
  emit(type = 'change') { this.dispatchEvent(new Event(type)); }

  remember() { try { localStorage.setItem('spatial.replay', JSON.stringify({dataset: this.dataset?.id ?? null, episode: this.name})); } catch { /* private mode */ } }
  remembered() { try { return JSON.parse(localStorage.getItem('spatial.replay') || '{}'); } catch { return {}; } }

  // -- what there is to play ----------------------------------------------------------------------------
  async refresh(rescan = false) {
    this.busy = true; this.emit();
    try {
      this.datasets = (await gateway.replay.datasets(rescan)).datasets; this.error = '';
      const wanted = this.dataset?.id ?? this.remembered().dataset;
      // The one that was open last, else the one that got an episode most recently.
      const dataset = this.datasets.find(entry => entry.id === wanted) ?? [...this.datasets].sort((a, b) => b.at - a.at)[0] ?? null;
      if (dataset) await this.choose(dataset.id); else { this.dataset = null; this.rows = []; }
    } catch (error) { this.error = error.message; this.datasets ??= []; }
    this.busy = false; this.emit();
  }

  async choose(id) {
    const dataset = this.datasets?.find(entry => entry.id === id);
    if (!dataset) return;
    const changed = this.dataset?.id !== id;
    this.dataset = dataset; if (changed) { this.rows = []; this.audit = null; }
    this.busy = true; this.emit();
    try {
      this.rows = (await gateway.replay.episodes(id)).episodes; this.error = '';
      if (changed) gateway.replay.audit(id).then(audit => { if (this.dataset?.id === id) { this.audit = audit; this.emit(); } }).catch(() => {});
    } catch (error) { this.error = error.message; }
    this.busy = false; this.remember(); this.emit();
  }

  async addFolder(path) {
    const before = new Set((this.datasets || []).map(entry => entry.id));
    this.datasets = (await gateway.replay.add(path)).datasets;
    const added = this.datasets.find(entry => !before.has(entry.id));
    if (added) await this.choose(added.id); else this.emit();
  }

  row(name = this.name) { return this.rows.find(row => row.name === name) || null; }

  // -- one episode --------------------------------------------------------------------------------------
  async open(name) {
    if (!this.dataset || this.loading === name) return;
    const token = ++this.token, dataset = this.dataset.id;
    this.loading = name; this.error = ''; this.emit();
    try {
      const recording = await gateway.replay.episode(dataset, name);
      if (token !== this.token) return;
      this.unload();
      this.recording = recording; this.name = name; this.times = Float64Array.from(recording.times);
      this.pictures = recording.cameras.map(camera => new Pictures(camera.name, recording.count, camera.width, camera.height));
      this.time = this.start; this.frame = 0; this.playing = false;
      this.remember(); this.emit('open'); this.emit('frame');
      this.loadWorld(token);
    } catch (error) { if (token === this.token) this.error = error.message; }
    if (token === this.token) { this.loading = null; this.emit(); }
  }

  // The shapes of the episode's world and where each body was. Shapes are the same from episode to episode
  // of one workcell, so the server is told which ones this page already holds.
  async loadWorld(token) {
    const recording = this.recording, dataset = recording.dataset, name = this.name;
    if (!recording.world.model) { this.world = {state: 'none', note: recording.world.note || 'This episode has no world to show.'}; this.emit('world'); return; }
    this.world = {state: 'loading', note: ''}; this.emit();
    try {
      const [shapes, motion] = await Promise.all([gateway.replay.scene(dataset, name, this.shapes?.meta.key), gateway.replay.motion(dataset, name)]);
      if (token !== this.token) return;
      if (shapes.meta.sent) {
        const floats = shapes.meta.faces_at / 4;
        this.shapes = {meta: shapes.meta, vertices: new Float32Array(shapes.buffer, shapes.offset, floats), faces: new Uint32Array(shapes.buffer, shapes.offset + shapes.meta.faces_at)};
      } else this.shapes = {...this.shapes, meta: shapes.meta, same: true};
      const meta = motion.meta, values = meta.count * meta.bodies * 7;
      this.motion = {
        meta, times: Float64Array.from(meta.times), poses: new Float32Array(motion.buffer, motion.offset, values),
        ghost: meta.ghost_at == null ? null : new Float32Array(motion.buffer, motion.offset + meta.ghost_at, recording.count * meta.bodies * 7),
      };
      // What the world adds to the episode: checks of the frames against it, and the paths of its objects.
      recording.checks = recording.checks.filter(check => !check.id.startsWith('scene:')).concat(meta.checks);
      recording.signals = recording.signals.filter(signal => signal.group !== 'scene').concat(meta.signals);
      this.world = {state: 'ready', source: meta.source, note: ''};
    } catch (error) {
      if (token !== this.token) return;
      this.world = {state: 'failed', note: error.message}; this.motion = null;
    }
    this.emit('world'); this.emit();
  }

  unload() {
    for (const pictures of this.pictures) pictures.dispose();
    this.pictures = []; this.recording = null; this.name = null; this.times = new Float64Array(0); this.motion = null;
    this.playing = false; this.world = {state: 'none', note: ''};
  }

  close() { this.token++; this.loading = null; this.unload(); this.remember(); this.emit('close'); this.emit(); }

  // The episode after or before the open one, in the order they were made.
  neighbour(step) {
    const index = this.rows.findIndex(row => row.name === this.name), next = this.rows[index + step];
    if (index >= 0 && next) this.open(next.name);
  }

  // -- the playhead -------------------------------------------------------------------------------------
  frameAt(time) {
    const times = this.times;
    let low = 0, high = times.length - 1;
    while (low < high) { const mid = (low + high + 1) >> 1; if (times[mid] <= time + 1e-9) low = mid; else high = mid - 1; }
    return low;
  }

  seek(time) {
    if (!this.active) return;
    this.time = Math.max(this.start, Math.min(this.end, time));
    const frame = this.frameAt(this.time);
    this.emit('seek');
    if (frame !== this.frame) { this.frame = frame; this.emit('frame'); }
  }

  step(frames) { if (this.active) { this.playing = false; this.seek(this.times[Math.max(0, Math.min(this.times.length - 1, this.frame + frames))]); this.emit(); } }
  toggle() { if (!this.active) return; if (!this.playing && this.time >= this.end - 1e-6) this.seek(this.start); this.playing = !this.playing; this.emit(); }
  setSpeed(speed) { this.speed = speed; this.emit(); }

  key(event) {
    if (!this.active || this.app.text.active || this.app.controls.armed || event.metaKey || event.ctrlKey || event.altKey) return;
    const jump = event.shiftKey ? Math.round(this.recording.fps) : 1;
    if (event.code === 'Space') this.toggle();
    else if (event.code === 'ArrowRight') this.step(jump);
    else if (event.code === 'ArrowLeft') this.step(-jump);
    else if (event.code === 'Home') this.seek(this.start);
    else if (event.code === 'End') this.seek(this.end);
    else return;
    event.preventDefault();
  }

  tick(now, dt) {
    if (!this.active) return;
    if (this.playing && !this.scrubbing) {
      let time = this.time + dt * this.speed;
      if (time >= this.end) { if (this.loop) time = this.start; else { time = this.end; this.playing = false; this.emit(); } }
      this.seek(time);
    }
    this.feed();
  }

  // -- pictures -----------------------------------------------------------------------------------------
  // Keep each camera's canvas on the playhead's frame, and fetch what the playhead will need next: the
  // batch it is in first, then the ones after it, then the rest of the episode.
  feed() {
    for (const pictures of this.pictures) {
      const frame = this.frame;
      if (pictures.shown !== frame) {
        const bitmap = pictures.bitmaps.get(frame);
        if (bitmap) {
          pictures.bitmaps.delete(frame); pictures.bitmaps.set(frame, bitmap);   // most recently used last
          pictures.canvas.getContext('2d').drawImage(bitmap, 0, 0, pictures.canvas.width, pictures.canvas.height);
          pictures.shown = frame; pictures.version++; this.emit('picture');
        } else this.decode(pictures, frame);
      }
      if (this.playing) for (let ahead = 1; ahead <= 3; ahead++) if (frame + ahead < pictures.blobs.length) this.decode(pictures, frame + ahead);
      if (this.requests >= REQUESTS) continue;
      const count = pictures.blobs.length, first = Math.floor(frame / BATCH) * BATCH;
      for (let offset = 0; offset < count; offset += BATCH) {
        const start = (first + offset) % (Math.ceil(count / BATCH) * BATCH);
        if (start < count && !pictures.asked.has(start)) { this.loadPictures(pictures, start); break; }
      }
    }
  }

  async loadPictures(pictures, start) {
    const token = this.token, dataset = this.recording.dataset, name = this.name;
    pictures.asked.add(start); this.requests++;
    try {
      const {meta, buffer, offset} = await gateway.replay.images(dataset, name, pictures.name, start, BATCH);
      if (token !== this.token) return;
      let at = offset;
      meta.sizes.forEach((size, index) => {
        if (size) pictures.blobs[meta.start + index] = new Blob([new Uint8Array(buffer, at, size)], {type: meta.type});
        at += size;
      });
      pictures.loaded += meta.sizes.length; this.emit('picture');
    } catch (error) {
      // Asked again on a later tick, a little later.
      if (token === this.token) setTimeout(() => pictures.asked.delete(start), 2000);
      console.debug(`replay pictures ${pictures.name} from ${start}:`, error.message);
    } finally { this.requests--; }
  }

  decode(pictures, frame) {
    const blob = pictures.blobs[frame];
    if (!blob || pictures.bitmaps.has(frame) || pictures.decoding.has(frame) || pictures.decoding.size >= 4) return;
    const token = this.token;
    pictures.decoding.add(frame);
    createImageBitmap(blob).then(bitmap => {
      pictures.decoding.delete(frame);
      if (token !== this.token) { bitmap.close?.(); return; }
      pictures.bitmaps.set(frame, bitmap);
      while (pictures.bitmaps.size > DECODED) { const [oldest, old] = pictures.bitmaps.entries().next().value; pictures.bitmaps.delete(oldest); old.close?.(); }
    }).catch(() => pictures.decoding.delete(frame));
  }

  // -- a world that was not saved: run the physics again -------------------------------------------------
  async recover() {
    const dataset = this.recording?.dataset, name = this.name, token = this.token;
    if (!name) return;
    try {
      this.recording.world.job = (await gateway.replay.recover(dataset, name)).job; this.emit();
      while (token === this.token && this.recording.world.job?.state === 'running') {
        await new Promise(resolve => setTimeout(resolve, 1500));
        const job = (await gateway.replay.recovery(dataset, name)).job;
        if (token !== this.token) return;
        this.recording.world.job = job; this.emit();
      }
      if (token !== this.token) return;
      // The server now has a world history for this episode: read the episode's world again with it.
      const fresh = await gateway.replay.episode(dataset, name);
      if (token !== this.token) return;
      this.recording.world = fresh.world;
      const row = this.row(name); if (row && fresh.world.source === 'resimulated') row.world = 'resimulated';
      await this.loadWorld(token);
    } catch (error) { if (token === this.token) { this.recording.world.job = {state: 'failed', error: error.message}; this.emit(); } }
  }

  // -- every episode of the dataset, checked ---------------------------------------------------------------
  async runAudit() {
    const id = this.dataset?.id;
    if (!id) return;
    try {
      this.audit = await gateway.replay.audit(id, true); this.emit();
      while (this.dataset?.id === id && this.audit?.job?.state === 'running') {
        await new Promise(resolve => setTimeout(resolve, 1500));
        const audit = await gateway.replay.audit(id);
        if (this.dataset?.id !== id) return;
        this.audit = audit; this.emit();
      }
    } catch (error) { this.audit = {job: {state: 'failed', error: error.message}, result: null}; this.emit(); }
  }
}
