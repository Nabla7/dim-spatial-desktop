// Talking to an agent: a transcript, a text box (typed, or dictated where the browser can), send.
import {SIZE} from '../ui/holo.js';
import {Rect} from '../ui/rect.js';
import {BlueprintAgent, DesktopAgent} from '../data/agents.js';

const Recognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;

export function openAgent(app) {
  const id = 'agent';
  if (app.dock.has(id)) { app.dock.close(id); return; }
  app.agents ||= [new BlueprintAgent(app), new DesktopAgent(app)];
  const state = {backend: app.agents.find(agent => agent.available)?.id || app.agents[0].id, draft: '', listening: false};
  const backend = () => app.agents.find(agent => agent.id === state.backend);
  let recognition = null;

  function send(text) {
    const value = String(text ?? state.draft).trim();
    if (!value || !backend().available) return;
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

  function bubble(ui, inner, y, message) {
    const mine = message.role === 'user', toolish = message.role === 'tool' || message.role === 'call';
    const width = inner.w * (toolish ? 0.94 : 0.84), size = toolish ? SIZE.xs : SIZE.md, family = toolish ? 'mono' : 'sans';
    const tone = mine ? 'primary' : message.role === 'assistant' ? 'agent' : message.role === 'call' ? 'alt' : 'muted';
    const text = message.role === 'call' ? `${message.tool}(${message.text === '{}' ? '' : message.text})` : message.text;
    const pad = 12, head = toolish || message.role === 'system' ? 0 : 0, body = new Rect(0, 0, width - pad * 2, 0);
    const height = ui.wrap(text, body, {size, family, measure: true, maxLines: toolish ? 6 : 60, lineHeight: 1.4});
    const box = new Rect(mine ? inner.r - width : inner.x, y, width, height + pad * 2 + head);
    if (toolish) {
      ui.ctx.fillStyle = ui.tone(tone, 0.06); ui.ctx.fillRect(box.x, box.y, box.w, box.h);
      ui.ctx.fillStyle = ui.tone(tone, 0.8); ui.ctx.fillRect(box.x, box.y, 3, box.h);
      if (message.role === 'tool') ui.text(message.tool, box.r - 8, box.y + 12, {size: SIZE.xs - 2, family: 'mono', color: ui.tone('muted', 0.8), align: 'right'});
    } else {
      ui.chamfer(box, 10); ui.ctx.fillStyle = ui.tone(tone, mine ? 0.13 : 0.07); ui.ctx.fill();
      ui.ctx.strokeStyle = ui.tone(tone, mine ? 0.5 : 0.35); ui.ctx.lineWidth = 1.2; ui.ctx.stroke();
    }
    ui.wrap(text, new Rect(box.x + pad, box.y + pad + head, body.w, 0), {size, family, color: ui.tone(toolish ? (message.role === 'call' ? 'alt' : 'muted') : message.pending ? 'muted' : 'fg'), maxLines: toolish ? 6 : 60, lineHeight: 1.4});
    return box.h + 10;
  }

  const panel = app.panel({
    id, title: 'Agent', glyph: 'agent', width: 0.46, height: 0.62, onClose: () => app.dock.close(id),
    draw(ui, content) {
      const current = backend();
      panel.tag = current.busy ? 'WORKING' : current.available ? 'READY' : 'OFFLINE'; panel.busy = current.busy;
      ui.chips(content.cutTop(36, 10), app.agents.map(agent => [agent.id, agent.title]), state.backend, value => { state.backend = value; }, {id: 'backend', size: SIZE.xs, tone: 'agent'});
      const entry = content.cutBottom(50, 10);
      if (Recognition) ui.button(entry.cutLeft(50, 8), '', dictate, {id: 'mic', icon: 'mic', tone: state.listening ? 'danger' : 'agent', on: state.listening, enabled: current.available});
      ui.button(entry.cutRight(58, 8), '', () => send(), {id: 'send', icon: 'send', tone: 'agent', on: !!state.draft.trim() && current.available, enabled: current.available});
      ui.field(entry, state.draft, {id: 'draft', placeholder: current.available ? (state.listening ? 'Listening…' : 'Message the agent') : 'Agent offline',
        onInput: value => { state.draft = value; }, onSubmit: value => { send(value); return false; }});
      if (!current.available) { ui.wrap(current.reason || 'Not available.', content.inset(8, 24), {size: SIZE.md, color: ui.tone('muted'), lineHeight: 1.5}); return; }
      ui.scroll(content, `chat:${current.id}`, inner => {
        let y = inner.y + 4;
        if (!current.messages.length) {
          ui.text('Nothing said yet.', inner.x + 8, y + 22, {color: ui.tone('muted')});
          ui.wrap('What you type goes to the agent in the running blueprint. Its answers, the skills it calls and their results appear here.', new Rect(inner.x + 8, y + 46, inner.w - 16, 0), {size: SIZE.sm, color: ui.tone('muted', 0.8)});
          return 130;
        }
        for (const message of current.messages) y += bubble(ui, inner, y, message);
        if (current.busy) { const t = Math.floor(ui.now / 350) % 4; ui.text('·'.repeat(t + 1), inner.x + 12, y + 10, {size: SIZE.xl, color: ui.tone('agent')}); y += 30; panel.invalidate(); }
        return y - inner.y;
      }, {stickBottom: true});
    },
  });
  for (const agent of app.agents) agent.addEventListener('change', () => panel.invalidate(), {signal: panel.signal});
  panel.onDispose = () => recognition?.stop();
  return app.dock.open(panel, 'right');
}
