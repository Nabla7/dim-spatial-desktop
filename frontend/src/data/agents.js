// Agents the user can talk to. Each backend gives the chat panel the same things: whether it can be
// reached (and what to do when it cannot), a transcript, whether the agent is working, and send().
import {gateway} from './gateway.js';
import {decodeCbor, encodeCborText} from './cbor.js';

const textOf = content => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map(block => typeof block === 'string' ? block : block?.text ?? '').join('') : content == null ? '' : String(content);

class Backend extends EventTarget {
  constructor() { super(); this.messages = []; this.busy = false; this.available = false; this.reason = ''; }
  changed() { this.dispatchEvent(new Event('change')); }
  push(message) { this.messages.push({at: Date.now(), ...message}); if (this.messages.length > 400) this.messages.splice(0, 100); this.changed(); }
}

// The agent inside the running blueprint (McpClient): it reads text on /human_input and publishes every
// message of its conversation on /agent. One conversation, shared by everyone on the bus.
export class BlueprintAgent extends Backend {
  constructor(app) {
    super();
    this.app = app; this.id = 'robot'; this.title = 'ROBOT AGENT'; this.subscriptions = []; this.run = null;
    app.blueprint.addEventListener('modules', () => this.sync());
    app.bus.addEventListener('state', () => this.sync());
    this.sync();
  }

  sync() {
    const {blueprint, bus} = this.app, has = key => blueprint.topics.has(key);
    const available = blueprint.running && bus.live && has('dimos/human_input');
    this.reason = !blueprint.running ? 'No blueprint is running.' : !bus.live ? 'No stream link.' : available ? '' : 'This blueprint has no agent (no /human_input stream). Launch an agentic blueprint.';
    if (available && this.run !== blueprint.runId) {
      this.stop(); this.run = blueprint.runId; this.messages = [];
      this.subscriptions.push(bus.subscribe('dimos/agent', {delivery: 'reliable'}, message => this.receive(message.bytes)));
      this.subscriptions.push(bus.subscribe('dimos/agent_idle', {delivery: 'reliable'}, message => { try { this.busy = decodeCbor(message.bytes) === false; this.changed(); } catch { /* not a bool */ } }));
      this.publisher = bus.publisher('dimos/human_input', {delivery: 'reliable'});
    } else if (!available && this.run) { this.stop(); this.run = null; }
    this.available = available; this.changed();
  }

  stop() { for (const subscription of this.subscriptions) subscription.close?.(); this.subscriptions = []; this.publisher?.close?.(); this.publisher = null; this.busy = false; }

  receive(bytes) {
    let message;
    try { message = decodeCbor(bytes); } catch { return; }
    if (!message || typeof message !== 'object') return;
    const type = message.type, text = textOf(message.content);
    if (type === 'human') {
      // The agent echoes what it was told; a line this page sent is already shown.
      const mine = this.messages.findLast?.(entry => entry.role === 'user' && entry.pending && entry.text === text);
      if (mine) { mine.pending = false; this.changed(); return; }
      const progress = /^\[tool:([^\]]+)\]\s*(.*)$/s.exec(text);
      this.push(progress ? {role: 'tool', tool: progress[1], text: progress[2]} : {role: 'user', text});
    } else if (type === 'ai') {
      if (text) this.push({role: 'assistant', text});
      for (const call of message.tool_calls || []) this.push({role: 'call', tool: call.name, text: JSON.stringify(call.args ?? {})});
    } else if (type === 'tool') this.push({role: 'tool', tool: message.name || 'tool', text});
    else if (text) this.push({role: 'system', text});
  }

  send(text) {
    if (!this.publisher) return;
    this.publisher.put(encodeCborText(text));
    const message = {role: 'user', text, pending: true};
    this.push(message);
    // The agent repeats what it hears. No echo means nothing is listening on /human_input.
    setTimeout(() => { if (message.pending) { message.pending = false; message.lost = true; this.changed(); } }, 8000);
  }
}

// A coding agent on this machine (Claude Code, Codex), run by this app's server as the user: their own
// login, settings and tools, in the dimos checkout Desktop uses. A turn streams back as events: text
// as it is written, each tool call and its result, and a permission prompt whenever the agent would
// have asked at the terminal. Which agents there are, and their models, is the server's to say.
const SESSION_AGENTS = {
  claude: {title: 'CLAUDE', name: 'Claude', intro: 'This is Claude Code, started for you in the dimos checkout with your own login, settings and skills. Ask it about the running blueprint, have it read or change code, or have it call what the panels cannot. It asks here before anything that needs your permission.'},
  codex: {title: 'CODEX', name: 'Codex', intro: 'This is Codex, started for you in the dimos checkout with your ChatGPT login and your own Codex config. Its commands run in its sandbox, which has no network: it asks here before one leaves the sandbox, and reaching the gateway on this machine is such a command. ALWAYS allows that same command for the rest of the session.'},
};

