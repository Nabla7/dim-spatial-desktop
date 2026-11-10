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
    this.push({role: 'user', text, pending: true});
  }
}

// Desktop's own agent (dimcode, behind /gateways/agent/). Until it is installed this backend only
// says how to get it; the chat itself is the next step (see AGENTS.md).
export class DesktopAgent extends Backend {
  constructor(app) {
    super();
    this.app = app; this.id = 'desktop'; this.title = 'DEV AGENT'; this.status = null;
    this.poll();
  }

  async poll() {
    try {
      this.status = await gateway.agentStatus();
      this.reason = this.status.ready ? 'Desktop\'s agent is running. Talk to it in Desktop\'s chat box for now; this panel does not speak its protocol yet.'
        : this.status.installed ? `Desktop's agent is installed but not ready${this.status.error ? `: ${this.status.error}` : '.'}`
          : 'Desktop\'s agent is not installed. Desktop → Settings → Agent → Install.';
    } catch (error) { this.reason = `Desktop did not answer: ${error.message}`; }
    this.changed();
  }

  send() {}
}
