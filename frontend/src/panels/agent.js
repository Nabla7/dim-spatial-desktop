// Talking to an agent. Three can be on the other end: Claude Code or Codex, run by this app's server as
// the user (the same agent as in a terminal: it reads and edits the checkout, runs commands, asks before
// what needs asking), and the agent inside an agentic blueprint. Typed, or dictated where the browser can.
import {SIZE} from '../ui/holo.js';
import {Rect} from '../ui/rect.js';
import {BlueprintAgent, SessionAgent} from '../data/agents.js';
import {brief} from '../util.js';

const Recognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;

export function agents(app) {
  return app.agents ||= [new SessionAgent(app, 'claude'), new SessionAgent(app, 'codex'), new BlueprintAgent(app)];
}

// The coding agent to hand a question to from elsewhere in the app: the one in use, else one that can be reached.
export function codingAgent(app) {
  const coding = agents(app).filter(agent => agent instanceof SessionAgent && agent.available);
  return coding.find(agent => agent.id === app.agentInUse) || coding.find(agent => agent.session) || coding[0] || null;
}

// What a tool call is doing, in one line.
function callTitle(message) {
  const input = message.input || {};
  switch (message.tool) {
    case 'Bash': case 'Shell': return input.command;
    case 'Read': case 'Edit': case 'Write': case 'NotebookEdit': case 'ViewImage': return input.file_path ?? (input.files || []).join(', ');
    case 'Grep': return `${input.pattern}${input.path ? `  in ${input.path}` : ''}`;
    case 'Glob': return input.pattern;
    case 'Task': case 'Agent': return input.description;
    case 'WebFetch': return input.url;
    case 'WebSearch': return input.query;
    case 'Skill': return input.skill;
    default: return brief(input, 160).replace(/\s+/g, ' ');
  }
}