// A question a panel asks on the user's behalf starts with this line. The chat shows such an exchange as
// two short lines: the long question and the JSON answer are the panel's business.
export const FORM_ASK = '[A panel of DimOS Spatial Desktop asks this for the user. Answer in the JSON form it gives; the panel reads the answer, not a person.]';

export class SessionAgent extends Backend {
  constructor(app, id) {
    super();
    Object.assign(this, SESSION_AGENTS[id]);
    this.app = app; this.id = id; this.session = null; this.after = 0; this.limits = null; this.models = []; this.efforts = [];
    this.model = null; this.mode = null; this.effort = null; this.starting = null; this.reason = `Looking for ${this.name}…`; this.lastSessionId = null;
    const kept = this.load();
    this.choice = kept.model || ''; this.effortChoice = kept.effort || '';
    this.refresh();
  }

  load() { try { return JSON.parse(localStorage.getItem(`spatial.agent.${this.id}`) || '{}'); } catch { return {}; } }
  choose(values) { Object.assign(this, values); try { localStorage.setItem(`spatial.agent.${this.id}`, JSON.stringify({model: this.choice, effort: this.effortChoice})); } catch { /* private mode */ } if (this.session) this.fresh(); else this.changed(); }

  async refresh() {
    try {
      const status = await gateway.agent.status(), mine = (status.backends || []).find(backend => backend.id === this.id);
      this.available = !!mine?.available; this.cwd = status.cwd; this.lastSessionId = mine?.lastSessionId ?? null;
      this.models = mine?.models || []; this.efforts = mine?.efforts || [];
      this.reason = this.available ? '' : mine?.reason || `This version of the app's server does not know ${this.name}.`;
      // A page reload meets the server's sessions again: pick up the newest one that is still alive.
      const alive = (status.sessions || []).filter(session => session.backend === this.id && session.exited === null).sort((a, b) => b.startedAt - a.startedAt)[0];
      if (alive && !this.session) this.attach(alive.id);
    } catch (error) {
      this.available = false;
      this.reason = error.status === 404 ? 'This install of the app has no server (it was installed as a static page). Reinstall it from its repository to get the agent bridge.' : `The app's server did not answer: ${error.message}`;
    }
    this.changed();
  }

  attach(id) {
    this.session = id; this.after = 0; this.messages = []; this.busy = false;
    this.listen(id);
  }

  async start({resume = false} = {}) {
    if (this.starting) return this.starting;
    this.starting = gateway.agent.create({backend: this.id, model: this.choice || undefined, effort: this.effortChoice || undefined, resume, cwd: this.app.agentFolder || undefined}).then(session => { this.attach(session.id); return session.id; }).finally(() => { this.starting = null; });
    return this.starting;
  }

  // Continue the conversation this agent had last (the agent program keeps it; the server remembers which).
  async resume() {
    try { await this.start({resume: true}); this.push({role: 'system', text: 'Continuing the last conversation. The agent remembers it; what was said before is not all shown here.'}); }
    catch (error) { this.push({role: 'system', text: `Could not continue it: ${error.message}`}); }
  }

  async fresh() {
    const old = this.session;
    this.session = null; this.messages = []; this.busy = false; this.model = null; this.changed();
    if (old) gateway.agent.close(old).catch(() => {});
    this.refresh();
  }

  // One long poll after another for as long as this session is the current one.
  async listen(id) {
    let failures = 0;
    while (this.session === id) {
      try {
        const page = await gateway.agent.events(id, this.after, 20);
        failures = 0;
        if (this.session !== id) return;
        if (page.reset) this.messages = [];
        for (const event of page.events) { this.after = event.seq; this.apply(event); }
        this.busy = !!page.busy;
        if (page.events.length) this.changed();
        if (page.exited !== null && !page.events.length) { this.session = null; this.busy = false; this.changed(); return; }
      } catch (error) {
        if (error.status === 404) { this.session = null; this.busy = false; this.push({role: 'system', text: 'The agent session is gone (the app\'s server restarted). The next message starts a new one.'}); return; }
        if (++failures > 5) { await new Promise(resolve => setTimeout(resolve, 3000)); }
      }
    }
  }

  streaming() { const last = this.messages[this.messages.length - 1]; return last?.role === 'assistant' && last.streaming ? last : null; }

