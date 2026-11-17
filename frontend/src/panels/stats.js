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

  function drawViewers(ui, inner) {
    const number = value => Number.isFinite(value) ? value.toFixed(1) : '—';
    let y = inner.y;
    const clients = [...app.diagnostics.clients].sort((a, b) => Number(a.stale) - Number(b.stale) || Number(b.immersive) - Number(a.immersive) || Number(b.visibility === 'visible') - Number(a.visibility === 'visible'));
    for (const client of clients) {
      const own = client.clientId === app.diagnostics.id ? ' · THIS VIEW' : '';
      const browser = /Chrome/.test(client.userAgent) ? 'CHROME' : /Safari/.test(client.userAgent) ? 'SAFARI' : 'BROWSER';
      ui.text(`${client.immersive ? 'HEADSET / XR' : browser} ${client.clientId.slice(0, 6)}${own}`, inner.x + 6, y + 18, {size: SIZE.md, weight: 500, color: ui.tone(client.stale ? 'muted' : 'fg')});
      ui.text(`${client.stale ? 'STALE · ' : ''}${client.visibility} · scene ${number(client.display?.fps)} fps · RTT ${number(client.link?.rttMs)} ms`, inner.x + 6, y + 42, {size: SIZE.xs, family: 'mono', max: inner.w - 12});
      y += 58;
      for (const camera of client.cameras || []) {
        ui.text(camera.key.replace(/^dimos\//, '').replace(/\/sensor_msgs\.[^/]+$/, ''), inner.x + 6, y + 16, {size: SIZE.sm, family: 'mono', max: inner.w - 12});
        ui.text(`fps: input ${number(camera.sourceFps)} · sent ${number(camera.sentFps)} · received ${number(camera.receivedFps)} · shown ${number(camera.displayedFps)}`, inner.x + 6, y + 38, {size: SIZE.xs, family: 'mono', max: inner.w - 12});
        ui.text(`track→shown p95 ${number(camera.latency?.stages?.trackToShown?.p95)} ms · buffer ${number(camera.jitterBufferMs)} ms`, inner.x + 6, y + 59, {size: SIZE.xs, family: 'mono', max: inner.w - 12});
        ui.text(`encode p95 ${number(camera.latency?.stages?.encoding?.p95)} ms · last frame ${number(camera.lastDisplayedAgoMs)} ms ago`, inner.x + 6, y + 80, {size: SIZE.xs, family: 'mono', color: ui.tone('muted'), max: inner.w - 12});
        y += 94;
      }
      const bandwidth = client.link?.gateway?.bandwidth;
      ui.text(`link budget ${number(bandwidth?.budgetBytesPerSec / 1e6)} MB/s · demand ${number(bandwidth?.demandBytesPerSec / 1e6)} MB/s`, inner.x + 6, y + 16, {size: SIZE.xs, family: 'mono', max: inner.w - 12}); y += 30;
      const streams = [...client.streams || []].filter(stream => stream.allocation).sort((a, b) => b.allocation.demandBytesPerSec - a.allocation.demandBytesPerSec).slice(0, 4);
      for (const stream of streams) {
        ui.text(stream.key, inner.x + 6, y + 16, {size: SIZE.xs, family: 'mono', max: inner.w - 12});
        ui.text(`grant ${number(stream.allocation.budgetBytesPerSec / 1e6)} / wants ${number(stream.allocation.demandBytesPerSec / 1e6)} MB/s · priority ${stream.bandwidthPriority ?? 1}`, inner.x + 6, y + 36, {size: SIZE.xs, family: 'mono', color: ui.tone('muted'), max: inner.w - 12});
        y += 48;
      }
      ui.hair(inner.x, y, inner.r, y); y += 12;
    }
    if (y === inner.y) { ui.empty(new Rect(inner.x, y, inner.w, 200), 'Waiting for viewer diagnostics.', app.diagnostics.error || 'Each viewer reports every two seconds after reloading.'); return 200; }
    return y - inner.y;
  }

  const panel = app.panel({
    id, title: 'Load', glyph: 'pulse', width: 0.44, height: 0.5, onClose: () => app.dock.close(id),
    draw(ui, content) {
      ui.chips(content.cutTop(36, 10), [['processes', 'PROCESSES'], ['topics', 'TOPICS'], ['viewers', 'VIEWERS']], state.tab, tab => { state.tab = tab; }, {id: 'tab', size: SIZE.xs});
      if (state.tab === 'viewers') { ui.scroll(content, state.tab, inner => drawViewers(ui, inner)); return; }
      if (!blueprint.running) { ui.empty(content, 'No blueprint is running.'); return; }
      ui.scroll(content, state.tab, inner => state.tab === 'processes' ? drawProcesses(ui, inner) : drawTopics(ui, inner));
    },
  });
  for (const type of ['stats', 'rates', 'change']) blueprint.addEventListener(type, () => panel.invalidate(), {signal: panel.signal});
  app.diagnostics.addEventListener('change', () => panel.invalidate(), {signal: panel.signal});
  return app.dock.open(panel, 'right');
}
