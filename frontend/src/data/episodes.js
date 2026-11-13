// Episodes for training: the takes a blueprint records while a person (or a policy) works the robot.
// Found the way dimos's own operator interface finds them (dimos/imitation/tui.py): by the Spec a module
// answers, not by its class. A module with get_status() and command(event) that both return an episode
// status is the episode control (EpisodeControlSpec). It publishes each change of state as JSON on a
// String stream. A module that reads that stream and writes no stream of its own is a recorder: what
// else it reads is what an episode holds. (A module that reads it and also writes, an operator's
// headset that shows the state, is not one.)
//
// Nothing here starts or ends an episode on its own: command() is called from a press.
import {gateway} from './gateway.js';

const required = rpc => (rpc.params || []).filter(param => param.required);
const returns = rpc => rpc.returns ?? rpc.return_type ?? '';
const isText = stream => /(^|\.)String$/.test(stream.type || '');
// A stream is the same stream in two modules when they share its channel (a running blueprint) or its topic (the catalog).
const wire = stream => stream.key || stream.topic || stream.name;

// modules: the running blueprint's (data/blueprint.js) or a catalog entry's. Returns null when no module
// is an episode control, else {control, status (the stream of its events, or null), recorders: [{module, inputs}]}.
export function findEpisodes(modules) {
  for (const control of modules || []) {
    const rpcs = control.rpcs || [];
    const status = rpcs.find(rpc => rpc.name === 'get_status' && !required(rpc).length);
    const command = rpcs.find(rpc => rpc.name === 'command' && required(rpc).length === 1);
    if (!status || !command || !/EpisodeStatus$/.test(returns(status)) || returns(command) !== returns(status)) continue;
    const outs = (control.streams || []).filter(stream => stream.direction === 'out' && isText(stream));
    const events = outs.find(stream => stream.name === 'status') || outs[0] || null;
    const reads = module => (module.streams || []).some(stream => stream.direction === 'in' && wire(stream) === wire(events));
    const writes = module => (module.streams || []).some(stream => stream.direction === 'out');
    const recorders = !events ? [] : modules.filter(module => module !== control && reads(module) && !writes(module))
      .map(module => ({module, inputs: module.streams.filter(stream => stream.direction === 'in' && wire(stream) !== wire(events))}));
    return {control, command, parameter: required(command)[0].name, status: events, recorders};
  }
  return null;
}

// One status as the control reports it: an object from the stream's JSON, or what the gateway made of an RPC's answer.
export function readStatus(value) {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return null; } }
  if (!value || typeof value !== 'object' || !['idle', 'recording'].includes(value.state)) return null;
  return {state: value.state, saved: Number(value.episodes_saved) || 0, discarded: Number(value.episodes_discarded) || 0,
    event: value.last_event || null, task: value.task_label || '', ts: Number(value.ts) || 0};
}

export class Episodes extends EventTarget {
  constructor(app) {
    super();
    this.app = app; this.found = null; this.status = null; this.error = null; this.busy = null;
    // When the episode that is recording began, if this page saw it begin: on this machine's clock (for the
    // time shown while it runs) and on the control's (for how long it was, once it ends).
    this.began = null;
    this.log = [];             // the episodes that ended while this page watched: {number, result, seconds}
    this.watchers = 0; this.subscription = null; this.timer = null;
    app.blueprint.addEventListener('modules', () => this.discover());
    app.bus.addEventListener('state', () => { if (this.watchers) this.listen(); });
    this.discover();
  }

  emit() { this.dispatchEvent(new Event('change')); }
  get available() { return !!this.found; }
  get recording() { return this.status?.state === 'recording'; }

  discover() {
    const found = findEpisodes(this.app.blueprint.modules), same = found?.control.id === this.found?.control.id && this.runId === this.app.blueprint.runId;
    this.found = found;
    if (!same) { this.status = null; this.error = null; this.began = null; this.log = []; this.runId = this.app.blueprint.runId; this.unlisten(); if (found && this.watchers) this.listen(); }
    this.emit();
  }

