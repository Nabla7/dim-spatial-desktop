// The running blueprint, read from the dimos gateway: its module instances, their RPCs and streams,
// which topics join them, and how busy each topic and process is. Nothing here knows any robot:
// every panel and every hologram is built from this model, so a new blueprint needs no new code.
import {gateway} from './gateway.js';
import {parseKey, shortType} from './bus.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class Blueprint extends EventTarget {
  constructor(bus) {
    super();
    this.bus = bus;
    this.reachable = true; this.running = false; this.runId = null; this.name = null; this.phase = 'stopped';
    this.launch = null; this.startedAt = null;
    this.modules = []; this.topics = new Map(); this.stats = null; this.catalog = null; this.catalogError = null;
    this.modulesFor = null; this.stopped = false; this.ratesUp = false;
    addEventListener('pagehide', () => { this.stopped = true; });
  }

  emit(type) { this.dispatchEvent(new Event(type)); }

  start() {
    this.loop(() => this.pollActive(), 1500);
    this.loop(() => this.pollRates(), 2000);
    this.loop(() => this.pollStats(), 2500);
    this.bus.ready.then(() => this.bus.subscribeEvents('dimos', event => { if (event.type === 'launch' || event.type === 'blueprints') this.pollActive().catch(() => {}); }));
  }

  async loop(step, interval) {
    while (!this.stopped) {
      try { await step(); } catch (error) { if (!this.stopped) console.debug(error.message); }
      await sleep(document.hidden ? interval * 3 : interval);
    }
  }

  async pollActive() {
    let active;
    try { active = await gateway.active(); this.reachable = true; }
    catch (error) { if (this.reachable) { this.reachable = false; this.emit('change'); } throw error; }
    const launch = active.launch || null, phase = active.running ? (launch?.phase === 'stopping' ? 'stopping' : 'running') : (launch?.phase || 'stopped');
    const name = active.blueprint || (phase !== 'stopped' ? launch?.blueprint : null) || null;
    const changed = active.running !== this.running || active.runId !== this.runId || phase !== this.phase || name !== this.name
      || (launch?.output?.length ?? 0) !== (this.launch?.output?.length ?? 0);
    Object.assign(this, {running: !!active.running, runId: active.runId, phase, name, launch, startedAt: active.startedAt || launch?.startedAt || null});
    if (!this.running) {
      if (this.modules.length) { this.modules = []; this.topics = new Map(); this.modulesFor = null; this.stats = null; this.emit('modules'); }
    } else if (this.modulesFor !== this.runId || !this.modules.length) await this.loadModules();
    if (changed) this.emit('change');
  }

  // The instances are known a moment after the run is: ask until they answer.
  async loadModules() {
    let answer;
    try { answer = await gateway.modules(); } catch { return; }
    const modules = (answer.modules || []).map(instance => this.normalize(instance));
    if (!modules.length) return;
    const topics = new Map();
    for (const module of modules) for (const stream of module.streams) {
      if (!stream.key) continue;
      if (!topics.has(stream.key)) topics.set(stream.key, {key: stream.key, topic: stream.topic, type: stream.type, writers: [], readers: [], hz: 0, bps: 0, history: []});
      const topic = topics.get(stream.key);
      if (stream.direction !== 'in') topic.writers.push(module.id);
      if (stream.direction !== 'out') topic.readers.push(module.id);
    }
    this.modules = modules; this.topics = topics; this.modulesFor = this.runId;
    this.emit('modules');
  }

  normalize(instance) {
    const cls = instance.class || instance.id;
    return {
      id: instance.id, cls, name: cls.split('.').pop(), namespace: instance.namespace || null, doc: (instance.doc || '').trim(),
      rpcs: (instance.rpcs || []).map(rpc => ({name: rpc.name, doc: (rpc.doc || '').trim(), params: rpc.params || [], returns: rpc.return_type || null, skill: !!rpc.skill}))
        .sort((a, b) => Number(b.skill) - Number(a.skill) || a.name.localeCompare(b.name)),
      streams: (instance.streams || []).map(stream => {
        const parsed = stream.channel ? parseKey(stream.channel) : {topic: `/${stream.name}`, type: null};
        return {name: stream.name, direction: stream.direction || 'out', key: stream.channel || null, topic: parsed.topic, type: parsed.type || shortType(stream.type), pythonType: stream.type};
      }),
    };
  }

  // Desktop counts messages per topic for as long as someone keeps asking.
  async pollRates() {
    if (!this.running) return;
    const answer = await gateway.rates();
    this.ratesUp = !!answer.up;
    const seen = new Set();
    for (const rate of answer.topics || []) {
      const key = `dimos${rate.topic}${rate.type ? `/${rate.type}` : ''}`, topic = this.topics.get(key);
      if (!topic) continue;
      topic.hz = rate.hz || 0; topic.bps = rate.bps || 0; topic.history = rate.history || []; seen.add(key);
    }
    for (const [key, topic] of this.topics) if (!seen.has(key)) { topic.hz = 0; topic.bps = 0; }
    this.emit('rates');
  }

  async pollStats() {
    if (!this.running) return;
    const stats = await gateway.stats();
    this.stats = stats.up ? stats : null;
    this.emit('stats');
  }

  module(id) { return this.modules.find(module => module.id === id) || null; }

  // The process a module runs in (dtop's sample), if stats are flowing.
  processOf(module) {
    const workers = this.stats?.workers || [];
    return workers.find(worker => (worker.modules || []).some(name => name === module.name || name.toLowerCase() === module.id.split(':').pop())) || null;
  }

  // Module-to-module links: one per (writer, reader, topic).
  links() {
    const links = [];
    for (const topic of this.topics.values()) for (const from of topic.writers) for (const to of topic.readers) if (from !== to) links.push({from, to, topic});
    return links;
  }

  async loadCatalog(force = false) {
    if (this.catalog && !force) return this.catalog;
    try {
      const answer = await gateway.blueprints();
      this.catalog = (answer.blueprints || answer || []).filter(entry => !entry.hidden).sort((a, b) => a.name.localeCompare(b.name));
      this.catalogError = null;
    } catch (error) { this.catalogError = error.message; this.catalog = this.catalog || []; }
    this.emit('catalog');
    return this.catalog;
  }
}