// Markdown is written for a renderer this panel does not have: fenced code keeps its own face, the rest
// is shown as the plain text it reads as.
function blocksOf(text) {
  const blocks = [];
  String(text || '').split(/```[a-zA-Z0-9_-]*\n?/).forEach((part, index) => {
    const code = index % 2 === 1, body = code ? part.replace(/\n$/, '') : part.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/^#{1,4}\s+/gm, '').replace(/^\s*[-*]\s+/gm, '• ').trim();
    if (body) blocks.push({code, text: body});
  });
  return blocks;
}

// draft: text to put in the message box (the panel then opens, or stays open, instead of toggling).
export function openAgent(app, {draft} = {}) {
  const id = 'agent';
  if (app.dock.has(id)) { if (draft === undefined) app.dock.close(id); else app.dock.get(id).setDraft(draft); return; }
  const all = agents(app);
  const state = {backend: app.agentInUse || all.find(agent => agent.available)?.id || all[0].id, draft: '', listening: false, picked: !!app.agentInUse};
  const backend = () => all.find(agent => agent.id === state.backend);
  let recognition = null;

  function send(text) {
    const value = String(text ?? state.draft).trim();
    if (!value || !backend().available) return;
    app.agentInUse = state.backend;
    backend().send(value); state.draft = ''; panel.invalidate();
  }

  function dictate() {
    if (!Recognition) return;
    if (recognition) { recognition.stop(); return; }
    recognition = new Recognition(); recognition.interimResults = true; recognition.continuous = false; recognition.lang = navigator.language || 'en-US';
    recognition.onresult = event => { state.draft = [...event.results].map(result => result[0].transcript).join(''); panel.invalidate(); if (event.results[event.results.length - 1].isFinal) send(); };
    recognition.onend = () => { recognition = null; state.listening = false; panel.invalidate(); };
    recognition.onerror = event => { app.toast(`Dictation: ${event.error}`, 'warn'); };
    try { recognition.start(); state.listening = true; } catch (error) { recognition = null; app.toast(`Dictation: ${error.message}`, 'warn'); }
  }

  // Lays a message's text out (prose and code blocks); draws it unless measuring. Returns the height.
  function rich(ui, text, x, y, width, {color, size = SIZE.md, measure = false} = {}) {
    let used = 0;
    for (const block of blocksOf(text)) {
      if (block.code) {
        const inner = new Rect(x + 10, y + used + 8, width - 20, 0);
        const height = ui.wrap(block.text, inner, {size: SIZE.xs, family: 'mono', measure: true, maxLines: 40, lineHeight: 1.4});
        if (!measure) {
          ui.ctx.fillStyle = ui.tone('input', 0.9); ui.ctx.fillRect(x, y + used, width, height + 16);
          ui.wrap(block.text, inner, {size: SIZE.xs, family: 'mono', color: ui.tone('info'), maxLines: 40, lineHeight: 1.4});
        }
        used += height + 16 + 8;
      } else used += ui.wrap(block.text, new Rect(x, y + used, width, 0), {size, color, measure, maxLines: 400, lineHeight: 1.42}) + 8;
    }
    return Math.max(0, used - 8);
  }

  function drawMessage(ui, inner, y, message, current) {
    const key = `${message.role}:${message.at}:${message.id || message.requestId || ''}`;
    if (message.role === 'user') {
      const width = inner.w * 0.86, pad = 12;
      const height = ui.wrap(message.text, new Rect(0, 0, width - pad * 2, 0), {size: SIZE.md, measure: true, lineHeight: 1.4, maxLines: 80});
      const box = new Rect(inner.r - width, y, width, height + pad * 2);
      ui.chamfer(box, 10); ui.ctx.fillStyle = ui.tone('primary', 0.13); ui.ctx.fill(); ui.ctx.strokeStyle = ui.tone('primary', 0.5); ui.ctx.lineWidth = 1.2; ui.ctx.stroke();
      ui.wrap(message.text, new Rect(box.x + pad, box.y + pad, width - pad * 2, 0), {size: SIZE.md, color: ui.tone(message.pending || message.lost ? 'muted' : 'fg'), lineHeight: 1.4, maxLines: 80});
      if (message.lost) { ui.text('no agent heard this', box.r, box.b + 9, {size: SIZE.xs - 2, family: 'mono', color: ui.tone('warn'), align: 'right'}); return box.h + 26; }
      return box.h + 12;
    }
    if (message.role === 'assistant') {
      const height = rich(ui, message.text, inner.x + 14, y + 2, inner.w - 20, {measure: true});
      ui.ctx.fillStyle = ui.tone('agent', 0.9); ui.ctx.fillRect(inner.x, y, 3, height + 4);
      rich(ui, message.text, inner.x + 14, y + 2, inner.w - 20, {color: ui.tone('fg')});
      if (message.meta) { ui.text(message.meta, inner.x + 14, y + height + 18, {size: SIZE.xs - 2, family: 'mono', color: ui.tone('muted', 0.8)}); return height + 38; }
      return height + 16;
    }
    if (message.role === 'call') {
      // One line per tool call; a press opens what it returned.
      const tone = message.state === 'error' ? 'danger' : message.state === 'done' ? 'ok' : 'warn', row = new Rect(inner.x, y, inner.w, 34);
      const hot = ui.row(row, {id: `call:${key}`, onClick: () => { message.open = !message.open; }, tone: 'alt'});
      ui.lamp(row.x + 12, row.cy, tone, message.state === 'running');
      const nameWidth = ui.text(message.tool, row.x + 28, row.cy + 1, {size: SIZE.xs, family: 'mono', weight: 500, color: ui.tone('alt')});
      ui.text(String(callTitle(message) ?? ''), row.x + 38 + nameWidth, row.cy + 1, {size: SIZE.xs, family: 'mono', color: ui.tone(hot ? 'fg' : 'muted'), max: row.w - nameWidth - 70});
      ui.icon(message.open ? 'down' : 'chevron', row.r - 12, row.cy, 12, ui.tone('muted'));
      let used = 38;
      if (message.open) {
        const body = `${brief(message.input, 900)}${message.result !== undefined ? `\n→ ${message.result}` : ''}`, area = new Rect(inner.x + 14, y + used + 6, inner.w - 22, 0);
        const height = ui.wrap(body, area, {size: SIZE.xs, family: 'mono', measure: true, maxLines: 30, lineHeight: 1.4});
        ui.ctx.fillStyle = ui.tone('input', 0.9); ui.ctx.fillRect(inner.x + 6, y + used, inner.w - 6, height + 12);
        ui.wrap(body, area, {size: SIZE.xs, family: 'mono', color: ui.tone(message.state === 'error' ? 'danger' : 'muted'), maxLines: 30, lineHeight: 1.4});
        used += height + 18;
      }
      return used;
    }
    if (message.role === 'permission') {
      const pending = message.state === 'pending', pad = 12, width = inner.w;
      const what = String(callTitle(message) ?? ''), text = `${message.description && message.description !== what ? `${message.description}\n` : ''}${what}`;
      const height = ui.wrap(text, new Rect(0, 0, width - pad * 2, 0), {size: SIZE.xs, family: 'mono', measure: true, maxLines: 8, lineHeight: 1.4});
      const box = new Rect(inner.x, y, width, height + pad * 2 + 30 + (pending ? 52 : 0));
      ui.chamfer(box, 10); ui.ctx.fillStyle = ui.tone('warn', 0.08); ui.ctx.fill(); ui.ctx.strokeStyle = ui.tone('warn', pending ? 0.9 : 0.35); ui.ctx.lineWidth = 1.4; ui.ctx.stroke();
      const said = {allowed: 'Allowed', denied: 'Denied', withdrawn: 'No longer asked'}[message.state];
      ui.text(pending ? `${current.name} asks to ${message.title || `use ${message.tool}`}` : `${said}: ${message.title || message.tool}`, box.x + pad, box.y + pad + 8, {size: SIZE.sm, weight: 600, color: ui.tone(pending ? 'warn' : 'muted'), max: width - pad * 2});
      ui.wrap(text, new Rect(box.x + pad, box.y + pad + 26, width - pad * 2, 0), {size: SIZE.xs, family: 'mono', color: ui.tone('fg'), maxLines: 8, lineHeight: 1.4});
      if (pending) {
        // "Always" is for the rest of this session, where the agent has such an answer.
        const cells = new Rect(box.x + pad, box.b - 52, width - pad * 2, 40).cols(message.session ? 3 : 2, 10);
        ui.button(cells[0], 'ALLOW', () => current.answer(message, true), {id: `allow:${message.requestId}`, tone: 'ok', icon: 'check', on: true, size: SIZE.sm});
        if (message.session) ui.button(cells[1], 'ALWAYS', () => current.answer(message, true, true), {id: `always:${message.requestId}`, tone: 'ok', size: SIZE.sm});
        ui.button(cells.at(-1), 'DENY', () => current.answer(message, false), {id: `deny:${message.requestId}`, tone: 'danger', icon: 'close', size: SIZE.sm});
      }
      return box.h + 12;
    }
    // tool results of the blueprint's agent, and notes
    const tone = message.role === 'tool' ? 'muted' : 'warn', label = message.role === 'tool' ? `${message.tool}: ${message.text}` : message.text;
    const height = ui.wrap(label, new Rect(inner.x + 12, y + 4, inner.w - 20, 0), {size: SIZE.xs, family: 'mono', color: ui.tone(tone), maxLines: 8, lineHeight: 1.4});
    ui.ctx.fillStyle = ui.tone(tone, 0.7); ui.ctx.fillRect(inner.x, y, 3, height + 8);
    return height + 18;
  }

  const panel = app.panel({
    id, title: 'Agent', glyph: 'agent', width: 0.5, height: app.dock.sideHeight(0.66), onClose: () => app.dock.close(id),
    draw(ui, content) {
      // Until the user chooses a tab, show the agent that can be reached.
      if (!state.picked && !backend().available) { const ready = all.find(agent => agent.available); if (ready) state.backend = ready.id; }
      const current = backend(), coding = current instanceof SessionAgent;
      const model = String(current.model || '').replace(/^claude-/, '').replace(/\[.*\]$/, '');
      panel.tag = current.busy ? 'WORKING' : current.available ? (coding && model ? model : 'READY') : 'OFFLINE'; panel.busy = current.busy;
      ui.chips(content.cutTop(36, 8), all.map(agent => [agent.id, agent.title]), state.backend, value => { state.backend = value; state.picked = true; }, {id: 'backend', size: SIZE.xs, tone: 'agent'});
      if (coding && current.available) {
        // Model and effort are choices for the next session: changing one ends the session that runs.
        const row = content.cutTop(32, 10), cycle = (list, value) => list[(Math.max(0, list.findIndex(choice => choice.id === value)) + 1) % list.length].id;
        const label = (list, value) => (list.find(choice => choice.id === value)?.label || 'default').toUpperCase();
        ui.button(row.cutRight(70, 8), 'NEW', () => current.fresh(), {id: 'new', size: SIZE.xs, enabled: !!current.session});
        if (!current.session && current.lastSessionId) ui.button(row.cutRight(130, 8), 'CONTINUE LAST', () => current.resume(), {id: 'resume', size: SIZE.xs, tone: 'alt'});
        const [left, right] = row.cols(2, 8);
        ui.button(left, `MODEL  ${label(current.models, current.choice)}`, () => current.choose({choice: cycle(current.models, current.choice)}), {id: 'model', size: SIZE.xs, tone: 'muted', enabled: current.models.length > 1});
        ui.button(right, `EFFORT  ${label(current.efforts, current.effortChoice)}`, () => current.choose({effortChoice: cycle(current.efforts, current.effortChoice)}), {id: 'effort', size: SIZE.xs, tone: 'muted', enabled: current.efforts.length > 1});
      }
      const entry = content.cutBottom(50, 10);
      if (Recognition) ui.button(entry.cutLeft(50, 8), '', dictate, {id: 'mic', icon: 'mic', tone: state.listening ? 'danger' : 'agent', on: state.listening, enabled: current.available});
      if (coding && current.busy) ui.button(entry.cutRight(112, 8), 'STOP', () => current.interrupt(), {id: 'stop', icon: 'stop', tone: 'danger', size: SIZE.sm});
      else ui.button(entry.cutRight(58, 8), '', () => send(), {id: 'send', icon: 'send', tone: 'agent', on: !!state.draft.trim() && current.available, enabled: current.available});
      ui.field(entry, state.draft, {id: 'draft', placeholder: current.available ? (state.listening ? 'Listening…' : coding ? `Ask ${current.name}` : 'Message the robot\'s agent') : 'Agent offline',
        onInput: value => { state.draft = value; }, onSubmit: value => { send(value); return false; }});
      if (coding && (current.limits?.windows?.length || current.session)) {
        const windows = current.limits?.windows || [], worst = Math.max(0, ...windows.map(window => window.used)), line = content.cutBottom(18, 4);
        const parts = [windows.map(window => `${window.label} window ${Math.round(window.used * 100)}%`).join('  ·  '), current.cwd ? current.cwd.split('/').pop() : '', current.mode ? `${current.mode} permissions` : '', current.sandbox ? `${current.sandbox} sandbox` : '', current.effort ? `${current.effort} effort` : ''];
        ui.text(parts.filter(Boolean).join('  ·  '), line.x + 4, line.cy, {size: SIZE.xs - 2, family: 'mono', color: ui.tone(worst > 0.85 ? 'warn' : 'muted', 0.9), max: line.w});
      }
      if (!current.available) { ui.wrap(current.reason || 'Not available.', content.inset(8, 24), {size: SIZE.md, color: ui.tone('muted'), lineHeight: 1.5}); return; }
      ui.scroll(content, `chat:${current.id}`, inner => {
        let y = inner.y + 4;
        if (!current.messages.length) {
          ui.text('Nothing said yet.', inner.x + 8, y + 22, {color: ui.tone('muted')});
          // With a scene on the table the agent starts where that scene's author works, not in the dimos checkout.
          ui.wrap(coding ? (app.agentFolder ? current.intro.replace('in the dimos checkout', `in ${app.agentFolder}`).replace('Ask it about the running blueprint, have', 'Ask it about the scene on the table, have') : current.intro) : 'What you type goes to the agent in the running blueprint. Its answers, the skills it calls and their results appear here.', new Rect(inner.x + 8, y + 46, inner.w - 16, 0), {size: SIZE.sm, color: ui.tone('muted', 0.8), lineHeight: 1.5});
          return 190;
        }
        for (const message of current.messages) y += drawMessage(ui, inner, y, message, current);
        if (current.busy && !current.messages.at(-1)?.streaming) {
          const running = current.messages.findLast?.(message => message.role === 'call' && message.state === 'running');
          const waiting = current.messages.some(message => message.role === 'permission' && message.state === 'pending');
          ui.text(waiting ? 'waiting for your answer' : running ? `running ${running.tool}…` : `${'·'.repeat(Math.floor(ui.now / 350) % 4 + 1)}`, inner.x + 14, y + 12, {size: waiting || running ? SIZE.xs : SIZE.xl, family: 'mono', color: ui.tone('agent')});
          y += 30; panel.invalidate();
        }
        return y - inner.y;
      }, {stickBottom: true});
    },
  });
  for (const agent of all) agent.addEventListener('change', () => panel.invalidate(), {signal: panel.signal});
  panel.onDispose = () => recognition?.stop();
  // A draft goes to a coding agent: the robot's own agent is not the one to write a Python call.
  panel.setDraft = text => { if (!(backend() instanceof SessionAgent)) { const coding = codingAgent(app); if (coding) state.backend = coding.id; } state.draft = text; if (app.text.active) app.text.blur(); panel.invalidate(); };
  if (draft !== undefined) panel.setDraft(draft);
  for (const agent of all) agent.refresh?.();
  return app.dock.open(panel, 'right');
}
