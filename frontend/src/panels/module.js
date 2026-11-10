// One module instance: what it is, the RPCs it exposes and its streams with their live rates.
//
// An RPC is a form made from its signature. The form tries to leave nothing to guess: each parameter
// gets the editor its type calls for (a list of numbers is typed as "1, 2, 3", not as JSON), the help
// its docstring has, values to pick from where the running system knows them (joint names, frames,
// module ids), and a slider where a range is known. Behind the form are the method's own source (CODE)
// and a coding agent that reads it and says what the parameters mean, with values that would work (ASK).
// A parameter that is a Python object cannot be sent from a page; the form says so and what to do instead.
import {SIZE} from '../ui/holo.js';
import {Rect} from '../ui/rect.js';
import {gateway} from '../data/gateway.js';
import {FORM_ASK} from '../data/agents.js';
import {PLUMBING} from '../data/controls.js';
import {brief, coerce, editable, hz, paramHint, paramKind, parseDoc, pythonValue, words} from '../util.js';
import {codingAgent, openAgent} from './agent.js';
import {openControl} from './control.js';

const ROW = 50, FIELD = 44;

const stored = (name, fallback = {}) => { try { return JSON.parse(localStorage.getItem(name) || 'null') ?? fallback; } catch { return fallback; } };
const store = (name, value) => { try { localStorage.setItem(name, JSON.stringify(value)); } catch { /* private mode */ } };

// What a coding agent's answer about an RPC must look like, and the JSON found in what it wrote.
const NOTE_SHAPE = '{"summary": "<what the call does, one or two sentences>", "moves_robot": <true or false>, "params": {"<name>": "<what it is: unit, valid range or valid values>"}, "kwargs": <one complete example call as a JSON object, or null when a parameter cannot be given as JSON>, "how": "<only when kwargs is null: the shortest other way to do the same, such as the stream to publish on>"}';
function noteFrom(text) {
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('the agent did not answer in the form asked for');
  const note = JSON.parse(text.slice(start, end + 1));
  return {summary: String(note.summary || ''), moves: !!note.moves_robot, params: note.params && typeof note.params === 'object' ? note.params : {}, kwargs: note.kwargs && typeof note.kwargs === 'object' ? note.kwargs : null, how: String(note.how || '')};
}

