// Launch and stop. Idle: the catalog of blueprints, searchable. Running: what runs, its phase and its
// start-up output. A launch goes through Desktop's Launcher, so it gets the config the user saved there.
// What a blueprint cannot start without, and what a recording session is told each time (what the
// episodes are of, where they go), is asked for here and sent with the launch (data/launch.js).
import {SIZE} from '../ui/holo.js';
import {Rect} from '../ui/rect.js';
import {gateway} from '../data/gateway.js';
import {duration} from '../util.js';
import {launchAsks, launchConfig, missing, stamp} from '../data/launch.js';

const PHASE = {starting: ['STARTING', 'warn'], running: ['RUNNING', 'ok'], stopping: ['STOPPING', 'warn'], failed: ['FAILED', 'danger'], stopped: ['IDLE', 'muted']};

const TOLD = 'spatial.launch';   // {blueprint: {module.field: what the user gave last time}}
const told = () => { try { return JSON.parse(localStorage.getItem(TOLD) || '{}'); } catch { return {}; } };
// Why a launch failed, in the words of the last error its output names (a traceback's last line is a frame's edge).
function failure(launch) {
  const lines = String(launch?.output || '').split('\n').map(line => line.replace(/\x1b\[[0-9;]*m/g, '').replace(/^[\s|+-]+/, ''));
  return lines.filter(line => /^[\w.]*(Error|Exception)\b.*:\s*\S/.test(line)).pop() || launch?.error || 'no reason given';
}

const LABEL = {task: 'What the episodes are of', folder: 'Where the episodes go (a new folder)'};

// choose: open with this blueprint picked (RECORD lists the ones that record).
export function openLauncher(app, {choose: wanted = null} = {}) {
  const id = 'launcher';
  if (app.dock.has(id) && !wanted) { app.dock.close(id); return; }
  const state = {filter: wanted || '', chosen: null, working: false, error: null, armedStop: 0, asks: null, values: {}};
  const blueprint = app.blueprint;
  blueprint.loadCatalog();

  // Pick a blueprint: read what its launch has to be told, and fill in what is known.
  async function choose(name) {
    state.chosen = name; state.asks = null; state.values = {}; state.waiting = false; panel.invalidate();
    if (!name) return;
    let asks = [], recordings = null;
    try {
      const [config, entry, folder] = await Promise.all([gateway.blueprintConfig(name), gateway.blueprint(name), gateway.recordings().catch(() => null)]);
      asks = launchAsks(config, entry.modules || []); recordings = folder?.path || null;
    } catch { /* a blueprint whose config cannot be read is launched as before, with nothing added */ }
    if (state.chosen !== name) return;
    const before = told()[name] || {};
    for (const ask of asks) {
      // A recording goes into a new folder each time: the last one's parent, with this blueprint and the time.
      if (ask.role === 'folder') { const parent = before[ask.key] || recordings; if (parent && ask.required) state.values[ask.key] = `${parent.replace(/\/+$/, '')}/${name}-${stamp()}`; }
      else if (before[ask.key]) state.values[ask.key] = before[ask.key];
    }
    state.asks = asks; panel.invalidate();
    // LAUNCH was pressed while this was being read: go, unless something has to be filled in first.
    if (state.waiting) { state.waiting = false; if (!missing(asks, state.values).length) launch(name); }
  }

  function launch(name) {
    const asks = state.asks || [], values = {...state.values};
    // Kept for the next session: the task as given, and the folder the recordings were put under.
    const all = told(), kept = {};
    for (const ask of asks) { const value = String(values[ask.key] ?? '').trim(); if (value) kept[ask.key] = ask.role === 'folder' ? value.replace(/\/[^/]*$/, '') : value; }
    if (Object.keys(kept).length) { all[name] = {...all[name], ...kept}; try { localStorage.setItem(TOLD, JSON.stringify(all)); } catch { /* private mode */ } }
    run(() => gateway.launch(name, launchConfig(asks, values)), `Launching ${name}`);
  }

  async function run(action, done) {
    state.working = true; state.error = null; panel.busy = true; panel.invalidate();
    try { await action(); if (done) app.toast(done, 'ok'); } catch (error) { state.error = error.message; app.toast(error.message, 'danger'); }
    state.working = false; panel.busy = false; panel.invalidate();
    blueprint.pollActive().catch(() => {});
  }

  function drawRunning(ui, content) {
    const [label, tone] = PHASE[blueprint.phase] || PHASE.stopped;
    const head = content.cutTop(64, 10);
    ui.lamp(head.x + 10, head.y + 20, tone, blueprint.phase !== 'running');
    ui.text(blueprint.name || '—', head.x + 28, head.y + 20, {size: SIZE.lg, weight: 600, max: head.w - 150});
    ui.badge(head.r, head.y + 20, label, {tone, align: 'right'});
    const started = blueprint.startedAt ? (Date.now() - Date.parse(blueprint.startedAt)) / 1000 : NaN;
    ui.text(`up ${duration(started)}${blueprint.runId ? ` · ${blueprint.runId}` : ''}`, head.x + 28, head.y + 48, {size: SIZE.xs, family: 'mono', color: ui.tone('muted'), max: head.w - 30});
    if (blueprint.running) panel.invalidate();
    const actions = content.cutBottom(48, 12), now = performance.now(), armed = now - state.armedStop < 3000;
    const [stop, restart] = actions.cols(2, 10);
    // An episode that is recording when the blueprint stops is left unfinished: neither saved nor discarded.
    const taking = app.episodes.recording;
    if (taking) ui.text('An episode is recording. Save or discard it before the blueprint stops.', content.x, content.cutBottom(24, 6).cy, {size: SIZE.xs, color: ui.tone('warn'), max: content.w});
    // Stopping a robot stack is deliberate: the first press arms, the second stops.
    ui.button(stop, armed ? (taking ? 'STOP ANYWAY' : 'CONFIRM STOP') : 'STOP', () => {
      if (!armed) { state.armedStop = performance.now(); return; }
      state.armedStop = 0; run(() => gateway.stop(), 'Blueprint stopped');
    }, {id: 'stop', tone: 'danger', icon: 'stop', on: armed, enabled: !state.working && blueprint.phase !== 'stopped'});
    ui.button(restart, 'RESTART', () => run(() => gateway.relaunch(), 'Restarting'), {id: 'relaunch', tone: 'warn', icon: 'refresh', enabled: !state.working && !taking});
    if (armed) panel.invalidate();
    ui.heading(content.cutTop(26, 6), 'Launch output', blueprint.launch?.error ? 'error' : '');
    const lines = String(blueprint.launch?.output || '').split('\n').slice(-120).map(line => line.replace(/\x1b\[[0-9;]*m/g, ''));
    ui.scroll(content, 'output', inner => {
      let y = inner.y;
      for (const line of lines) {
        const tone = /error|traceback|failed/i.test(line) ? 'danger' : /warn/i.test(line) ? 'warn' : line.startsWith('$') ? 'primary' : 'muted';
        y += ui.wrap(line || ' ', new Rect(inner.x, y, inner.w, 0), {size: SIZE.xs, family: 'mono', color: ui.tone(tone), lineHeight: 1.4, maxLines: 6});
      }
      return y - inner.y;
    }, {stickBottom: true});
  }

  function drawCatalog(ui, content) {
    const catalog = blueprint.catalog;
    if (blueprint.launch?.phase === 'failed' && blueprint.launch?.error) {
      const box = content.cutTop(54, 10);
      ui.wrap(`Last launch failed: ${failure(blueprint.launch)}`, box, {size: SIZE.xs, family: 'mono', color: ui.tone('danger'), maxLines: 3});
    }
    ui.field(content.cutTop(42, 10), state.filter, {id: 'filter', placeholder: 'Search blueprints: go2, sim, agentic, xarm…', onInput: value => { state.filter = value; }});
    if (!catalog) { ui.empty(content, 'Reading the catalog…'); panel.busy = true; return; }
    if (!state.working) panel.busy = false;
    const words = state.filter.toLowerCase().split(/\s+/).filter(Boolean);
    const shown = catalog.filter(entry => {
      const text = `${entry.name} ${entry.title || ''} ${entry.robot || ''} ${(entry.abilities || []).join(' ')}`.toLowerCase();
      return words.every(word => text.includes(word));
    });
    const chosen = shown.find(entry => entry.name === state.chosen) || null;
    if (chosen) {
      const asks = state.asks || [], lacking = missing(asks, state.values);
      const card = content.cutBottom(150 + asks.length * 62 + (state.asks ? 0 : 24), 10);
      ui.chamfer(card, 10); ui.ctx.fillStyle = ui.tone('primary', 0.06); ui.ctx.fill(); ui.ctx.strokeStyle = ui.tone('primary', 0.4); ui.ctx.lineWidth = 1.2; ui.ctx.stroke();
      const inner = card.inset(14, 12);
      ui.text(chosen.title || chosen.name, inner.x, inner.y + 12, {size: SIZE.md, weight: 600, max: inner.w});
      ui.wrap(chosen.description || chosen.doc || 'No description.', new Rect(inner.x, inner.y + 28, inner.w, 44), {size: SIZE.xs, color: ui.tone('muted'), maxLines: 2});
      let y = inner.y + 78;
      if (!state.asks) ui.text('Reading what its launch has to be told…', inner.x, y + 8, {size: SIZE.xs, family: 'mono', color: ui.tone('muted')});
      for (const ask of asks) {
        const empty = !String(state.values[ask.key] ?? '').trim();
        ui.text(LABEL[ask.role] || ask.key, inner.x, y + 9, {size: SIZE.xs, color: ui.tone(ask.required && empty ? 'warn' : 'muted'), max: inner.w - 150});
        ui.text(LABEL[ask.role] ? ask.key : ask.required ? 'needed' : '', inner.r, y + 9, {size: SIZE.xs - 2, family: 'mono', color: ui.tone('muted', 0.8), align: 'right', max: 150});
        ui.field(new Rect(inner.x, y + 20, inner.w, 36), state.values[ask.key] ?? '', {id: `ask:${ask.key}`, family: ask.role === 'task' ? 'sans' : 'mono',
          placeholder: ask.required ? 'needed to launch' : ask.was == null ? 'the blueprint\'s own' : `the blueprint's own: ${ask.was}`, onInput: value => { state.values[ask.key] = value; }});
        y += 62;
      }
      // The first read of a blueprint's config takes the gateway some seconds: a press meanwhile is held until it is known.
      const launchRect = new Rect(inner.x, inner.b - 46, inner.w, 46), ready = chosen.importable !== false && !state.working && !state.waiting && !lacking.length;
      ui.button(launchRect, chosen.importable === false ? 'CANNOT IMPORT' : state.waiting ? 'LAUNCHES WHEN THAT IS READ…' : lacking.length ? `FILL IN ${lacking.map(ask => ask.field.toUpperCase()).join(', ')}` : `LAUNCH ${chosen.name.toUpperCase()}`,
        () => { if (state.asks) launch(chosen.name); else state.waiting = true; }, {id: 'launch', icon: lacking.length || state.waiting ? null : 'rocket', on: ready, enabled: ready});
    }
    ui.heading(content.cutTop(26, 4), 'Blueprints', `${shown.length} / ${catalog.length}`);
    ui.scroll(content, 'catalog', inner => {
      let y = inner.y;
      for (const entry of shown) {
        const row = new Rect(inner.x, y, inner.w, 54);
        ui.row(row, {id: `bp:${entry.name}`, selected: entry.name === state.chosen, onClick: () => choose(entry.name === state.chosen ? null : entry.name)});
        ui.text(entry.title || entry.name, row.x + 12, row.y + 18, {size: SIZE.md, weight: 500, color: ui.tone(entry.importable === false ? 'muted' : 'fg'), max: row.w - 110});
        ui.text(entry.name, row.x + 12, row.y + 40, {size: SIZE.xs, family: 'mono', color: ui.tone('muted'), max: row.w - 110});
        if (entry.robot) ui.badge(row.r - 8, row.y + 18, entry.robot, {tone: 'info', align: 'right'});
        y += 54; ui.hair(inner.x, y, inner.r, y);
      }
      return y - inner.y;
    });
  }

  const panel = app.panel({
    id, title: 'Blueprint', glyph: 'rocket', width: 0.4, height: app.dock.sideHeight(), onClose: () => app.dock.close(id),
    draw(ui, content) {
      panel.tag = (PHASE[blueprint.phase] || PHASE.stopped)[0];
      if (!blueprint.reachable) { ui.empty(content, 'The dimos gateway does not answer.', 'Desktop starts it on demand; check Desktop → Settings.'); return; }
      if (blueprint.phase !== 'stopped' && blueprint.phase !== 'failed') drawRunning(ui, content); else drawCatalog(ui, content);
    },
  });
  for (const type of ['change', 'catalog']) blueprint.addEventListener(type, () => panel.invalidate(), {signal: panel.signal});
  app.episodes.addEventListener('change', () => panel.invalidate(), {signal: panel.signal});
  // A launch uses up its folder: when the blueprint is idle again the next one is proposed.
  const isIdle = () => blueprint.phase === 'stopped' || blueprint.phase === 'failed';
  let wasIdle = isIdle();
  blueprint.addEventListener('change', () => { const idle = isIdle(); if (idle && !wasIdle && state.chosen) choose(state.chosen); wasIdle = idle; }, {signal: panel.signal});
  if (wanted) choose(wanted);
  return app.dock.open(panel, 'left');
}