  // Someone is looking (the deck, the panel): hear the control's events, and ask it once where it stands.
  watch(on) {
    this.watchers = Math.max(0, this.watchers + (on ? 1 : -1));
    if (this.watchers && this.found) this.listen(); else if (!this.watchers) this.unlisten();
  }

  listen() {
    const stream = this.found?.status;
    if (!this.found) return;
    if (!this.subscription && stream?.key && this.app.bus.live) this.subscription = this.app.bus.subscribeDecoded(stream.key, {delivery: 'reliable'}, message => this.take(readStatus(message.data), true));
    // The stream speaks only when the state changes. The control is also asked, now and every few seconds,
    // so what is shown is true from the start and stays true if an event is lost.
    if (!this.timer) { this.refresh(); this.timer = setInterval(() => this.refresh(), 3000); }
  }

  unlisten() { this.subscription?.close?.(); this.subscription = null; clearInterval(this.timer); this.timer = null; }

  async refresh() {
    const control = this.found?.control;
    if (!control) return;
    try {
      const answer = await gateway.callRpc(control.id, 'get_status', {});
      if (control !== this.found?.control) return;
      if (!answer.ok) throw new Error(String(answer.error).split('\n').pop());
      const status = readStatus(answer.result);
      if (!status) throw new Error('the episode control answered something that is not a status');
      this.error = null; this.take(status, false);
    } catch (error) { this.error = error.message; this.emit(); }
  }

  // event: the status came with the change itself (its time is the change's), not from asking.
  take(status, event) {
    if (!status) return;
    const before = this.status, now = Date.now(), began = this.began;
    if (before && (status.saved > before.saved || status.discarded > before.discarded)) {
      // An episode ended. How long it ran: by the control's clock when it gave both ends, else by this machine's.
      const seconds = !began ? null : event && began.ts != null ? Math.max(0, status.ts - began.ts) : Math.max(0, (now - began.at) / 1000);
      const number = before.saved + before.discarded + 1;
      if (status.saved > before.saved) this.log.unshift({number, result: 'saved', seconds});
      if (status.discarded > before.discarded) this.log.unshift({number, result: 'discarded', seconds});
      this.log.length = Math.min(this.log.length, 200);
    }
    if (status.state !== 'recording') this.began = null;
    // A start while one records saves that one and begins the next (the control's own rule).
    else if (event && status.event === 'start') this.began = {at: before?.state === 'recording' && began && !(status.saved > before.saved) ? began.at : now, ts: status.ts};
    else if (before && before.state !== 'recording') this.began = {at: now, ts: null};
    this.status = status; this.error = null;
    this.emit();
  }

  // Seconds the episode has run, or null when this page did not see it begin.
  elapsed(now = Date.now()) { return this.recording && this.began ? Math.max(0, (now - this.began.at) / 1000) : null; }

  // start | save | discard. Only ever from a press.
  async command(event) {
    const found = this.found;
    if (!found || this.busy) return;
    this.busy = event; this.emit();
    try {
      const answer = await gateway.callRpc(found.control.id, found.command.name, {[found.parameter]: event});
      if (!answer.ok) throw new Error(String(answer.error).split('\n').pop());
      const status = readStatus(answer.result);
      if (status) this.take(status, false); else await this.refresh();
    } catch (error) { this.app.toast(`Episode ${event} failed: ${error.message}`, 'danger'); }
    this.busy = null; this.emit();
  }

  // What each recorder reads, with how fast it is arriving now: [{module, inputs: [{name, topic, type, hz, writers, silent}]}].
  inputs() {
    const blueprint = this.app.blueprint;
    return (this.found?.recorders || []).map(({module, inputs}) => ({module, inputs: inputs.map(stream => {
      const topic = blueprint.topics.get(stream.key), writers = (topic?.writers || []).map(id => blueprint.module(id)?.name || id);
      return {name: stream.name, topic: stream.topic, type: stream.type, hz: topic?.hz || 0, writers, silent: !(topic?.hz > 0)};
    })}));
  }

  // How many recorded streams have nothing arriving. Rates are known only while Desktop counts them.
  get silent() { return this.app.blueprint.ratesUp ? this.inputs().reduce((count, {inputs}) => count + inputs.filter(input => input.silent).length, 0) : 0; }
}
