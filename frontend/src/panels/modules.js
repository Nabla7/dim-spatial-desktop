// The running blueprint's module instances, as a list: the dependable way in to each one
// (the ring of modules around the table is the same set, drawn in space).
import {SIZE} from '../ui/holo.js';
import {Rect} from '../ui/rect.js';
import {words} from '../util.js';
import {openModule} from './module.js';

export function openModules(app) {
  const id = 'modules';
  if (app.dock.has(id)) { app.dock.close(id); return; }
  const state = {filter: ''};
  const panel = app.panel({
    id, title: 'Modules', glyph: 'module', width: 0.4, height: app.dock.sideHeight(), onClose: () => app.dock.close(id),
    draw(ui, content) {
      const blueprint = app.blueprint;
      panel.tag = blueprint.running ? `${blueprint.modules.length} LIVE` : '';
      if (!blueprint.running) { ui.empty(content, 'No blueprint is running.', 'Launch one from the Blueprint panel.'); return; }
      if (!blueprint.modules.length) { ui.empty(content, 'Waiting for the modules to report…'); panel.busy = true; return; }
      panel.busy = false;
      ui.field(content.cutTop(42, 10), state.filter, {id: 'filter', placeholder: 'Filter modules, RPCs, topics', onInput: value => { state.filter = value; }});
      const needle = state.filter.trim().toLowerCase();
      const shown = blueprint.modules.filter(module => !needle || words(module.name).toLowerCase().includes(needle) || module.name.toLowerCase().includes(needle) || module.id.includes(needle)
        || module.rpcs.some(rpc => rpc.name.toLowerCase().includes(needle)) || module.streams.some(stream => stream.topic.toLowerCase().includes(needle)));
      ui.scroll(content, 'list', inner => {
        let y = inner.y;
        for (const module of shown) {
          const row = new Rect(inner.x, y, inner.w, 64), open = app.dock.has(`module:${module.id}`), skills = module.rpcs.filter(rpc => rpc.skill).length;
          const hot = ui.row(row, {id: `m:${module.id}`, selected: open || app.selected === module.id, onClick: () => openModule(app, module.id)});
          const process = blueprint.processOf(module), alive = process ? process.alive !== false : true;
          ui.icon('module', row.x + 26, row.cy, 30, ui.tone(alive ? 'primary' : 'danger', hot || open ? 1 : 0.7));
          ui.lamp(row.x + 26, row.cy, alive ? 'ok' : 'danger');
          ui.text(words(module.name), row.x + 54, row.y + 22, {size: SIZE.md, weight: 500, max: row.w - 170});
          const parts = [...(module.alias ? [module.alias] : []), `${module.rpcs.length} rpc`, ...(skills ? [`${skills} skill`] : []), `${module.streams.length} streams`];
          ui.text(parts.join(' · '), row.x + 54, row.y + 46, {size: SIZE.xs, family: 'mono', color: ui.tone('muted'), max: row.w - 170});
          if (process) {
            ui.text(`${Math.round(process.cpu_percent)}%`, row.r - 12, row.y + 22, {size: SIZE.sm, family: 'mono', align: 'right', color: ui.tone(process.cpu_percent > 90 ? 'warn' : 'fg')});
            ui.meter(new Rect(row.r - 96, row.y + 41, 84, 8), process.cpu_percent / 100, {segments: 14});
          }
          y += 64; ui.hair(inner.x, y, inner.r, y);
        }
        if (!shown.length) ui.text('Nothing matches.', inner.x + 8, y + 30, {color: ui.tone('muted')});
        return y - inner.y + 4;
      });
    },
  });
  for (const type of ['modules', 'stats', 'change']) app.blueprint.addEventListener(type, () => panel.invalidate(), {signal: panel.signal});
  app.addEventListener('select', () => panel.invalidate(), {signal: panel.signal});
  return app.dock.open(panel, 'left');
}
