// One module instance: what it is, the RPCs it exposes (with a form built from each RPC's signature,
// and a button that calls it), and its streams with their live rates.
import {SIZE} from '../ui/holo.js';
import {Rect} from '../ui/rect.js';
import {gateway} from '../data/gateway.js';
import {brief, coerce, hz, paramKind, pythonValue, words} from '../util.js';

const ROW = 50, FIELD = 44;

export function openModule(app, moduleId) {
  const id = `module:${moduleId}`;
  if (app.dock.has(id)) { app.dock.close(id); return; }
  const state = {tab: 'rpcs', open: null, values: {}, results: {}, armed: null, armedAt: 0};
  const module = () => app.blueprint.module(moduleId);

  const valuesOf = rpc => {
    if (state.values[rpc.name]) return state.values[rpc.name];
    const values = {};
    for (const param of rpc.params) {
      const kind = paramKind(param), initial = pythonValue(param.default);
      if (kind === 'bool') values[param.name] = initial === true;
      else if (kind === 'choice') values[param.name] = param.choices.includes(initial) ? initial : param.required ? param.choices[0] : undefined;
      else values[param.name] = '';
    }
    return state.values[rpc.name] = values;
  };

  async function call(rpc) {
    const values = valuesOf(rpc), kwargs = {};
    try {
      for (const param of rpc.params) {
        const kind = paramKind(param), raw = values[param.name];
        if (raw === undefined || raw === '') { if (param.required) throw new Error(`${param.name} is required`); continue; }
        try { kwargs[param.name] = coerce(kind, raw); } catch (error) { throw new Error(`${param.name} ${error.message}`); }
      }
    } catch (error) { state.results[rpc.name] = {ok: false, text: error.message, at: Date.now()}; panel.invalidate(); return; }
    const started = performance.now();
    state.results[rpc.name] = {pending: true}; panel.busy = true; panel.invalidate();
    app.pulse(moduleId);
    try {
      const answer = await gateway.callRpc(moduleId, rpc.name, kwargs);
      state.results[rpc.name] = {ok: !!answer.ok, text: answer.ok ? brief(answer.result, 1200) : String(answer.error), ms: performance.now() - started, at: Date.now()};
    } catch (error) {
      state.results[rpc.name] = {ok: false, text: error.message, ms: performance.now() - started, at: Date.now()};
    }
    panel.busy = false; panel.invalidate();
  }

  // Restart and unload change the running robot stack: the first press arms the button, the second acts.
  async function act(kind) {
    if (state.armed !== kind || performance.now() - state.armedAt > 3000) { state.armed = kind; state.armedAt = performance.now(); panel.invalidate(); return; }
    state.armed = null; panel.busy = true; panel.invalidate();
    try {
      const answer = await (kind === 'restart' ? gateway.restartModule(moduleId) : gateway.stopModule(moduleId));
      app.toast(answer.ok === false ? `${kind} failed: ${answer.error}` : `${words(module()?.name || moduleId)}: ${kind === 'restart' ? 'restarted' : 'unloaded'}`, answer.ok === false ? 'danger' : 'ok');
      app.blueprint.loadModules();
    } catch (error) { app.toast(`${kind} failed: ${error.message}`, 'danger'); }
    panel.busy = false; panel.invalidate();
  }

  function drawParam(ui, rect, rpc, param) {
    const values = valuesOf(rpc), kind = paramKind(param), label = rect.cutLeft(rect.w * 0.36, 10);
    ui.text(param.name, label.x, label.cy - 7, {size: SIZE.sm, family: 'mono', color: ui.tone(param.required ? 'fg' : 'muted'), max: label.w});
    ui.text(String(param.type || 'any') + (param.required ? '' : ' · optional'), label.x, label.cy + 12, {size: SIZE.xs - 2, family: 'mono', color: ui.tone('muted', 0.75), max: label.w});
    const key = `${rpc.name}.${param.name}`, set = value => { values[param.name] = value; };
    const control = rect.inset(0, 4);
    if (kind === 'bool') ui.toggle(control, '', values[param.name], set, {id: `p:${key}`});
    else if (kind === 'choice') {
      const choices = param.choices;
      if (choices.length <= 4) ui.chips(control, choices.map(choice => [choice, String(choice)]), values[param.name], set, {id: `p:${key}`});
      else {
        const index = Math.max(0, choices.indexOf(values[param.name]));
        ui.button(control.cutLeft(40, 6), '', () => set(choices[(index - 1 + choices.length) % choices.length]), {id: `p:${key}:prev`, icon: 'back'});
        ui.button(control.cutRight(40, 6), '', () => set(choices[(index + 1) % choices.length]), {id: `p:${key}:next`, icon: 'chevron'});
        ui.text(String(values[param.name] ?? '—'), control.cx, control.cy + 1, {size: SIZE.md, family: 'mono', align: 'center', max: control.w});
      }
    } else {
      const numeric = kind === 'int' || kind === 'float';
      if (numeric) {
        const step = kind === 'int' ? 1 : 0.1, bump = sign => {
          const now = Number(values[param.name] === '' ? pythonValue(param.default) ?? 0 : values[param.name]) || 0;
          set(String(+(now + sign * step).toFixed(6)));
        };
        ui.button(control.cutRight(38, 6), '', () => bump(1), {id: `p:${key}:up`, icon: 'plus'});
        ui.button(control.cutRight(38, 6), '', () => bump(-1), {id: `p:${key}:down`, icon: 'minus'});
      }
      const fallback = param.default === null || param.default === undefined ? '' : String(param.default);
      ui.field(control, values[param.name], {id: `p:${key}`, family: 'mono', numeric, placeholder: param.required ? kind : fallback || kind,
        onInput: set, onSubmit: () => { call(rpc); }});
    }
  }

  function drawRpcs(ui, inner, current) {
    let y = inner.y;
    if (!current.rpcs.length) { ui.empty(inner.clone().cutTop(200), 'This module exposes no RPCs.'); return 200; }
    for (const rpc of current.rpcs) {
      const open = state.open === rpc.name, row = inner.clone(); row.y = y; row.h = ROW;
      const hot = ui.row(row, {id: `rpc:${rpc.name}`, selected: open, tone: rpc.skill ? 'alt' : 'primary', onClick: () => { state.open = open ? null : rpc.name; }});
      ui.icon(rpc.skill ? 'skill' : 'rpc', row.x + 22, row.cy, 20, ui.tone(rpc.skill ? 'alt' : 'primary', hot || open ? 1 : 0.75));
      const signature = rpc.params.map(param => param.name).join(', ');
      const nameWidth = ui.text(rpc.name, row.x + 44, row.cy + 1, {size: SIZE.md, family: 'mono', weight: 500, max: row.w - 150});
      ui.text(`(${signature})`, row.x + 48 + nameWidth, row.cy + 1, {size: SIZE.sm, family: 'mono', color: ui.tone('muted'), max: Math.max(0, row.w - nameWidth - 150)});
      if (rpc.skill) ui.badge(row.r - 34, row.cy, 'SKILL', {tone: 'alt', align: 'right'});
      ui.icon(open ? 'down' : 'chevron', row.r - 14, row.cy, 14, ui.tone('muted'));
      const result = state.results[rpc.name];
      if (result && !open) ui.lamp(row.r - (rpc.skill ? 110 : 40), row.cy, result.pending ? 'warn' : result.ok ? 'ok' : 'danger', !!result.pending);
      y += ROW;
      if (open) {
        const body = inner.clone(); body.x += 14; body.w -= 14;
        ui.hair(inner.x + 2, y, inner.x + 2, y + 8, ui.tone(rpc.skill ? 'alt' : 'primary'), 3);
        y += 6;
        if (rpc.doc) { body.y = y; y += ui.wrap(rpc.doc, body, {size: SIZE.sm, color: ui.tone('muted'), maxLines: 8}) + 8; }
        for (const param of rpc.params) {
          const line = body.clone(); line.y = y; line.h = FIELD;
          drawParam(ui, line, rpc, param); y += FIELD + 4;
        }
        const action = body.clone(); action.y = y + 4; action.h = 46;
        const pending = !!result?.pending;
        ui.button(action.cutLeft(190, 12), pending ? 'CALLING…' : 'CALL', () => call(rpc), {id: `call:${rpc.name}`, tone: rpc.skill ? 'alt' : 'primary', icon: 'play', enabled: !pending, on: !pending});
        ui.text(rpc.returns ? `→ ${rpc.returns}` : '', action.x, action.cy + 1, {size: SIZE.sm, family: 'mono', color: ui.tone('muted'), max: action.w});
        y += 58;
        if (result && !result.pending) {
          const box = body.clone(); box.y = y; box.w -= 4;
          const height = ui.wrap(result.text, box.inset(12, 10), {size: SIZE.sm, family: 'mono', measure: true, maxLines: 14});
          box.h = height + 44;
          ui.chamfer(box, 8); ui.ctx.fillStyle = ui.tone(result.ok ? 'ok' : 'danger', 0.07); ui.ctx.fill();
          ui.ctx.strokeStyle = ui.tone(result.ok ? 'ok' : 'danger', 0.55); ui.ctx.lineWidth = 1.2; ui.ctx.stroke();
          ui.text(result.ok ? 'RESULT' : 'ERROR', box.x + 12, box.y + 16, {size: SIZE.xs - 1, family: 'display', color: ui.tone(result.ok ? 'ok' : 'danger'), track: 2});
          if (result.ms !== undefined) ui.text(`${Math.round(result.ms)} ms`, box.r - 12, box.y + 16, {size: SIZE.xs, family: 'mono', color: ui.tone('muted'), align: 'right'});
          const textRect = box.inset(12, 32, 12, 8);
          ui.wrap(result.text, textRect, {size: SIZE.sm, family: 'mono', color: ui.tone(result.ok ? 'fg' : 'danger'), maxLines: 14});
          y += box.h + 10;
        }
        y += 6;
      }
      ui.hair(inner.x, y, inner.r, y);
    }
    return y - inner.y;
  }

  function drawStreams(ui, inner, current) {
    let y = inner.y;
    if (!current.streams.length) { ui.empty(inner.clone().cutTop(200), 'This module has no streams.'); return 200; }
    for (const stream of current.streams) {
      const row = inner.clone(); row.y = y; row.h = 62;
      const topic = app.blueprint.topics.get(stream.key), layer = stream.key ? app.layers.get(stream.key) : null;
      const hot = ui.row(row, {id: `stream:${stream.name}`, selected: !!layer?.visible, onClick: () => { if (layer) app.layers.toggle(stream.key); }});
      const tone = stream.direction === 'in' ? 'info' : stream.direction === 'out' ? 'ok' : 'warn';
      ui.badge(row.x + 10, row.y + 20, stream.direction === 'inout' ? 'I/O' : stream.direction.toUpperCase(), {tone});
      ui.text(stream.name, row.x + 62, row.y + 20, {size: SIZE.md, weight: 500, max: row.w - 250});
      ui.text(stream.topic, row.x + 62, row.y + 44, {size: SIZE.xs, family: 'mono', color: ui.tone('muted'), max: row.w - 250});
      ui.text(stream.type || '—', row.r - 12, row.y + 20, {size: SIZE.xs, family: 'mono', color: ui.tone('primary', 0.9), align: 'right', max: 190});
      ui.text(hz(topic?.hz), row.r - (layer ? 44 : 12), row.y + 44, {size: SIZE.sm, family: 'mono', color: ui.tone(topic?.hz ? 'fg' : 'muted'), align: 'right'});
      if (layer) ui.icon(layer.visible ? 'eye' : 'eyeOff', row.r - 20, row.y + 44, 18, ui.tone(layer.visible ? 'primary' : 'muted', hot ? 1 : 0.8));
      if (topic?.history?.length > 2) ui.spark(new Rect(row.r - 300, row.y + 34, 110, 20), topic.history, {tone});
      y += 62; ui.hair(inner.x, y, inner.r, y);
    }
    return y - inner.y;
  }

  const panel = app.panel({
    id, title: words(module()?.name || moduleId), tag: moduleId, width: 0.44, height: app.dock.sideHeight(0.64), glyph: 'module',
    onClose: () => app.dock.close(id),
    draw(ui, content) {
      const current = module();
      if (!current) { ui.empty(content, 'This module is no longer running.', 'Close the panel, or launch the blueprint again.'); return; }
      if (current.doc) { const used = ui.wrap(current.doc, content.clone(), {size: SIZE.sm, color: ui.tone('muted'), maxLines: 3}); content.cutTop(used + 10); }
      const process = app.blueprint.processOf(current);
      const meta = content.cutTop(26, 8);
      ui.text(current.cls, meta.x, meta.cy, {size: SIZE.xs, family: 'mono', color: ui.tone('muted', 0.8), max: meta.w - (process ? 200 : 0)});
      if (process) ui.text(`pid ${process.pid} · cpu ${Math.round(process.cpu_percent)}%`, meta.r, meta.cy, {size: SIZE.xs, family: 'mono', color: ui.tone('info'), align: 'right'});
      const bar = content.cutTop(42, 12), now = performance.now(), armed = state.armed && now - state.armedAt < 3000 ? state.armed : null;
      if (state.armed && !armed) state.armed = null;
      if (armed) panel.invalidate();
      ui.button(bar.cutRight(104, 8), armed === 'unload' ? 'CONFIRM' : 'UNLOAD', () => act('unload'), {id: 'unload', tone: 'danger', size: SIZE.xs, on: armed === 'unload'});
      ui.button(bar.cutRight(104, 14), armed === 'restart' ? 'CONFIRM' : 'RESTART', () => act('restart'), {id: 'restart', tone: 'warn', size: SIZE.xs, on: armed === 'restart'});
      ui.chips(bar, [['rpcs', `RPCS ${current.rpcs.length}`], ['streams', `STREAMS ${current.streams.length}`]], state.tab, tab => { state.tab = tab; }, {id: 'tab'});
      ui.scroll(content, state.tab, inner => state.tab === 'rpcs' ? drawRpcs(ui, inner, current) : drawStreams(ui, inner, current));
    },
  });
  for (const type of ['modules', 'rates', 'stats']) app.blueprint.addEventListener(type, () => panel.invalidate(), {signal: panel.signal});
  app.layers.addEventListener('change', () => panel.invalidate(), {signal: panel.signal});
  app.dock.open(panel, 'right');
  app.select(moduleId);
  return panel;
}
