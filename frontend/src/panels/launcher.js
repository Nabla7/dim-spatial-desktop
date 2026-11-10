// Launch and stop. Idle: the catalog of blueprints, searchable. Running: what runs, its phase and its
// start-up output. A launch goes through Desktop's Launcher, so it gets the config the user saved there.
import {SIZE} from '../ui/holo.js';
import {Rect} from '../ui/rect.js';
import {gateway} from '../data/gateway.js';
import {duration} from '../util.js';

const PHASE = {starting: ['STARTING', 'warn'], running: ['RUNNING', 'ok'], stopping: ['STOPPING', 'warn'], failed: ['FAILED', 'danger'], stopped: ['IDLE', 'muted']};

export function openLauncher(app) {
  const id = 'launcher';
  if (app.dock.has(id)) { app.dock.close(id); return; }
  const state = {filter: '', chosen: null, working: false, error: null, armedStop: 0};
  const blueprint = app.blueprint;
  blueprint.loadCatalog();

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
    // Stopping a robot stack is deliberate: the first press arms, the second stops.
    ui.button(stop, armed ? 'CONFIRM STOP' : 'STOP', () => {
      if (!armed) { state.armedStop = performance.now(); return; }
      state.armedStop = 0; run(() => gateway.stop(), 'Blueprint stopped');
    }, {id: 'stop', tone: 'danger', icon: 'stop', on: armed, enabled: !state.working && blueprint.phase !== 'stopped'});
    ui.button(restart, 'RESTART', () => run(() => gateway.relaunch(), 'Restarting'), {id: 'relaunch', tone: 'warn', icon: 'refresh', enabled: !state.working});
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
      ui.wrap(`Last launch failed: ${blueprint.launch.error}`, box, {size: SIZE.xs, family: 'mono', color: ui.tone('danger'), maxLines: 3});
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
      const card = content.cutBottom(150, 10);
      ui.chamfer(card, 10); ui.ctx.fillStyle = ui.tone('primary', 0.06); ui.ctx.fill(); ui.ctx.strokeStyle = ui.tone('primary', 0.4); ui.ctx.lineWidth = 1.2; ui.ctx.stroke();
      const inner = card.inset(14, 12);
      ui.text(chosen.title || chosen.name, inner.x, inner.y + 12, {size: SIZE.md, weight: 600, max: inner.w});
      ui.wrap(chosen.description || chosen.doc || 'No description.', new Rect(inner.x, inner.y + 28, inner.w, 44), {size: SIZE.xs, color: ui.tone('muted'), maxLines: 2});
      const launch = new Rect(inner.x, inner.b - 46, inner.w, 46);
      ui.button(launch, chosen.importable === false ? 'CANNOT IMPORT' : `LAUNCH ${chosen.name.toUpperCase()}`, () => run(() => gateway.launch(chosen.name), `Launching ${chosen.name}`),
        {id: 'launch', icon: 'rocket', on: chosen.importable !== false, enabled: chosen.importable !== false && !state.working});
    }
    ui.heading(content.cutTop(26, 4), 'Blueprints', `${shown.length} / ${catalog.length}`);
    ui.scroll(content, 'catalog', inner => {
      let y = inner.y;
      for (const entry of shown) {
        const row = new Rect(inner.x, y, inner.w, 54);
        ui.row(row, {id: `bp:${entry.name}`, selected: entry.name === state.chosen, onClick: () => { state.chosen = entry.name === state.chosen ? null : entry.name; }});
        ui.text(entry.title || entry.name, row.x + 12, row.y + 18, {size: SIZE.md, weight: 500, color: ui.tone(entry.importable === false ? 'muted' : 'fg'), max: row.w - 110});
        ui.text(entry.name, row.x + 12, row.y + 40, {size: SIZE.xs, family: 'mono', color: ui.tone('muted'), max: row.w - 110});
        if (entry.robot) ui.badge(row.r - 8, row.y + 18, entry.robot, {tone: 'info', align: 'right'});
        y += 54; ui.hair(inner.x, y, inner.r, y);
      }
      return y - inner.y;
    });
  }

  const panel = app.panel({
    id, title: 'Blueprint', glyph: 'rocket', width: 0.4, height: 0.56, onClose: () => app.dock.close(id),
    draw(ui, content) {
      panel.tag = (PHASE[blueprint.phase] || PHASE.stopped)[0];
      if (!blueprint.reachable) { ui.empty(content, 'The dimos gateway does not answer.', 'Desktop starts it on demand; check Desktop → Settings.'); return; }
      if (blueprint.phase !== 'stopped' && blueprint.phase !== 'failed') drawRunning(ui, content); else drawCatalog(ui, content);
    },
  });
  for (const type of ['change', 'catalog']) blueprint.addEventListener(type, () => panel.invalidate(), {signal: panel.signal});
  return app.dock.open(panel, 'left');
}
