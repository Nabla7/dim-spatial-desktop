// The two strips that are always there: the status line along the top and the command bar along the
// bottom. Everything else is a panel the command bar opens.
import {SIZE} from '../ui/holo.js';
import {duration} from '../util.js';
import {openLauncher} from './launcher.js';
import {openModules} from './modules.js';
import {openLayers} from './layers.js';
import {openAgent} from './agent.js';
import {openLogs} from './logs.js';
import {openStats} from './stats.js';
import {openView} from './view.js';

const PHASE_TONE = {starting: 'warn', running: 'ok', stopping: 'warn', failed: 'danger', stopped: 'muted'};

export function openShell(app) {
  const blueprint = app.blueprint;
  const head = app.panel({
    id: 'head', bare: true, width: 0.94, height: 0.05,
    draw(ui, content) {
      const toast = app.toasts[0];
      const brand = ui.text('DIMOS', content.x + 6, content.cy + 1, {size: SIZE.sm, family: 'display', color: ui.tone('primary'), track: 4});
      ui.text('SPATIAL', content.x + 22 + brand, content.cy + 1, {size: SIZE.xs, family: 'display', color: ui.tone('muted'), track: 3});
      if (toast) {
        ui.text(toast.message, content.cx + 20, content.cy + 1, {size: SIZE.sm, weight: 500, color: ui.tone(toast.tone === 'info' ? 'fg' : toast.tone), align: 'center', max: content.w - 520});
      } else if (blueprint.name) {
        const started = blueprint.startedAt ? (Date.now() - Date.parse(blueprint.startedAt)) / 1000 : NaN;
        const label = `${blueprint.name}  ·  ${blueprint.phase}${blueprint.running ? `  ·  ${blueprint.modules.length} modules  ·  ${duration(started)}` : ''}`;
        const width = ui.measure(label, SIZE.sm, 400, 'mono');
        ui.lamp(content.cx + 20 - width / 2 - 16, content.cy, PHASE_TONE[blueprint.phase] || 'muted', blueprint.phase === 'starting' || blueprint.phase === 'stopping');
        ui.text(label, content.cx + 20, content.cy + 1, {size: SIZE.sm, family: 'mono', align: 'center', max: content.w - 520});
      } else ui.text(blueprint.reachable ? 'no blueprint running' : 'dimos gateway unreachable', content.cx + 20, content.cy + 1, {size: SIZE.sm, family: 'mono', color: ui.tone(blueprint.reachable ? 'muted' : 'danger'), align: 'center'});
      const bus = app.bus, link = bus.live ? (bus.state === 'degraded' ? 'warn' : 'ok') : bus.state === 'connecting' ? 'warn' : 'danger';
      const text = bus.live ? `LINK ${bus.rtt == null ? '' : `${Math.round(bus.rtt)} ms`}` : bus.state === 'connecting' ? 'LINKING' : 'NO LINK';
      ui.lamp(content.r - 12, content.cy, link, !bus.live);
      ui.text(text, content.r - 28, content.cy + 1, {size: SIZE.xs, family: 'mono', color: ui.tone(link === 'ok' ? 'muted' : link), align: 'right'});
      ui.text(new Date().toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false}), content.r - 150, content.cy + 1, {size: SIZE.xs, family: 'mono', color: ui.tone('muted'), align: 'right'});
    },
  });
  setInterval(() => head.invalidate(), 1000);
  for (const type of ['change', 'modules']) blueprint.addEventListener(type, () => head.invalidate());
  app.bus.addEventListener('state', () => head.invalidate());
  app.addEventListener('toast', () => head.invalidate());
  app.dock.open(head, 'head');

  const items = [
    ['launcher', 'BLUEPRINT', 'rocket', () => openLauncher(app)],
    ['modules', 'MODULES', 'module', () => openModules(app)],
    ['layers', 'LAYERS', 'layers', () => openLayers(app)],
    ['agent', 'AGENT', 'agent', () => openAgent(app)],
    ['logs', 'LOGS', 'log', () => openLogs(app)],
    ['stats', 'STATS', 'pulse', () => openStats(app)],
    ['view', 'VIEW', 'scale', () => openView(app)],
  ];
  const bar = app.panel({
    id: 'bar', bare: true, width: 0.94, height: 0.068,
    draw(ui, content) {
      const xr = app.xr, right = content.cutRight(280, 16);
      const cells = content.cols(items.length, 8);
      items.forEach(([id, label, icon, open], index) => {
        const cell = cells[index], on = app.dock.has(id), hot = ui.isHot(`bar:${id}`);
        ui.chamfer(cell, 8);
        ui.ctx.fillStyle = ui.tone('primary', on ? 0.2 : hot ? 0.12 : 0.03); ui.ctx.fill();
        ui.ctx.strokeStyle = ui.tone('primary', on ? 1 : hot ? 0.8 : 0.28); ui.ctx.lineWidth = 1.4; ui.ctx.stroke();
        if (on) { ui.ctx.fillStyle = ui.tone('primary'); ui.ctx.fillRect(cell.x + 10, cell.b - 3, cell.w - 20, 3); }
        ui.icon(icon, cell.cx, cell.y + 30, 26, ui.tone(on || hot ? 'fg' : 'primary'));
        ui.text(label, cell.cx, cell.b - 18, {size: 12.5, family: 'display', color: ui.tone(on || hot ? 'fg' : 'muted'), align: 'center', track: 1.5, max: cell.w - 6});
        ui.region(cell, {id: `bar:${id}`, onClick: open});
      });
      // The headset corner: enter, leave, or the reason there is nothing to enter.
      if (xr.presenting) {
        const [recentre, exit] = right.cols(2, 8);
        ui.button(recentre, 'BRING HERE', () => xr.recenter(), {id: 'xr:recentre', icon: 'home', size: SIZE.xs});
        ui.button(exit, 'EXIT', () => xr.exit(), {id: 'xr:exit', tone: 'warn', icon: 'vr', size: SIZE.sm});
      } else if (xr.modes.length) {
        const buttons = right.cols(xr.modes.length, 8);
        xr.modes.forEach((mode, index) => ui.button(buttons[index], mode === 'immersive-ar' ? 'MIXED' : 'VR', () => xr.enter(mode),
          {id: `xr:${mode}`, icon: 'vr', tone: mode === 'immersive-ar' ? 'alt' : 'primary', on: index === 0, size: SIZE.sm}));
      } else {
        ui.icon('vr', right.x + 20, right.cy, 24, ui.tone('muted', 0.6));
        ui.wrap(xr.reason || 'looking for a headset', new (right.constructor)(right.x + 44, right.cy - 20, right.w - 48, 40), {size: SIZE.xs - 1, family: 'mono', color: ui.tone('muted', 0.8), maxLines: 2, lineHeight: 1.3});
      }
    },
  });
  app.dock.addEventListener('change', () => bar.invalidate());
  app.xr.addEventListener('change', () => bar.invalidate());
  app.dock.open(bar, 'bar');
}
