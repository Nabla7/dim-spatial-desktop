// Load: what each process of the run costs (dtop's numbers, through the gateway) and what each topic carries.
import {SIZE} from '../ui/holo.js';
import {Rect} from '../ui/rect.js';
import {bytes, hz, words} from '../util.js';

export function openStats(app) {
  const id = 'stats';
  if (app.dock.has(id)) { app.dock.close(id); return; }
  const state = {tab: 'processes'};
  const blueprint = app.blueprint;

  function drawProcesses(ui, inner) {
    const stats = blueprint.stats;
    if (!stats) { ui.empty(new Rect(inner.x, inner.y, inner.w, 200), 'No process stats yet.', 'A run started outside Desktop needs --dtop.'); return 200; }
    const rows = [];
    if (stats.coordinator) rows.push({name: 'Coordinator', key: 'coordinator', sample: stats.coordinator});
    for (const worker of stats.workers || []) rows.push({name: (worker.modules || []).map(words).join(', ') || `worker ${worker.worker_id}`, key: `worker:${worker.worker_id}`, sample: worker});
    rows.sort((a, b) => (b.sample.cpu_percent || 0) - (a.sample.cpu_percent || 0));
    let y = inner.y;
    for (const {name, key, sample} of rows) {
      const row = new Rect(inner.x, y, inner.w, 60), cpu = sample.cpu_percent || 0;
      ui.lamp(row.x + 10, row.y + 20, sample.alive === false ? 'danger' : 'ok');
      ui.text(name, row.x + 26, row.y + 20, {size: SIZE.md, weight: 500, max: row.w - 230});
      ui.text(`pid ${sample.pid} · ${bytes(sample.pss || sample.rss)} · ${sample.num_threads ?? '—'} thr`, row.x + 26, row.y + 44, {size: SIZE.xs, family: 'mono', color: ui.tone('muted'), max: row.w - 230});
      ui.text(`${cpu.toFixed(0)}%`, row.r - 8, row.y + 20, {size: SIZE.md, family: 'mono', align: 'right', color: ui.tone(cpu > 95 ? 'warn' : 'fg')});
      const history = stats.cpuHistory?.[key];
      if (history?.length > 2) ui.spark(new Rect(row.r - 190, row.y + 8, 110, 24), history, {max: Math.max(100, ...history)});
      ui.meter(new Rect(row.r - 190, row.y + 40, 182, 8), cpu / 100, {segments: 26});
      y += 60; ui.hair(inner.x, y, inner.r, y);
    }
    return y - inner.y;
  }

  function drawTopics(ui, inner) {
    const topics = [...blueprint.topics.values()].sort((a, b) => (b.bps || 0) - (a.bps || 0) || (b.hz || 0) - (a.hz || 0));
    let y = inner.y;
    for (const topic of topics) {
      const row = new Rect(inner.x, y, inner.w, 48);
      ui.text(topic.topic, row.x + 6, row.y + 16, {size: SIZE.sm, family: 'mono', color: ui.tone(topic.hz ? 'fg' : 'muted'), max: row.w - 250});
      ui.text(topic.type || 'python value', row.x + 6, row.y + 36, {size: SIZE.xs - 1, family: 'mono', color: ui.tone('muted', 0.8), max: row.w - 250});
      ui.text(hz(topic.hz), row.r - 8, row.y + 16, {size: SIZE.sm, family: 'mono', align: 'right'});
      ui.text(bytes(topic.bps, '/s'), row.r - 8, row.y + 36, {size: SIZE.xs, family: 'mono', align: 'right', color: ui.tone('muted')});
      if (topic.history?.length > 2) ui.spark(new Rect(row.r - 230, row.y + 10, 120, 28), topic.history);
      y += 48; ui.hair(inner.x, y, inner.r, y);
    }
    if (!topics.length) { ui.empty(new Rect(inner.x, inner.y, inner.w, 200), 'No topics.'); return 200; }
    return y - inner.y;
  }

  const panel = app.panel({
    id, title: 'Load', glyph: 'pulse', width: 0.44, height: 0.5, onClose: () => app.dock.close(id),
    draw(ui, content) {
      ui.chips(content.cutTop(36, 10), [['processes', 'PROCESSES'], ['topics', 'TOPICS']], state.tab, tab => { state.tab = tab; }, {id: 'tab', size: SIZE.xs});
      if (!blueprint.running) { ui.empty(content, 'No blueprint is running.'); return; }
      ui.scroll(content, state.tab, inner => state.tab === 'processes' ? drawProcesses(ui, inner) : drawTopics(ui, inner));
    },
  });
  for (const type of ['stats', 'rates', 'change']) blueprint.addEventListener(type, () => panel.invalidate(), {signal: panel.signal});
  return app.dock.open(panel, 'right');
}