  apply(event) {
    const add = message => { this.messages.push({at: Date.now(), ...message}); if (this.messages.length > 500) this.messages.splice(0, 100); };
    switch (event.t) {
      case 'init': this.model = event.model; this.mode = event.mode; this.cwd = event.cwd; this.sessionFolder = event.cwd; this.effort = event.effort ?? null; this.sandbox = event.sandbox ?? null; break;
      case 'user': {
        this.formTurn = event.text.startsWith(FORM_ASK);
        add(this.formTurn ? {role: 'system', text: `A panel asked ${this.name} to explain ${/^(?:RPC|Stream): ([\w/]+)/m.exec(event.text)?.[1] || 'a call'}.`} : {role: 'user', text: event.text});
        if (!event.past) this.busy = true;
        break;
      }
      case 'thinking': this.thinking = true; break;
      case 'delta': {
        this.thinking = false;
        if (this.formTurn) break;
        const open = this.streaming();
        if (open) open.text += event.text; else add({role: 'assistant', text: event.text, streaming: true});
        break;
      }
      case 'assistant':
        for (const block of event.blocks) {
          if (block.type === 'text' && this.formTurn) continue;
          if (block.type === 'text') { const open = this.streaming(); if (open) { open.text = block.text; open.streaming = false; } else if (block.text) add({role: 'assistant', text: block.text}); }
          else add({role: 'call', id: block.id, tool: block.name, input: block.input, state: 'running'});
        }
        break;
      case 'tool_result': {
        const call = this.messages.findLast(message => message.role === 'call' && message.id === event.id);
        if (call) { call.state = event.error ? 'error' : 'done'; call.result = event.text; }
        break;
      }
      case 'permission': add({role: 'permission', requestId: event.requestId, tool: event.tool, title: event.title, input: event.input, description: event.description, session: !!event.session, state: 'pending'}); break;
      case 'permission_answer': { const asked = this.messages.findLast(message => message.role === 'permission' && message.requestId === event.requestId); if (asked) asked.state = event.withdrawn ? 'withdrawn' : event.allow ? 'allowed' : 'denied'; break; }
      case 'result': {
        if (event.past) break;
        this.busy = false; this.thinking = false;
        const open = this.streaming(); if (open) open.streaming = false;
        // A call still marked as running when its turn ends was cut off with it.
        for (const message of this.messages) if (message.role === 'call' && message.state === 'running') message.state = 'stopped';
        if (this.formTurn) { this.formTurn = false; if (event.ok) add({role: 'system', text: `The answer is in the panel that asked${event.ms ? ` (${(event.ms / 1000).toFixed(1)} s)` : ''}.`}); }
        const last = this.messages.at(-1)?.role === 'assistant' ? this.messages.at(-1) : null;
        if (last) last.meta = [event.ms ? `${(event.ms / 1000).toFixed(1)} s` : '', event.costUsd ? `$${event.costUsd.toFixed(3)}` : '', event.subtype === 'interrupted' ? 'stopped' : ''].filter(Boolean).join(' · ');
        if (!event.ok && event.subtype !== 'interrupted') add({role: 'system', text: `The turn ended with an error (${event.subtype}). ${event.text || ''}`});
        this.onResult?.(event);
        break;
      }
      case 'limits': this.limits = event; break;
      case 'note': add({role: 'system', text: event.text}); break;
      case 'exit': this.busy = false; add({role: 'system', text: `${this.name} ended (exit ${event.code}).${this.lastError ? ` ${this.lastError}` : ''} The next message starts a new session.`}); break;
      case 'stderr': this.lastError = event.text; break;
    }
  }

  async send(text) {
    try {
      // What is on the table can name the folder to work in (a scene's project). A conversation that was
      // started somewhere else is left as it is, and a new one starts there.
      const folder = this.app.agentFolder;
      if (this.session && folder && this.sessionFolder && this.sessionFolder.replace(/\/+$/, '') !== folder.replace(/\/+$/, '')) {
        const old = this.session;
        this.session = null; this.messages = []; this.model = null; this.sessionFolder = null;
        gateway.agent.close(old).catch(() => {});
        this.push({role: 'system', text: `A new conversation, in ${folder}.`});
      }
      if (!this.session) await this.start();
      this.busy = true; this.changed();
      await gateway.agent.send(this.session, text);
      return true;
    } catch (error) { this.busy = false; this.push({role: 'system', text: `Not sent: ${error.message}`}); return false; }
  }

  // One question, one answer: the RPC forms use it to ask for arguments. The exchange stays in the chat.
  ask(text) {
    return new Promise((resolve, reject) => {
      const previous = this.onResult, timer = setTimeout(() => { this.onResult = previous; reject(new Error('the agent took too long')); }, 180000);
      this.onResult = event => { clearTimeout(timer); this.onResult = previous; event.ok ? resolve(event.text) : reject(new Error(event.text || event.subtype)); };
      this.send(text).then(sent => { if (!sent) { clearTimeout(timer); this.onResult = previous; reject(new Error('the question was not sent')); } });
    });
  }

  async answer(message, allow, session = false) {
    message.state = allow ? 'allowed' : 'denied'; this.changed();
    try { await gateway.agent.permission(this.session, message.requestId, allow, session); } catch (error) { this.push({role: 'system', text: `The answer did not arrive: ${error.message}`}); }
  }

  async interrupt() { if (this.session) await gateway.agent.interrupt(this.session).catch(error => this.push({role: 'system', text: `Could not stop: ${error.message}`})); }
}
