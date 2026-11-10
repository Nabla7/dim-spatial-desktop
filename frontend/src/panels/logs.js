// The running blueprint's structured log, followed live.
import {SIZE} from '../ui/holo.js';
import {Rect} from '../ui/rect.js';
import {gateway} from '../data/gateway.js';

const TONE = {debug: 'muted', info: 'info', warning: 'warn', error: 'danger', critical: 'danger'};

export function openLogs(app) {
  const id = 'logs';
  if (app.dock.has(id)) { app.dock.close(id); return; }
  const state = {level: 'info', records: [], offset: null, run: null, error: null};
  let stopped = false;
  async function poll() {
    while (!stopped) {
      if (app.blueprint.running) {
        if (state.run !== app.blueprint.runId) { state.run = app.blueprint.runId; state.records = []; state.offset = null; }
        try {
          const page = await gateway.log(state.offset, state.level);
          state.error = null;
          if (page.records?.length) { state.records.push(...page.records); if (state.records.length > 600) state.records.splice(0, state.records.length - 600); panel.invalidate(); }
          state.offset = page.offset ?? state.offset;
        } catch (error) { if (state.error !== error.message) { state.error = error.message; panel.invalidate(); } }
      }
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  }
  const panel = app.panel({
    id, title: 'Logs', glyph: 'log', width: 0.52, height: 0.44, onClose: () => app.dock.close(id),
    draw(ui, content) {
      panel.tag = `${state.records.length}`;
      ui.chips(content.cutTop(36, 10), ['debug', 'info', 'warning', 'error'].map(level => [level, level.toUpperCase()]), state.level,
        level => { state.level = level; state.records = []; state.offset = null; }, {id: 'level', size: SIZE.xs});
      if (!app.blueprint.running) { ui.empty(content, 'No blueprint is running.'); return; }
      if (!state.records.length) { ui.empty(content, state.error || 'No records at this level yet.'); return; }
      ui.scroll(content, 'records', inner => {
        let y = inner.y;
        for (const record of state.records) {
          const tone = TONE[record.level] || 'muted', time = String(record.timestamp || '').slice(11, 23);
          ui.text(time, inner.x, y + 12, {size: SIZE.xs - 1, family: 'mono', color: ui.tone('muted', 0.8)});
          ui.text(String(record.level || '').slice(0, 4).toUpperCase(), inner.x + 106, y + 12, {size: SIZE.xs - 1, family: 'mono', weight: 500, color: ui.tone(tone)});
          const logger = String(record.logger || '').split('/').pop();
          const extra = record.extra && Object.keys(record.extra).length ? '  ' + Object.entries(record.extra).filter(([key]) => key !== 'func_name' && key !== 'lineno').map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`).join(' ') : '';
          y += ui.wrap(`${logger ? `[${logger}] ` : ''}${record.event ?? ''}${extra}`, new Rect(inner.x + 154, y, inner.w - 154, 0), {size: SIZE.xs, family: 'mono', color: ui.tone(tone === 'info' ? 'fg' : tone), lineHeight: 1.45, maxLines: 5}) + 3;
        }
        return y - inner.y;
      }, {stickBottom: true});
    },
  });
  panel.onDispose = () => { stopped = true; };
  app.blueprint.addEventListener('change', () => panel.invalidate(), {signal: panel.signal});
  poll();
  return app.dock.open(panel, 'right');
}