export function openModule(app, moduleId) {
  const id = `module:${moduleId}`;
  if (app.dock.has(id)) { app.dock.close(id); return; }
  const state = {tab: 'rpcs', open: null, values: {}, results: {}, armed: null, armedAt: 0, code: {}, source: {}, notes: {}, more: {}, plumbing: false};
  const module = () => app.blueprint.module(moduleId);
  // What was typed last time and what an agent explained are kept per class, so they are there for the next run.
  const memory = rpc => `${module()?.cls}.${rpc.name}`;
  const signature = rpc => `${rpc.name}(${rpc.params.map(param => `${param.name}: ${param.type || 'Any'}${param.required ? '' : ` = ${param.default}`}`).join(', ')})${rpc.returns ? ` → ${rpc.returns}` : ''}`;
  const noteOf = rpc => state.notes[rpc.name] ?? (state.notes[rpc.name] = stored('spatial.rpc.notes')[signatureKey(rpc)] || null);
  const signatureKey = rpc => `${memory(rpc)}(${rpc.params.map(param => `${param.name}:${param.type}`).join(',')})`;

  const valuesOf = rpc => {
    if (state.values[rpc.name]) return state.values[rpc.name];
    const values = {}, kept = stored('spatial.rpc.values')[memory(rpc)] || {};
    for (const param of rpc.params) {
      const kind = paramKind(param), initial = pythonValue(param.default);
      if (kind === 'bool') values[param.name] = kept[param.name] ?? (initial === true);
      else if (kind === 'choice') values[param.name] = param.choices.includes(kept[param.name]) ? kept[param.name] : param.choices.includes(initial) ? initial : param.required ? param.choices[0] : undefined;
      else values[param.name] = kept[param.name] ?? '';
    }
    return state.values[rpc.name] = values;
  };

  // The values as the call would send them. Throws "<parameter> <what is wrong>".
  function kwargsOf(rpc) {
    const values = valuesOf(rpc), kwargs = {};
    for (const param of rpc.params) {
      const kind = paramKind(param), raw = values[param.name];
      if (kind === 'object') { if (param.required) throw new Error(`${param.name} ${`is a Python object (${param.type}); the page cannot build one`}`); continue; }
      if (raw === undefined || raw === '') { if (param.required) throw new Error(`${param.name} is required`); continue; }
      try { kwargs[param.name] = coerce(kind, raw, param); } catch (error) { throw new Error(`${param.name} ${error.message}`); }
    }
    return kwargs;
  }

  async function call(rpc) {
    let kwargs;
    try { kwargs = kwargsOf(rpc); } catch (error) { state.results[rpc.name] = {ok: false, text: error.message, at: Date.now()}; panel.invalidate(); return; }
    const started = performance.now();
    state.results[rpc.name] = {pending: true}; panel.busy = true; panel.invalidate();
    app.pulse(moduleId);
    try {
      const answer = await gateway.callRpc(moduleId, rpc.name, kwargs);
      // A result with no JSON form arrives as its Python repr: say what it is instead of printing an address.
      const opaque = typeof answer.result === 'string' && /^<([\w.]+) object at 0x[0-9a-f]+>$/.exec(answer.result);
      const shown = answer.result == null ? 'Done. The call returned nothing.' : opaque ? `Done. It returned a ${opaque[1].split('.').pop()}, a Python object the gateway cannot show as JSON.` : brief(answer.result, 1200);
      state.results[rpc.name] = {ok: !!answer.ok, text: answer.ok ? shown : String(answer.error), ms: performance.now() - started, at: Date.now()};
      if (answer.ok) { const all = stored('spatial.rpc.values'); all[memory(rpc)] = {...valuesOf(rpc)}; store('spatial.rpc.values', all); }
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

  // -- what the running system knows about a parameter ------------------------------------------------
  const robot = () => app.layers.list().find(layer => layer.kind === 'robot');
  // Values a text parameter can take, where its name says what it names. {from, values} or null.
  function candidates(rpc, param) {
    const name = param.name.toLowerCase();
    if (/joint/.test(name) || (/^names?$/.test(name) && /joint/.test(rpc.name))) return {from: 'joints of the robot model', values: Object.keys(robot()?.jointLimits || {})};
    if (/frame|link|body/.test(name)) return {from: 'TF frames', values: [...new Set([app.layers.tf.root, ...app.layers.tf.frames.keys()].filter(Boolean))]};
    if (/topic|stream|channel/.test(name)) return {from: 'topics of the blueprint', values: [...new Set(app.blueprint.modules.flatMap(entry => entry.streams.map(stream => stream.topic)))]};
    if (/module/.test(name)) return {from: 'modules of the blueprint', values: app.blueprint.modules.map(entry => entry.id)};
    return null;
  }

  // The range of a number, when another parameter of the same call names a joint with limits.
  function rangeOf(rpc, param) {
    if (paramKind(param) !== 'float' || !/position|angle|target|value|^q$|rad/.test(param.name)) return null;
    const values = valuesOf(rpc), limits = robot()?.jointLimits || {};
    for (const other of rpc.params) { const limit = limits[values[other.name]]; if (other !== param && limit && Number.isFinite(limit.lower) && Number.isFinite(limit.upper) && limit.upper > limit.lower) return [limit.lower, limit.upper]; }
    return null;
  }

  // -- the method's code, and an agent's reading of it ------------------------------------------------
  function sourceOf(rpc) {
    return state.source[rpc.name] ??= gateway.source(module().cls, rpc.name).then(found => { state.source[rpc.name] = found; panel.invalidate(); return found; })
      .catch(error => { const none = {missing: error.status === 404 ? 'This method was not found in the dimos checkout Desktop uses.' : `The code could not be read: ${error.message}`}; state.source[rpc.name] = none; panel.invalidate(); return none; });
  }

  async function explain(rpc) {
    const agent = codingAgent(app);
    if (!agent) { app.toast('No coding agent can be reached (Claude Code or Codex on this machine).', 'warn'); return; }
    if (agent.busy) { app.toast(`${agent.name} is busy with another turn.`, 'warn'); return; }
    state.notes[rpc.name] = {pending: true, by: agent.name}; panel.invalidate();
    try {
      const found = await sourceOf(rpc), current = module();
      const known = rpc.params.map(param => [param, candidates(rpc, param)]).filter(([, found]) => found?.values.length).map(([param, found]) => `Values ${param.name} can name now (${found.from}): ${found.values.slice(0, 60).join(', ')}`);
      const text = await agent.ask([
        FORM_ASK,
        `Explain one RPC of the running DimOS blueprint for the form that calls it. Do not call the RPC. Answer from the code below; read more code only if it is needed to say what a parameter accepts.`,
        `Module class: ${current.cls} (instance id "${current.id}").`,
        `RPC: ${signature(rpc)}`,
        rpc.doc ? `Docstring: ${rpc.doc}` : 'It has no docstring.',
        found.text ? `Source (${found.file}:${found.line}${found.inherited ? `, inherited from ${found.owner}` : ''}):\n${found.text}` : 'Its source was not found; look for it in the checkout.',
        ...known,
        `Answer with one JSON object and nothing else: ${NOTE_SHAPE}`,
      ].join('\n'));
      const note = {...noteFrom(text), by: agent.name};
      const all = stored('spatial.rpc.notes'); all[signatureKey(rpc)] = note; store('spatial.rpc.notes', all);
      state.notes[rpc.name] = note;
    } catch (error) { state.notes[rpc.name] = {error: error.message}; }
    panel.invalidate();
  }

  function useExample(rpc, kwargs) {
    const values = valuesOf(rpc);
    for (const param of rpc.params) if (param.name in kwargs && paramKind(param) !== 'object') values[param.name] = editable(paramKind(param), kwargs[param.name]);
    if (app.text.active) app.text.blur();
  }

  // A call the page cannot make goes to the agent's chat as a request the user finishes.
  function handOver(rpc) {
    const current = module();
    openAgent(app, {draft: `Call ${current.name}.${signature(rpc)} on the running blueprint (module id "${current.id}"). It takes a Python object, so use the dimos Python API. I want: `});
  }

  // -- drawing ----------------------------------------------------------------------------------------
  // A wrapped run of small buttons; returns the height used. `limit` rows unless more was asked for.
  function flow(ui, x, y, width, items, {id, limit = 2, onPick, selected}) {
    const height = 28, gap = 6, expanded = !!state.more[id];
    let cx = x, row = 0, shown = 0;
    for (const [value, label] of items) {
      const w = Math.min(width, ui.measure(label, SIZE.xs - 1, 600) + 22);
      if (cx + w > x + width) { cx = x; row++; }
      if (!expanded && row >= limit) break;
      ui.button(new Rect(cx, y + row * (height + gap), w, height), label, () => onPick(value), {id: `${id}:${value}`, size: SIZE.xs - 1, tone: value === selected ? 'primary' : 'muted', on: value === selected});
      cx += w + gap; shown++;
    }
    if (shown < items.length || expanded) {
      const label = expanded ? 'fewer' : `+${items.length - shown} more`, w = ui.measure(label, SIZE.xs - 1, 600) + 22;
      if (cx + w > x + width) { cx = x; row++; }
      ui.button(new Rect(cx, y + row * (height + gap), w, height), label, () => { state.more[id] = !expanded; }, {id: `${id}:@more`, size: SIZE.xs - 1, tone: 'alt'});
    }
    return (row + 1) * (height + gap);
  }

  // One parameter: its name and type, its editor, then what is known about it. Returns the height used.
  function drawParam(ui, area, y, rpc, param, help, example) {
    const values = valuesOf(rpc), kind = paramKind(param), key = `${rpc.name}.${param.name}`, fieldId = `p:${key}`;
    const set = value => { values[param.name] = value; if (panel.focusId === fieldId && typeof value === 'string') app.text.set(value); };
    const line = new Rect(area.x, y, area.w, FIELD), label = line.cutLeft(area.w * 0.34, 10), control = line.inset(0, 4);
    ui.text(param.name, label.x, label.cy - 7, {size: SIZE.sm, family: 'mono', color: ui.tone(param.required ? 'fg' : 'muted'), max: label.w});
    ui.text(String(param.type || 'any') + (param.required ? '' : ' · optional'), label.x, label.cy + 12, {size: SIZE.xs - 2, family: 'mono', color: ui.tone(kind === 'object' ? 'warn' : 'muted', 0.8), max: label.w});
    let used = FIELD + 4;
    const note = (text, tone = 'muted') => { used += ui.wrap(text, new Rect(area.x + 2, y + used, area.w - 4, 0), {size: SIZE.xs, color: ui.tone(tone, tone === 'muted' ? 0.9 : 1), lineHeight: 1.4, maxLines: 6}) + 6; };

    if (kind === 'object') {
      // Not a field: nothing typed here could become this object.
      ui.chamfer(control, 7); ui.ctx.fillStyle = ui.tone('warn', 0.07); ui.ctx.fill(); ui.ctx.strokeStyle = ui.tone('warn', 0.4); ui.ctx.lineWidth = 1.2; ui.ctx.stroke();
      ui.text('a Python object: not sendable from here', control.x + 12, control.cy + 1, {size: SIZE.xs, family: 'mono', color: ui.tone('warn'), max: control.w - 20});
      const twin = module().streams.find(stream => stream.direction !== 'out' && stream.pythonType === String(param.type).replace(/\s*\|\s*None/, ''));
      if (help) note(help);
      if (twin) {
        note(`This module also reads a ${twin.pythonType} on ${twin.topic}: a message published there does the same.`, 'info');
        // A velocity command has a control made for it.
        if (/Twist/.test(twin.pythonType)) { ui.button(new Rect(area.x, y + used, 200, 34), 'OPEN DRIVE CONTROL', () => { if (!app.dock.has('control')) openControl(app); }, {id: `drive:${key}`, size: SIZE.xs, icon: 'robot'}); used += 42; }
      }
      return used;
    }
    if (kind === 'bool') ui.toggle(control, '', values[param.name], set, {id: fieldId});
    else if (kind === 'choice') {
      const choices = param.choices;
      if (choices.length <= 4) ui.chips(control, choices.map(choice => [choice, String(choice)]), values[param.name], set, {id: fieldId});
      else {
        const index = Math.max(0, choices.indexOf(values[param.name]));
        ui.button(control.cutLeft(40, 6), '', () => set(choices[(index - 1 + choices.length) % choices.length]), {id: `${fieldId}:prev`, icon: 'back'});
        ui.button(control.cutRight(40, 6), '', () => set(choices[(index + 1) % choices.length]), {id: `${fieldId}:next`, icon: 'chevron'});
        ui.text(String(values[param.name] ?? '—'), control.cx, control.cy + 1, {size: SIZE.md, family: 'mono', align: 'center', max: control.w});
      }
    } else {
      const numeric = kind === 'int' || kind === 'float', range = rangeOf(rpc, param);
      if (numeric) {
        const step = kind === 'int' ? 1 : range ? (range[1] - range[0]) / 50 : 0.1, bump = sign => {
          const now = Number(values[param.name] === '' ? pythonValue(param.default) ?? 0 : values[param.name]) || 0;
          const next = now + sign * step;
          set(String(+(range ? Math.min(range[1], Math.max(range[0], next)) : next).toFixed(4)));
        };
        ui.button(control.cutRight(38, 6), '', () => bump(1), {id: `${fieldId}:up`, icon: 'plus'});
        ui.button(control.cutRight(38, 6), '', () => bump(-1), {id: `${fieldId}:down`, icon: 'minus'});
      }
      // The empty box says what to type: a value known to work (from an agent's reading), else the default, else the shape.
      const fallback = param.default === null || param.default === undefined ? '' : `default ${param.default}`;
      const hint = example !== undefined && example !== null ? `e.g. ${editable(kind, example)}` : param.required ? paramHint(param, kind) : fallback || paramHint(param, kind);
      ui.field(control, values[param.name], {id: fieldId, family: 'mono', numeric, placeholder: hint,
        onInput: value => { values[param.name] = value; }, onSubmit: () => { call(rpc); }});
      if (range) {
        // The joint named in this call has limits: a slider over them.
        const at = Number(values[param.name]), value = values[param.name] !== '' && Number.isFinite(at) ? at : Math.min(range[1], Math.max(range[0], 0));
        ui.slider(new Rect(area.x + area.w * 0.34 + 10, y + used, area.w * 0.66 - 10, 34), Math.min(range[1], Math.max(range[0], value)), range[0], range[1], next => set(String(+next.toFixed(3))), {id: `${fieldId}:slide`, format: next => `${next.toFixed(2)} rad`});
        used += 40;
        ui.text(`limits ${range[0].toFixed(2)} … ${range[1].toFixed(2)} rad, from the robot model`, area.x + 2, y + used + 6, {size: SIZE.xs - 1, family: 'mono', color: ui.tone('muted', 0.85), max: area.w});
        used += 20;
      }
    }
    if (help) note(help);
    if (kind === 'str') {
      const found = candidates(rpc, param);
      if (found?.values.length) {
        // Typing narrows the list; a press fills the box.
        const typed = String(values[param.name] || '').toLowerCase(), exact = found.values.includes(values[param.name]);
        // The chosen one leads the list, so it shows without unfolding the rest.
        const matching = exact ? [values[param.name], ...found.values.filter(value => value !== values[param.name])] : !typed ? found.values : found.values.filter(value => value.toLowerCase().includes(typed));
        const short = value => value.split('/').pop().replace(/_joint$/, '');
        ui.text(`${matching.length} of ${found.values.length} ${found.from}${typed && !exact ? ` matching "${values[param.name]}"` : ''}`, area.x + 2, y + used + 8, {size: SIZE.xs - 1, family: 'mono', color: ui.tone('muted', 0.85), max: area.w});
        used += 22;
        if (matching.length) used += flow(ui, area.x, y + used, area.w, matching.map(value => [value, short(value)]), {id: `pick:${key}`, onPick: set, selected: values[param.name]});
      }
    }
    return used + 4;
  }

  // The open form of one RPC, drawn from y down. Returns the y after it.
  function drawForm(ui, inner, y, rpc) {
    const body = new Rect(inner.x + 14, y, inner.w - 18, 0), result = state.results[rpc.name], note = noteOf(rpc), doc = parseDoc(rpc.doc), current = module();
    const text = (string, options) => { y += ui.wrap(string, new Rect(body.x, y, body.w, 0), options) + 8; };
    ui.hair(inner.x + 2, y, inner.x + 2, y + 8, ui.tone(rpc.skill ? 'alt' : 'primary'), 3);
    y += 6;
    text(signature(rpc), {size: SIZE.xs, family: 'mono', color: ui.tone('primary', 0.9), maxLines: 4, lineHeight: 1.4});
    if (doc.summary) text(doc.summary, {size: SIZE.sm, color: ui.tone('muted'), maxLines: 8});
    if (note?.summary) {
      // What an agent made of the code, marked as such.
      const height = ui.wrap(note.summary, new Rect(body.x + 12, y, body.w - 12, 0), {size: SIZE.sm, measure: true, maxLines: 8});
      ui.ctx.fillStyle = ui.tone('agent', 0.9); ui.ctx.fillRect(body.x, y - 2, 3, height + 22);
      ui.wrap(note.summary, new Rect(body.x + 12, y, body.w - 12, 0), {size: SIZE.sm, color: ui.tone('fg'), maxLines: 8});
      ui.text(`${note.by || 'an agent'} read the code${note.moves ? '  ·  this call moves the robot' : ''}`, body.x + 12, y + height + 12, {size: SIZE.xs - 2, family: 'mono', color: ui.tone(note.moves ? 'warn' : 'muted', 0.9), max: body.w - 12});
      y += height + 30;
    }
    for (const param of rpc.params) y += drawParam(ui, body, y, rpc, param, [doc.params[param.name], note?.params?.[param.name] && String(note.params[param.name])].filter(Boolean).join('  ·  '), note?.kwargs?.[param.name]);
    if (!rpc.params.length && !doc.summary && !note?.summary) text('This call takes nothing.', {size: SIZE.xs, color: ui.tone('muted')});

    const blocked = rpc.params.find(param => param.required && paramKind(param) === 'object'), pending = !!result?.pending;
    const action = new Rect(body.x, y + 4, body.w, 44), pinned = app.controls.pinned(current, rpc), asking = !!note?.pending;
    if (blocked) ui.button(action.cutLeft(200, 8), 'HAND TO AGENT', () => handOver(rpc), {id: `hand:${rpc.name}`, tone: 'agent', icon: 'send', size: SIZE.xs, on: true});
    else ui.button(action.cutLeft(150, 8), pending ? 'CALLING…' : 'CALL', () => call(rpc), {id: `call:${rpc.name}`, tone: rpc.skill ? 'alt' : 'primary', icon: 'play', enabled: !pending, on: !pending});
    if (!blocked) ui.button(action.cutLeft(44, 8), '', () => { try { app.controls.pin(current, rpc, pinned ? {} : kwargsOf(rpc)); app.toast(pinned ? `${rpc.name} is no longer in CONTROL → ACTIONS` : `${rpc.name} is now one press in CONTROL → ACTIONS, with these values`, 'ok'); } catch (error) { app.toast(`Cannot pin: ${error.message}`, 'warn'); } }, {id: `pin:${rpc.name}`, icon: 'pin', tone: 'alt', on: pinned});
    ui.button(action.cutLeft(84, 8), 'CODE', () => { state.code[rpc.name] = !state.code[rpc.name]; if (state.code[rpc.name]) sourceOf(rpc); }, {id: `code:${rpc.name}`, size: SIZE.xs, tone: 'muted', on: !!state.code[rpc.name]});
    ui.button(action.cutLeft(Math.min(action.w, 150), 0), asking ? 'READING…' : note?.summary ? 'ASK AGAIN' : 'EXPLAIN', () => explain(rpc), {id: `ask:${rpc.name}`, size: SIZE.xs, tone: 'agent', icon: 'agent', enabled: !asking});
    y += 56;
    if (asking) panel.invalidate();
    if (note?.error) text(`The agent's answer could not be used: ${note.error}`, {size: SIZE.xs, color: ui.tone('warn'), maxLines: 4});
    if (note?.kwargs && !blocked) {
      const row = new Rect(body.x, y, body.w, 34);
      ui.button(row.cutLeft(150, 10), 'USE EXAMPLE', () => useExample(rpc, note.kwargs), {id: `example:${rpc.name}`, size: SIZE.xs, tone: 'agent'});
      ui.text(brief(note.kwargs, 200).replace(/\s+/g, ' '), row.x, row.cy + 1, {size: SIZE.xs, family: 'mono', color: ui.tone('muted'), max: row.w});
      y += 42;
    }
    if (note?.how) text(note.how, {size: SIZE.xs, color: ui.tone('info'), maxLines: 6, lineHeight: 1.4});
    if (state.code[rpc.name]) {
      const found = state.source[rpc.name], ready = found && !(found instanceof Promise);
      const shown = !ready ? 'Reading the code…' : found.missing || found.text, box = new Rect(body.x, y, body.w - 4, 0);
      const height = ui.wrap(shown, new Rect(0, 0, box.w - 24, 0), {size: SIZE.xs, family: 'mono', measure: true, maxLines: 60, lineHeight: 1.45});
      box.h = height + (ready && found.text ? 44 : 20);
      ui.chamfer(box, 8); ui.ctx.fillStyle = ui.tone('input', 0.9); ui.ctx.fill(); ui.ctx.strokeStyle = ui.tone('muted', 0.4); ui.ctx.lineWidth = 1; ui.ctx.stroke();
      if (ready && found.text) ui.text(`${found.file}:${found.line}${found.inherited ? `  ·  from ${found.owner}` : ''}${found.lines > 160 ? `  ·  first 160 of ${found.lines} lines` : ''}`, box.x + 12, box.y + 15, {size: SIZE.xs - 2, family: 'mono', color: ui.tone('muted'), max: box.w - 24});
      ui.wrap(shown, new Rect(box.x + 12, box.y + (ready && found.text ? 34 : 10), box.w - 24, 0), {size: SIZE.xs, family: 'mono', color: ui.tone(ready && found.text ? 'info' : 'muted'), maxLines: 60, lineHeight: 1.45});
      y += box.h + 10;
    }
    if (result && !result.pending) {
      const box = new Rect(body.x, y, body.w - 4, 0);
      const height = ui.wrap(result.text, box.inset(12, 10), {size: SIZE.sm, family: 'mono', measure: true, maxLines: 14});
      box.h = height + 44;
      ui.chamfer(box, 8); ui.ctx.fillStyle = ui.tone(result.ok ? 'ok' : 'danger', 0.07); ui.ctx.fill();
      ui.ctx.strokeStyle = ui.tone(result.ok ? 'ok' : 'danger', 0.55); ui.ctx.lineWidth = 1.2; ui.ctx.stroke();
      ui.text(result.ok ? 'RESULT' : 'NOT CALLED / ERROR', box.x + 12, box.y + 16, {size: SIZE.xs - 1, family: 'display', color: ui.tone(result.ok ? 'ok' : 'danger'), track: 2});
      if (result.ms !== undefined) ui.text(`${Math.round(result.ms)} ms`, box.r - 12, box.y + 16, {size: SIZE.xs, family: 'mono', color: ui.tone('muted'), align: 'right'});
      ui.wrap(result.text, box.inset(12, 32, 12, 8), {size: SIZE.sm, family: 'mono', color: ui.tone(result.ok ? 'fg' : 'danger'), maxLines: 14});
      y += box.h + 10;
    }
    return y + 6;
  }

  function drawRpcs(ui, inner, current) {
    let y = inner.y;
    if (!current.rpcs.length) { ui.empty(inner.clone().cutTop(200), 'This module exposes no RPCs.'); return 200; }
    // The calls a person makes first; the ones the blueprint's own start-up uses fold away below them.
    const own = current.rpcs.filter(rpc => !PLUMBING.test(rpc.name)), plumbing = current.rpcs.filter(rpc => PLUMBING.test(rpc.name));
    const row = rpc => {
      const open = state.open === rpc.name, line = inner.clone(); line.y = y; line.h = ROW;
      const hot = ui.row(line, {id: `rpc:${rpc.name}`, selected: open, tone: rpc.skill ? 'alt' : 'primary', onClick: () => { state.open = open ? null : rpc.name; }});
      ui.icon(rpc.skill ? 'skill' : 'rpc', line.x + 22, line.cy, 20, ui.tone(rpc.skill ? 'alt' : 'primary', hot || open ? 1 : 0.75));
      const nameWidth = ui.text(rpc.name, line.x + 44, line.cy + 1, {size: SIZE.md, family: 'mono', weight: 500, max: line.w - 150});
      ui.text(`(${rpc.params.map(param => param.name).join(', ')})`, line.x + 48 + nameWidth, line.cy + 1, {size: SIZE.sm, family: 'mono', color: ui.tone('muted'), max: Math.max(0, line.w - nameWidth - 150)});
      if (rpc.skill) ui.badge(line.r - 34, line.cy, 'SKILL', {tone: 'alt', align: 'right'});
      ui.icon(open ? 'down' : 'chevron', line.r - 14, line.cy, 14, ui.tone('muted'));
      const result = state.results[rpc.name];
      if (result && !open) ui.lamp(line.r - (rpc.skill ? 110 : 40), line.cy, result.pending ? 'warn' : result.ok ? 'ok' : 'danger', !!result.pending);
      y += ROW;
      if (open) y = drawForm(ui, inner, y, rpc);
      ui.hair(inner.x, y, inner.r, y);
    };
    own.forEach(row);
    if (plumbing.length) {
      const line = inner.clone(); line.y = y; line.h = 38;
      ui.row(line, {id: 'plumbing', onClick: () => { state.plumbing = !state.plumbing; }});
      ui.icon(state.plumbing ? 'down' : 'chevron', line.x + 22, line.cy, 12, ui.tone('muted'));
      ui.text(`${plumbing.length} more that the blueprint's own start-up calls`, line.x + 44, line.cy + 1, {size: SIZE.xs, family: 'mono', color: ui.tone('muted'), max: line.w - 60});
      y += 38; ui.hair(inner.x, y, inner.r, y);
      if (state.plumbing) plumbing.forEach(row);
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
