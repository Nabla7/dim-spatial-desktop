// Driving the robot from the panel. What is here depends on the blueprint (data/controls.js): a pad for
// each stream of velocity commands, a slider for each number a module reads, a "point at it" for each
// pose, a jog for joint commands, and a button for each RPC that needs nothing typed.
// Everything but STOP is dead until ARMED is on.
import {SIZE} from '../ui/holo.js';
import {Rect} from '../ui/rect.js';
import {gateway} from '../data/gateway.js';
import {brief, words} from '../util.js';
import {FORM_ASK} from '../data/agents.js';
import {codingAgent} from './agent.js';

export function openControl(app) {
  const id = 'control';
  if (app.dock.has(id)) { app.dock.close(id); return; }
  const controls = app.controls, state = {tab: null, jointTarget: null, pad: [0, 0], results: {}, targets: {}, asking: null};
  const short = target => target.topic.replace(/^\//, '');

  async function run(action) {
    const key = `${action.module.id}.${action.rpc.name}`;
    state.results[key] = {pending: true}; panel.invalidate(); app.pulse(action.module.id);
    try {
      const answer = await gateway.callRpc(action.module.id, action.rpc.name, action.kwargs);
      state.results[key] = {ok: !!answer.ok, at: performance.now()};
      app.toast(answer.ok ? `${action.rpc.name}: ${answer.result == null ? 'done' : brief(answer.result, 90).replace(/\s+/g, ' ')}` : `${action.rpc.name} failed: ${String(answer.error).split('\n').pop()}`, answer.ok ? 'ok' : 'danger');
    } catch (error) { state.results[key] = {ok: false, at: performance.now()}; app.toast(`${action.rpc.name} failed: ${error.message}`, 'danger'); }
    panel.invalidate();
  }

  // What a number on a command stream means is in the code that reads it. A coding agent reads that code and
  // sets the slider up: its range, and whether the value stays where set or acts only while it keeps arriving.
  async function askStream(target) {
    const agent = codingAgent(app);
    if (!agent) { app.toast('No coding agent can be reached (Claude Code or Codex on this machine).', 'warn'); return; }
    if (agent.busy) { app.toast(`${agent.name} is busy with another turn.`, 'warn'); return; }
    state.asking = target.key; panel.invalidate();
    try {
      const readers = app.blueprint.modules.filter(module => module.streams.some(stream => stream.key === target.key && stream.direction !== 'out'));
      const text = await agent.ask([
        FORM_ASK,
        'Say what one command stream of the running DimOS blueprint expects, for the slider that will publish on it. Do not publish anything and do not call an RPC. Read the handler of this stream in the dimos checkout.',
        `Stream: ${target.topic} (${target.type})`,
        `Read by: ${readers.map(module => `${module.cls} as its stream "${module.streams.find(stream => stream.key === target.key).name}"`).join('; ')}`,
        'Answer with one JSON object and nothing else: {"meaning": "<what the number does, with its unit, in one sentence>", "kind": "<setpoint when the value stays in effect, rate when it acts only while it keeps arriving>", "min": <smallest valid value>, "max": <largest valid value>}',
      ].join('\n'));
      const answer = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
      if (Number.isFinite(answer.min) && Number.isFinite(answer.max) && answer.max > answer.min) controls.setRange(target, answer.min, answer.max);
      controls.setMode(target, {hold: answer.kind === 'rate', note: `${String(answer.meaning || '').trim()} (${agent.name} read the code)`});
      controls.values.delete(target.key); target.lowText = target.highText = undefined;
    } catch (error) { app.toast(`${agent.name} could not say: ${error.message}`, 'warn'); }
    state.asking = null; panel.invalidate();
  }

  function drawDrive(ui, area) {
    const target = controls.drive, armed = controls.armed;
    if (controls.drives.length > 1) {
      const index = controls.drives.indexOf(target), row = area.cutTop(48, 8);
      ui.text('Sends to', row.x, row.cy, {size: SIZE.sm, color: ui.tone('muted')});
      ui.button(new Rect(row.x + 90, row.y, row.w - 90, row.h), short(target), () => { controls.driveKey = controls.drives[(index + 1) % controls.drives.length].key; }, {id: 'drive:target', size: SIZE.sm, tone: 'muted', sub: `${index + 1} of ${controls.drives.length} · ${target.type.split('.')[1]} → ${target.readers.map(words).join(', ')}`});
    } else {
      ui.text(`${target.topic}  →  ${target.readers.map(words).join(', ')}`, area.x, area.cutTop(26, 6).cy, {size: SIZE.xs, family: 'mono', color: ui.tone('muted'), max: area.w});
    }
    const blocked = armed && controls.blocked;
    if (blocked) { const used = ui.wrap(blocked, new Rect(area.x, area.y, area.w, 0), {size: SIZE.xs, color: ui.tone('warn'), maxLines: 3, lineHeight: 1.4}); area.cutTop(used + 8, 0); }
    if (target.writers.length) ui.text(`${target.writers.map(words).join(', ')} also writes this stream: the two will compete`, area.x, area.cutTop(22, 6).cy, {size: SIZE.xs - 1, family: 'mono', color: ui.tone('warn'), max: area.w});
    const size = Math.min(area.w, Math.max(180, area.h - 250)), pad = new Rect(area.cx - size / 2, area.y, size, size);
    area.cutTop(size, 10);
    ui.pad(pad, state.pad, (x, y) => {
      state.pad = [x, y];
      // Up is forward. Sideways turns the robot, or slides it when strafing is on.
      controls.setInput('pad', y, controls.strafe ? -x : 0, controls.strafe ? 0 : -x);
    }, {id: 'pad', enabled: armed, tone: armed ? 'primary' : 'muted', labels: ['FWD', controls.strafe ? 'RIGHT' : 'TURN R', 'BACK', controls.strafe ? 'LEFT' : 'TURN L']});
    const [vx, vy, wz] = controls.command, moving = controls.moving;
    ui.text(`v ${(vx * controls.speed.linear).toFixed(2)}  ${(vy * controls.speed.linear).toFixed(2)} m/s    ω ${(wz * controls.speed.angular).toFixed(2)} rad/s`, area.cx, area.cutTop(24, 6).cy, {size: SIZE.sm, family: 'mono', color: ui.tone(moving ? 'fg' : 'muted'), align: 'center'});
    ui.toggle(area.cutTop(36, 6), 'Sideways slides (holonomic base)', controls.strafe, on => { controls.strafe = on; }, {id: 'strafe'});
    ui.text('Top speed', area.x, area.y + 18, {size: SIZE.sm, color: ui.tone('muted')});
    ui.slider(new Rect(area.x + 110, area.y, area.w - 110, 36), controls.speed.linear, 0.05, 1.5, value => { controls.speed.linear = value; }, {id: 'speed:linear', step: 0.05, format: value => `${value.toFixed(2)} m/s`});
    area.cutTop(40, 0);
    ui.text('Top turn', area.x, area.y + 18, {size: SIZE.sm, color: ui.tone('muted')});
    ui.slider(new Rect(area.x + 110, area.y, area.w - 110, 36), controls.speed.angular, 0.1, 2.5, value => { controls.speed.angular = value; }, {id: 'speed:angular', step: 0.05, format: value => `${value.toFixed(2)} rad/s`});
    area.cutTop(44, 0);
    ui.wrap(armed ? 'Hold the pad, or keys W S (forward, back), A D (turn), Q E (slide). Space stops. In a headset: left stick moves, right stick turns.' : 'Arm the controls to drive.', area, {size: SIZE.xs, color: ui.tone('muted', 0.85), maxLines: 3, lineHeight: 1.45});
    if (moving) panel.invalidate();
  }

  function drawSet(ui, inner) {
    let y = inner.y;
    const armed = controls.armed;
    for (const target of controls.numbers) {
      const mode = controls.mode(target), hold = !!mode.hold, [low, high] = controls.ranges[target.key] || (hold ? [-1, 1] : controls.range(target));
      const value = controls.values.get(target.key) ?? (hold ? 0 : low), asking = state.asking === target.key;
      ui.text(short(target), inner.x, y + 14, {size: SIZE.md, weight: 500, max: inner.w - 190});
      ui.text(`→ ${target.readers.map(words).join(', ')}`, inner.x, y + 36, {size: SIZE.xs - 1, family: 'mono', color: ui.tone('muted'), max: inner.w - 190});
      // The stream says only "a number": the range it makes sense in is the user's to give, or an agent's to read from the code.
      ui.text('range', inner.r - 178, y + 22, {size: SIZE.xs - 1, family: 'mono', color: ui.tone('muted')});
      ui.field(new Rect(inner.r - 130, y + 4, 60, 34), target.lowText ?? String(low), {id: `low:${target.key}`, family: 'mono', numeric: true, onInput: text => { target.lowText = text; controls.setRange(target, Number(text), high); }, onSubmit: () => { target.lowText = undefined; }});
      ui.field(new Rect(inner.r - 64, y + 4, 60, 34), target.highText ?? String(high), {id: `high:${target.key}`, family: 'mono', numeric: true, onInput: text => { target.highText = text; controls.setRange(target, low, Number(text)); }, onSubmit: () => { target.highText = undefined; }});
      y += 50;
      if (mode.note) y += ui.wrap(mode.note, new Rect(inner.x, y, inner.w, 0), {size: SIZE.xs, color: ui.tone('muted', 0.95), lineHeight: 1.4, maxLines: 4}) + 6;
      const format = next => (target.type === 'std_msgs.Float32' ? next.toFixed(3) : String(Math.round(next)));
      if (hold) {
        // A rate: in effect while the slider is held, zero when it is let go.
        ui.slider(new Rect(inner.x, y, inner.w, 36), Math.min(high, Math.max(low, value)), low, high, next => controls.holdNumber(target, next), {id: `set:${target.key}`, enabled: armed, tone: armed ? 'alt' : 'muted', onRelease: () => controls.releaseNumber(target), format});
      } else {
        ui.slider(new Rect(inner.x, y, inner.w, 36), Math.min(high, Math.max(low, value)), low, high, next => controls.setNumber(target, next), {id: `set:${target.key}`, enabled: armed, tone: armed ? 'primary' : 'muted', onRelease: () => controls.release(target), format});
      }
      y += 42;
      const row = new Rect(inner.x, y, inner.w, 30);
      ui.chips(row.cutLeft(230, 10), [['set', 'STAYS SET'], ['hold', 'WHILE HELD']], hold ? 'hold' : 'set', next => { controls.setMode(target, {hold: next === 'hold'}); controls.values.delete(target.key); }, {id: `mode:${target.key}`, size: SIZE.xs - 2, tone: hold ? 'alt' : 'primary'});
      ui.button(row.cutLeft(Math.min(row.w, 200), 0), asking ? 'READING THE CODE…' : 'ASK WHAT IT EXPECTS', () => askStream(target), {id: `ask:${target.key}`, size: SIZE.xs - 2, tone: 'agent', icon: 'agent', enabled: !state.asking});
      y += 40; ui.hair(inner.x, y - 2, inner.r, y - 2);
      if (asking) panel.invalidate();
    }
    for (const target of controls.switches) {
      const row = new Rect(inner.x, y, inner.w, 46);
      ui.toggle(row, `${short(target)}  → ${target.readers.map(words).join(', ')}`, !!controls.values.get(target.key), on => controls.setSwitch(target, on), {id: `switch:${target.key}`, enabled: armed});
      y += 50; ui.hair(inner.x, y - 2, inner.r, y - 2);
    }
    for (const target of controls.goals) {
      const row = new Rect(inner.x, y, inner.w, 60), aiming = controls.aiming === target;
      ui.text(short(target), row.x, row.y + 18, {size: SIZE.md, weight: 500, max: row.w - 170});
      ui.text(aiming ? 'now press a point on the table' : `${target.type.split('.')[1]} → ${target.readers.map(words).join(', ')}`, row.x, row.y + 42, {size: SIZE.xs - 1, family: 'mono', color: ui.tone(aiming ? 'warn' : 'muted'), max: row.w - 170});
      ui.button(new Rect(row.r - 150, row.y + 10, 150, 40), aiming ? 'CANCEL' : 'POINT AT IT', () => controls.aim(target), {id: `aim:${target.key}`, size: SIZE.xs, on: aiming, tone: aiming ? 'warn' : 'primary', enabled: armed});
      y += 64; ui.hair(inner.x, y - 2, inner.r, y - 2);
    }
    return y - inner.y;
  }

  function drawJoints(ui, area) {
    const armed = controls.armed, target = controls.joints.find(entry => entry.key === state.jointTarget) || controls.joints[0], index = controls.joints.indexOf(target);
    controls.watchJoints(true);
    const via = `${target.kind === 'rpc' ? 'an RPC of' : 'a stream to'} ${target.readers.map(words).join(', ')}`;
    if (controls.joints.length > 1) {
      const row = area.cutTop(48, 8);
      ui.text('Sends to', row.x, row.cy, {size: SIZE.sm, color: ui.tone('muted')});
      ui.button(new Rect(row.x + 90, row.y, row.w - 90, row.h), target.label, () => { state.jointTarget = controls.joints[(index + 1) % controls.joints.length].key; state.targets = {}; }, {id: 'joint:target', size: SIZE.sm, tone: 'muted', sub: `${index + 1} of ${controls.joints.length} · ${via}`});
    } else ui.text(`${target.label}  ·  ${via}`, area.x, area.cutTop(26, 6).cy, {size: SIZE.xs, family: 'mono', color: ui.tone('muted'), max: area.w});
    const current = controls.jointState;
    if (!current) { ui.empty(area, controls.states?.length ? 'Waiting for the joint states…' : 'No module publishes joint states, so there is nothing to jog from.'); return; }
    const robot = app.layers.list().find(layer => layer.kind === 'robot'), limits = robot?.jointLimits || {}, refused = target.refused || {};
    ui.text(`measured on ${current.topic} (blue tick) · drag or step to command one joint`, area.x, area.cutTop(22, 4).cy, {size: SIZE.xs - 1, family: 'mono', color: ui.tone('muted'), max: area.w});
    // Joints the target accepted or was not asked about come first; the ones it refused sink to the end.
    const order = current.names.map((name, joint) => ({name, joint})).sort((a, b) => Number(!!refused[a.name]) - Number(!!refused[b.name]));
    ui.scroll(area, 'joints', inner => {
      let y = inner.y;
      for (const {name, joint} of order) {
        const measured = current.positions[joint] ?? 0, limit = limits[name] || {}, low = limit.lower ?? -Math.PI, high = limit.upper ?? Math.PI, line = new Rect(inner.x, y, inner.w, 66);
        const no = refused[name], wanted = state.targets[name], value = wanted ?? measured, enabled = armed && !no;
        const send = next => { const clamped = Math.min(high, Math.max(low, next)); state.targets[name] = clamped; controls.jog(target, name, clamped); };
        ui.text(name, line.x, line.y + 14, {size: SIZE.sm, family: 'mono', color: ui.tone(no ? 'muted' : 'fg'), max: line.w - 200});
        ui.text(no ? no : `${measured.toFixed(3)}${wanted === undefined ? '' : `  →  ${wanted.toFixed(3)}`} rad`, line.r, line.y + 14, {size: SIZE.xs, family: 'mono', align: 'right', color: ui.tone(no ? 'warn' : 'info'), max: no ? line.w * 0.6 : 200});
        const step = (high - low) / 60;
        ui.button(new Rect(line.x, line.y + 28, 38, 32), '', () => send(value - step), {id: `j-:${name}`, icon: 'minus', enabled});
        ui.button(new Rect(line.r - 38, line.y + 28, 38, 32), '', () => send(value + step), {id: `j+:${name}`, icon: 'plus', enabled});
        ui.slider(new Rect(line.x + 46, line.y + 26, line.w - 92, 36), Math.min(high, Math.max(low, value)), low, high, send, {id: `j:${name}`, enabled, tone: enabled ? 'primary' : 'muted', mark: measured, format: () => ''});
        y += 70; ui.hair(inner.x, y - 2, inner.r, y - 2);
      }
      return y - inner.y;
    });
  }

  // What the modules report about themselves: one line each, the fields that fit.
  function drawStatus(ui, area) {
    for (const entry of controls.statuses.slice(0, 4)) {
      const line = area.cutTop(22, 2), value = entry.value;
      const label = ui.text(words(entry.module.name), line.x, line.cy, {size: SIZE.xs - 1, family: 'mono', color: ui.tone('muted')});
      const fields = value && typeof value === 'object' ? Object.entries(value).filter(([, field]) => field !== '' && field !== null && typeof field !== 'object') : [];
      let x = line.x + label + 12;
      if (entry.error) ui.text(String(entry.error).split('\n').pop(), x, line.cy, {size: SIZE.xs - 1, family: 'mono', color: ui.tone('danger'), max: line.r - x});
      for (const [key, field] of fields) {
        const text = typeof field === 'boolean' ? key : `${key} ${typeof field === 'number' && !Number.isInteger(field) ? field.toFixed(3) : field}`;
        const width = ui.measure(text, SIZE.xs - 1, 400, 'mono');
        if (x + width > line.r) break;
        ui.text(text, x, line.cy, {size: SIZE.xs - 1, family: 'mono', color: ui.tone(typeof field === 'boolean' ? (field ? 'ok' : 'muted') : 'fg', typeof field === 'boolean' && !field ? 0.55 : 1)});
        x += width + 14;
      }
    }
    area.cutTop(6, 0);
  }

  function drawActions(ui, inner) {
    let y = inner.y;
    const armed = controls.armed, width = (inner.w - 10) / 2;
    controls.actions.forEach((action, index) => {
      const cell = new Rect(inner.x + (index % 2) * (width + 10), y, width, 58), key = `${action.module.id}.${action.rpc.name}`, result = state.results[key];
      const recent = result && !result.pending && performance.now() - result.at < 2500;
      ui.button(cell, action.rpc.name, () => run(action), {id: `act:${key}`, size: SIZE.sm, enabled: armed && !result?.pending, tone: action.rpc.skill ? 'alt' : recent ? (result.ok ? 'ok' : 'danger') : 'primary', on: !!result?.pending,
        sub: `${action.pinned ? '★ ' : ''}${Object.keys(action.kwargs).length ? Object.values(action.kwargs).map(value => typeof value === 'string' ? value.split('/').pop() : brief(value, 24)).join(', ') : words(action.module.name)}`});
      if (recent) panel.invalidate();
      if (index % 2 === 1 || index === controls.actions.length - 1) y += 66;
    });
    return y - inner.y;
  }

  const panel = app.panel({
    id, title: 'Control', glyph: 'robot', width: 0.46, height: app.dock.sideHeight(0.66), onClose: () => app.dock.close(id),
    draw(ui, content) {
      const armed = controls.armed;
      panel.tag = armed ? 'ARMED' : 'SAFE';
      if (!armed) state.targets = {};
      if (!app.blueprint.running) { ui.empty(content, 'No blueprint is running.', 'Its controls appear here when one is.'); return; }
      const top = content.cutTop(52, 12);
      ui.button(top.cutRight(150, 10), 'STOP', () => controls.stop(), {id: 'stop', icon: 'stop', tone: 'danger', on: true, enabled: controls.drives.length > 0});
      ui.button(top, armed ? 'ARMED · press to make safe' : 'ARM THE CONTROLS', () => controls.arm(!armed), {id: 'arm', tone: armed ? 'warn' : 'primary', on: armed, icon: armed ? 'warn' : null, enabled: controls.any});
      if (!controls.any) { ui.empty(content, 'This blueprint reads no command streams and has no simple RPCs.'); return; }
      if (controls.statuses.length) drawStatus(ui, content);
      const tabs = [
        ['drive', 'DRIVE', controls.drives.length], ['set', 'SET', controls.numbers.length + controls.switches.length + controls.goals.length],
        ['joints', 'JOINTS', controls.joints.length], ['actions', 'ACTIONS', controls.actions.length],
      ].filter(([, , count]) => count > 0);
      if (!tabs.some(([key]) => key === state.tab)) state.tab = tabs[0][0];
      ui.chips(content.cutTop(36, 12), tabs.map(([key, label, count]) => [key, `${label} ${count}`]), state.tab, tab => { state.tab = tab; }, {id: 'tab', size: SIZE.xs});
      if (state.tab !== 'joints') controls.watchJoints(false);
      if (state.tab === 'drive') drawDrive(ui, content);
      else if (state.tab === 'joints') drawJoints(ui, content);
      else ui.scroll(content, state.tab, inner => state.tab === 'set' ? drawSet(ui, inner) : drawActions(ui, inner));
    },
  });
  for (const type of ['change', 'drive', 'joints', 'status']) controls.addEventListener(type, () => panel.invalidate(), {signal: panel.signal});
  controls.watchStatus(true);
  // A panel that is gone cannot show what it is commanding: closing it makes the controls safe.
  panel.onDispose = () => { controls.disarm(); controls.watchStatus(false); };
  return app.dock.open(panel, 'right');
}
