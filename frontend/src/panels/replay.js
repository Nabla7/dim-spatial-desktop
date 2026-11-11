// Replay: look at recorded episodes instead of the live blueprint. Four panels:
//   Replay    the datasets on this machine and their episodes; the open episode's facts and checks; a
//             check of the whole dataset
//   the deck  play, step, speed, and a timeline to scrub (above the command bar)
//   Cameras   each camera's picture at the playhead
//   Signals   every recorded quantity over the episode, with the playhead on it
// The world of the episode is drawn on the table by scene/replay.js. Everything shown comes from the
// episode as the server describes it (data/replay.js): no panel here knows a robot or a file format.
import {SIZE} from '../ui/holo.js';
import {Rect} from '../ui/rect.js';
import {clamp} from '../util.js';
import {openAgent} from './agent.js';

const LEVEL = {ok: 'ok', warn: 'warn', fail: 'danger', info: 'muted'};
const SERIES = ['primary', 'alt', 'info', 'warn', 'ok', 'agent'];
const GROUPS = [['joints', 'JOINTS'], ['error', 'ERROR'], ['timing', 'TIMING'], ['scene', 'OBJECTS'], ['other', 'OTHER']];
const WORLD = {
  recorded: ['WORLD', 'ok', 'Every body is where the saved world history says it was.'],
  resimulated: ['RE-SIM', 'info', 'The physics was run again from the recorded start and commands; the result was compared with the recording.'],
  recoverable: ['ARM ONLY', 'muted', 'No world history was saved with this episode. The robot is shown from its recorded joint states; everything else stays where it started.'],
  joints: ['ARM ONLY', 'muted', 'No world history was saved with this episode. The robot is shown from its recorded joint states; everything else stays where it started.'],
  none: ['NO WORLD', 'muted', 'This episode names no simulation record.'],
};
const SIDE = ['replay:cameras', 'replay:signals'];
const DECK_HEIGHT = 0.108;

const seconds = value => `${value.toFixed(2)} s`;
// A value with its unit: seconds are shown as milliseconds, since what is timed here is short.
const amount = (value, unit) => value == null || !Number.isFinite(value) ? '—' : unit === 's' ? `${(value * 1000).toFixed(1)} ms` : `${Math.abs(value) >= 100 ? value.toFixed(1) : value.toFixed(3)}${unit ? ` ${unit}` : ''}`;

// The episode ends: the table goes back to the live blueprint (the player's panels close with it, below).
export function endReplay(app) { app.replay.close(); }

// Heights at which the cameras and the signals share one column.
function sideHeights(app) {
  const free = app.dock.sideHeight(0.72) - 0.004, cameras = clamp(free * 0.42, 0.24, 0.34);
  return {cameras, signals: Math.max(0.28, free - cameras - 0.016)};
}

// An open episode brings its player with it, however it was opened, and takes it away when it closes.
// The side panels come with the first episode only: one the user closed stays closed for the next.
export function watchReplay(app) {
  app.replay.addEventListener('open', () => {
    if (app.dock.has('replay:deck')) return;
    openDeck(app);
    const heights = sideHeights(app);
    if (!app.dock.has('replay:cameras')) openCameras(app, heights.cameras);
    if (!app.dock.has('replay:signals')) openSignals(app, heights.signals);
  });
  app.replay.addEventListener('close', () => { for (const id of ['replay:deck', ...SIDE]) if (app.dock.has(id)) app.dock.close(id); });
}

// -- the library ----------------------------------------------------------------------------------------
export function openReplay(app, restore = null) {
  const id = 'replay', replay = app.replay;
  if (app.dock.has(id)) { if (!restore) app.dock.close(id); return; }
  const state = {tab: 'episodes', choosing: false, filter: 'all', folder: '', adding: false, note: ''};

  async function addFolder() {
    if (!state.folder.trim() || state.adding) return;
    state.adding = true; state.note = ''; panel.invalidate();
    try { await replay.addFolder(state.folder); state.folder = ''; state.choosing = false; if (app.text.active) app.text.blur(); }
    catch (error) { state.note = error.message; }
    state.adding = false; panel.invalidate();
  }

  function drawChooser(ui, area) {
    ui.heading(area.cutTop(26, 8), 'Datasets on this machine', `${replay.datasets.length}`);
    const add = area.cutBottom(state.note ? 112 : 84, 8);
    ui.text('A folder that holds an `episodes` folder:', add.x, add.y + 12, {size: SIZE.xs, color: ui.tone('muted')});
    const row = new Rect(add.x, add.y + 28, add.w, 44), button = row.cutRight(96, 8);
    ui.field(row, state.folder, {id: 'folder', placeholder: '/full/path/to/a/folder', family: 'mono', onInput: value => { state.folder = value; }, onSubmit: addFolder});
    ui.button(button, state.adding ? '…' : 'ADD', addFolder, {id: 'folder:add', size: SIZE.sm, enabled: !!state.folder.trim() && !state.adding});
    if (state.note) ui.wrap(state.note, new Rect(add.x, add.y + 78, add.w, 0), {size: SIZE.xs, color: ui.tone('warn'), maxLines: 2});
    ui.scroll(area, 'datasets', inner => {
      let y = inner.y;
      for (const dataset of replay.datasets) {
        const row = new Rect(inner.x, y, inner.w, 52);
        ui.row(row, {id: `dataset:${dataset.id}`, selected: dataset.id === replay.dataset?.id, onClick: () => { state.choosing = false; replay.choose(dataset.id); }});
        ui.text(dataset.label, row.x + 14, row.y + 18, {size: SIZE.sm, weight: 500, max: row.w - 28});
        ui.text(dataset.where, row.x + 14, row.y + 38, {size: SIZE.xs - 2, family: 'mono', color: ui.tone('muted'), max: row.w - 28});
        y += 52; ui.hair(inner.x, y, inner.r, y);
      }
      return y - inner.y;
    });
  }

  function drawEpisodes(ui, area) {
    if (replay.datasets === null) { ui.empty(area, 'Looking for recorded episodes…'); return; }
    if (state.choosing || !replay.dataset) {
      if (!replay.datasets.length && !state.choosing) ui.text('No recorded episodes were found under Desktop\'s app data.', area.x, area.cutTop(30, 4).cy, {size: SIZE.sm, color: ui.tone('muted'), max: area.w});
      drawChooser(ui, area); return;
    }
    const head = area.cutTop(48, 8), again = head.cutRight(48, 8);
    ui.button(head, replay.dataset.label, () => { state.choosing = true; }, {id: 'dataset', size: SIZE.sm, align: 'left', icon: 'down', sub: `${replay.datasets.length} datasets · press to choose another or add a folder`});
    ui.button(again, '', () => replay.refresh(true), {id: 'rescan', icon: 'refresh', tone: 'muted', enabled: !replay.busy});
    const rows = replay.rows, kept = rows.filter(row => row.kept), frames = kept.reduce((sum, row) => sum + (row.frames || 0), 0);
    ui.text(`${kept.length} kept · ${rows.length - kept.length} not kept · ${frames.toLocaleString()} frames in the kept ones`, area.x, area.cutTop(22, 6).cy, {size: SIZE.xs, family: 'mono', color: ui.tone('muted'), max: area.w});
    ui.chips(area.cutTop(34, 8), [['all', 'ALL'], ['kept', 'KEPT'], ['rest', 'NOT KEPT']], state.filter, value => { state.filter = value; }, {id: 'filter', size: SIZE.xs});
    if (!rows.length) { ui.empty(area, replay.busy ? 'Reading the dataset…' : 'This dataset has no episodes.'); return; }
    const marks = new Map((replay.audit?.result?.episodes || []).map(entry => [entry.id, entry.level]));
    ui.scroll(area, `episodes:${replay.dataset.id}:${state.filter}`, inner => {
      let y = inner.y;
      rows.forEach((row, index) => {
        if (state.filter === 'kept' ? !row.kept : state.filter === 'rest' ? row.kept : false) return;
        const cell = new Rect(inner.x, y, inner.w, 56), open = row.name === replay.name, loading = replay.loading === row.name;
        ui.row(cell, {id: `episode:${row.name}`, selected: open, onClick: () => replay.open(row.name)});
        const tone = !row.kept ? 'muted' : row.outcome === 'success' ? 'ok' : row.outcome === 'failure' ? 'danger' : 'warn';
        ui.lamp(cell.x + 16, cell.y + 20, tone, loading);
        const [tag, tagTone] = WORLD[row.world] || WORLD.none;
        const badge = ui.badge(cell.r - 8, cell.y + 20, tag, {tone: tagTone, align: 'right', size: SIZE.xs - 3});
        const mark = marks.get(row.name);
        if (mark && mark !== 'ok') ui.icon('warn', cell.r - badge - 24, cell.y + 20, 16, ui.tone(LEVEL[mark]));
        ui.text(`#${index + 1}${row.seed == null ? '' : `  seed ${row.seed}`}`, cell.x + 32, cell.y + 20, {size: SIZE.sm, weight: 500, family: 'mono', color: ui.tone(row.kept ? 'fg' : 'muted'), max: cell.w - badge - 80});
        const length = row.frames && row.fps ? ` · ${(row.frames / row.fps).toFixed(1)} s` : '';
        ui.text([row.outcome || 'ungraded', row.split, row.demonstrator, row.frames == null ? null : `${row.frames} frames${length}`].filter(Boolean).join(' · '), cell.x + 32, cell.y + 41, {size: SIZE.xs - 1, family: 'mono', color: ui.tone('muted'), max: cell.w - 44});
        y += 56; ui.hair(inner.x, y, inner.r, y);
      });
      return y - inner.y;
    });
  }

  function drawFacts(ui, area) {
    const recording = replay.recording;
    if (!recording) { ui.empty(area, 'Open an episode to see what was recorded about it.'); return; }
    ui.scroll(area, `facts:${recording.id}`, inner => {
      let y = inner.y;
      for (const group of recording.facts) {
        ui.heading(new Rect(inner.x, y + 8, inner.w, 24), group.title); y += 42;
        for (const [key, value] of group.rows) {
          ui.text(key.replace(/_/g, ' '), inner.x, y + 10, {size: SIZE.xs, color: ui.tone('muted'), max: 168});
          y += Math.max(24, ui.wrap(String(value), new Rect(inner.x + 178, y, inner.w - 178, 0), {size: SIZE.xs, family: 'mono', lineHeight: 1.4}) + 4);
        }
      }
      return y - inner.y + 8;
    });
  }

  // A check: a lamp, what was checked, and what was found.
  function drawCheck(ui, inner, y, entry) {
    ui.lamp(inner.x + 10, y + 13, LEVEL[entry.level] || 'muted');
    ui.text(entry.label, inner.x + 28, y + 13, {size: SIZE.sm, weight: 500, max: inner.w - 30});
    return y + 28 + ui.wrap(entry.detail, new Rect(inner.x + 28, y + 26, inner.w - 30, 0), {size: SIZE.xs, color: ui.tone('muted'), lineHeight: 1.4}) + 10;
  }

  function drawChecks(ui, area) {
    const recording = replay.recording;
    if (!recording) { ui.empty(area, 'Open an episode to check it.'); return; }
    const counts = {ok: 0, warn: 0, fail: 0, info: 0};
    for (const entry of recording.checks) counts[entry.level]++;
    const verdict = counts.fail ? 'fail' : counts.warn ? 'warn' : 'ok', line = area.cutTop(30, 6);
    ui.lamp(line.x + 10, line.cy, LEVEL[verdict]);
    ui.text(`${counts.ok} passed · ${counts.warn} warnings · ${counts.fail} failures`, line.x + 28, line.cy + 1, {size: SIZE.sm, family: 'mono'});
    const ask = area.cutBottom(40, 8);
    ui.button(ask, 'ASK AN AGENT ABOUT THIS EPISODE', () => openAgent(app, {draft: `Look at a recorded episode with me. Its folder is ${replay.dataset.path}/${replay.name}. I am ${seconds(replay.time)} into it (frame ${replay.frame + 1} of ${recording.count}). `}), {id: 'ask', icon: 'agent', size: SIZE.xs, tone: 'agent'});
    ui.scroll(area, `checks:${recording.id}`, inner => {
      let y = inner.y;
      // The world first: where its picture on the table comes from, and how to get the rest of it.
      const world = recording.world, [tag, tone, meaning] = WORLD[replay.world.state === 'ready' ? replay.world.source : world.source] || WORLD.none;
      ui.heading(new Rect(inner.x, y + 4, inner.w, 24), 'The world on the table'); y += 38;
      ui.badge(inner.x, y + 10, tag, {tone, size: SIZE.xs - 2});
      const state = replay.world.state === 'loading' ? 'Reading the world…' : replay.world.state === 'failed' ? `The world could not be read: ${replay.world.note}` : world.note || meaning;
      y += 26 + ui.wrap(state, new Rect(inner.x, y + 26, inner.w, 0), {size: SIZE.xs, color: ui.tone(replay.world.state === 'failed' ? 'warn' : 'muted'), lineHeight: 1.4}) + 8;
      const job = world.job, running = job?.state === 'running';
      if (world.recoverable || running) {
        ui.button(new Rect(inner.x, y, inner.w, 40), running ? `RUNNING THE PHYSICS AGAIN… ${Math.round((Date.now() - job.startedAt) / 1000)} s` : 'RUN THE PHYSICS AGAIN TO GET THE WORLD', () => replay.recover(), {id: 'recover', size: SIZE.xs, enabled: !running, icon: running ? null : 'refresh'});
        y += 48;
        if (running) panel.invalidate();
        else y += ui.wrap('dimos repeats the episode in sim2 from the recorded start and commands, without cameras (about 15 seconds), and compares the joint states it gets with the recorded ones.', new Rect(inner.x, y, inner.w, 0), {size: SIZE.xs - 1, color: ui.tone('muted'), lineHeight: 1.4}) + 8;
      }
      if (job?.state === 'failed') y += ui.wrap(`The physics could not be run again: ${job.error}`, new Rect(inner.x, y, inner.w, 0), {size: SIZE.xs, color: ui.tone('warn'), lineHeight: 1.4}) + 8;
      const again = world.recovery;
      if (again?.state_difference) {
        const ends = Object.entries(again.end_difference_m || {}).map(([name, metres]) => `${name.replace(/_/g, ' ')} ${(metres * 1000).toFixed(2)} mm`).join(', ');
        const small = value => value === 0 ? '0' : value.toExponential(1);
        const text = `Against the recording: joint states differ by at most ${small(again.state_difference.largest)} (frame ${again.state_difference.at_frame + 1}), commands by ${small(again.action_difference)}`
          + `${ends ? `; at the end, ${ends} apart` : ''}. ${again.runtime?.unchanged ? 'The sim2 runtime file is the one that made the episode.' : 'The sim2 runtime file has changed since the episode was made.'}`
          + `${again.stopped ? ` The repeat stopped early: ${again.stopped}.` : ''}`;
        y += ui.wrap(text, new Rect(inner.x, y, inner.w, 0), {size: SIZE.xs, color: ui.tone(again.stopped ? 'warn' : 'muted'), lineHeight: 1.4}) + 8;
      }
      ui.heading(new Rect(inner.x, y + 4, inner.w, 24), 'Checks of this episode'); y += 40;
      for (const level of ['fail', 'warn', 'ok', 'info']) for (const entry of recording.checks) if (entry.level === level) y = drawCheck(ui, inner, y, entry);
      return y - inner.y;
    });
  }

  function drawDataset(ui, area) {
    if (!replay.dataset) { ui.empty(area, 'Choose a dataset first.'); return; }
    const audit = replay.audit, job = audit?.job, result = audit?.result, running = job?.state === 'running';
    const top = area.cutTop(44, 8);
    ui.button(top, running ? `CHECKING ${job.done ?? 0} OF ${job.total ?? '…'}` : result ? 'CHECK EVERY EPISODE AGAIN' : 'CHECK EVERY EPISODE', () => replay.runAudit(), {id: 'audit', size: SIZE.sm, enabled: !running, icon: running ? null : 'check'});
    if (running) { ui.meter(area.cutTop(8, 10), (job.done || 0) / Math.max(1, job.total || 1), {segments: 48}); panel.invalidate(); }
    if (job?.state === 'failed') ui.wrap(`The check did not finish: ${job.error}`, area.cutTop(44, 6), {size: SIZE.xs, color: ui.tone('warn'), maxLines: 2});
    if (!result) { if (!running) ui.empty(area, 'Reads every episode of this dataset', 'and reports what does not hold. About 0.3 s an episode.'); return; }
    ui.text(`${audit.stale ? 'Episodes changed since this check · ' : ''}checked ${new Date(result.at * 1000).toLocaleString([], {hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short'})} in ${result.seconds.toFixed(0)} s`, area.x, area.cutTop(20, 6).cy, {size: SIZE.xs - 1, family: 'mono', color: ui.tone(audit.stale ? 'warn' : 'muted'), max: area.w});
    ui.scroll(area, `audit:${replay.dataset.id}`, inner => {
      let y = inner.y;
      for (const finding of result.findings) y = drawCheck(ui, inner, y, finding);
      const bad = result.episodes.filter(entry => entry.level !== 'ok');
      if (bad.length) {
        ui.heading(new Rect(inner.x, y + 6, inner.w, 24), 'Episodes to look at', `${bad.length}`); y += 40;
        for (const entry of bad) {
          const index = replay.rows.findIndex(row => row.name === entry.id), text = entry.problems.map(problem => problem.label).join('; ');
          const height = 30 + ui.wrap(text, new Rect(inner.x + 28, y + 26, inner.w - 30, 0), {size: SIZE.xs, lineHeight: 1.4, measure: true}), row = new Rect(inner.x, y, inner.w, height);
          ui.row(row, {id: `audit:${entry.id}`, selected: entry.id === replay.name, onClick: () => { state.tab = 'checks'; replay.open(entry.id); }});
          ui.lamp(row.x + 10, y + 13, LEVEL[entry.level]);
          ui.text(`#${index + 1}  ${entry.id.slice(0, 8)}`, row.x + 28, y + 13, {size: SIZE.sm, family: 'mono', weight: 500});
          ui.wrap(text, new Rect(inner.x + 28, y + 26, inner.w - 30, 0), {size: SIZE.xs, color: ui.tone('muted'), lineHeight: 1.4});
          y += height + 4;
        }
      }
      for (const chart of result.charts) y = drawChart(ui, inner, y + 10, chart);
      return y - inner.y + 10;
    });
  }

  const tabs = {episodes: drawEpisodes, facts: drawFacts, checks: drawChecks, dataset: drawDataset};
  const panel = app.panel({
    // The deck comes with the first episode and takes its height from the columns: leave room for it now.
    id, title: 'Replay', glyph: 'film', width: 0.42, height: app.dock.sideHeight() - (app.dock.has('replay:deck') ? 0 : DECK_HEIGHT + 0.016), onClose: () => app.dock.close(id),
    draw(ui, content) {
      panel.tag = replay.recording ? `#${replay.rows.findIndex(row => row.name === replay.name) + 1}` : '';
      panel.busy = replay.busy || !!replay.loading;
      ui.chips(content.cutTop(38, 10), [['episodes', 'EPISODES'], ['facts', 'FACTS'], ['checks', 'CHECKS'], ['dataset', 'DATASET']], state.tab, tab => { state.tab = tab; }, {id: 'tab', size: SIZE.xs});
      if (replay.error) content.cutTop(ui.wrap(replay.error, new Rect(content.x, content.y, content.w, 0), {size: SIZE.xs, color: ui.tone('danger'), maxLines: 3}) + 8, 0);
      tabs[state.tab](ui, content);
    },
  });
  for (const type of ['change', 'world']) replay.addEventListener(type, () => panel.invalidate(), {signal: panel.signal});
  app.dock.open(panel, 'left');
  // What was open before a reload comes back; otherwise the list is read afresh each time the panel opens.
  replay.refresh().then(() => { if (restore?.episode && replay.dataset?.id === restore.dataset) replay.open(restore.episode).then(() => { if (Number.isFinite(restore.time)) replay.seek(restore.time); }); });
  return panel;
}

// -- charts of a dataset ---------------------------------------------------------------------------------
function drawChart(ui, inner, y, chart) {
  const ctx = ui.ctx;
  ui.heading(new Rect(inner.x, y, inner.w, 24), chart.title); y += 34;
  if (chart.kind === 'bars') {
    const most = Math.max(1, ...chart.items.map(item => item.value));
    for (const item of chart.items) {
      ui.text(item.label, inner.x, y + 9, {size: SIZE.xs - 1, color: ui.tone('fg'), max: inner.w - 60});
      ui.text(String(item.value), inner.r, y + 9, {size: SIZE.xs, family: 'mono', align: 'right'});
      ctx.fillStyle = ui.tone('muted', 0.16); ctx.fillRect(inner.x, y + 20, inner.w, 5);
      ctx.fillStyle = ui.tone(item.tone === 'muted' ? 'primary' : item.tone || 'primary', item.tone === 'muted' ? 0.55 : 0.95); ctx.fillRect(inner.x, y + 20, inner.w * item.value / most, 5);
      y += 34;
    }
    return y;
  }
  if (chart.kind === 'histogram') {
    // A second set of values (what was tried and not kept) is drawn as an outline over the same range,
    // each set as shares of its own total, so their shapes compare whatever their sizes.
    const values = chart.values.filter(Number.isFinite), other = (chart.reference || []).filter(Number.isFinite), every = values.concat(other);
    const low = Math.min(...every), high = Math.max(...every), count = 16;
    const binned = list => { const bins = new Array(count).fill(0); for (const value of list) bins[Math.min(count - 1, Math.floor((value - low) / (high - low || 1) * count))] += 1 / list.length; return bins; };
    const bins = binned(values), outline = other.length ? binned(other) : null, most = Math.max(...bins, ...(outline || [0]));
    const plot = new Rect(inner.x, y, inner.w, 64), width = plot.w / count;
    bins.forEach((share, index) => { const height = plot.h * share / most; ctx.fillStyle = ui.tone('primary', 0.75); ctx.fillRect(plot.x + index * width + 1, plot.b - height, width - 2, height); });
    if (outline) { ctx.strokeStyle = ui.tone('warn', 0.95); ctx.lineWidth = 1.5; outline.forEach((share, index) => { const height = plot.h * share / most; ctx.strokeRect(plot.x + index * width + 1.5, plot.b - height, width - 3, height); }); }
    ui.hair(plot.x, plot.b, plot.r, plot.b, ui.tone('muted', 0.6));
    ui.text(low.toPrecision(4), plot.x, plot.b + 12, {size: SIZE.xs - 2, family: 'mono', color: ui.tone('muted')});
    ui.text(outline ? `filled: ${values.length} kept · outline: ${other.length} not kept` : `${values.length} values`, plot.cx, plot.b + 12, {size: SIZE.xs - 2, family: 'mono', color: ui.tone('muted'), align: 'center'});
    ui.text(high.toPrecision(4), plot.r, plot.b + 12, {size: SIZE.xs - 2, family: 'mono', color: ui.tone('muted'), align: 'right'});
    return y + 64 + 26;
  }
  // scatter: points on a plane, one colour per series, drawn to scale when both axes are lengths.
  const all = chart.series.flatMap(series => series.points);
  if (!all.length) return y;
  let x0 = Math.min(...all.map(p => p[0])), x1 = Math.max(...all.map(p => p[0])), y0 = Math.min(...all.map(p => p[1])), y1 = Math.max(...all.map(p => p[1]));
  const padX = (x1 - x0 || 1) * 0.06, padY = (y1 - y0 || 1) * 0.06; x0 -= padX; x1 += padX; y0 -= padY; y1 += padY;
  let width = inner.w, height = 230;
  if (chart.equal) { const scale = Math.min(width / (x1 - x0), 300 / (y1 - y0)); height = (y1 - y0) * scale; width = (x1 - x0) * scale; }
  const plot = new Rect(inner.x + (inner.w - width) / 2, y, width, height);
  ctx.fillStyle = ui.tone('bg', 0.5); ctx.fillRect(plot.x, plot.y, plot.w, plot.h);
  ctx.strokeStyle = ui.tone('muted', 0.4); ctx.lineWidth = 1; ctx.strokeRect(plot.x + 0.5, plot.y + 0.5, plot.w - 1, plot.h - 1);
  chart.series.forEach((series, index) => {
    const tone = series.tone === 'muted' ? 'muted' : series.tone || SERIES[index % SERIES.length];
    ctx.fillStyle = ui.tone(tone, tone === 'muted' ? 0.45 : 0.95);
    for (const [px, py] of series.points) { ctx.beginPath(); ctx.arc(plot.x + plot.w * (px - x0) / (x1 - x0), plot.b - plot.h * (py - y0) / (y1 - y0), tone === 'muted' ? 2 : 3, 0, Math.PI * 2); ctx.fill(); }
  });
  y += height + 14;
  ui.text(`${chart.x} ${x0.toFixed(2)} to ${x1.toFixed(2)} · ${chart.y} ${y0.toFixed(2)} to ${y1.toFixed(2)}`, inner.x, y, {size: SIZE.xs - 2, family: 'mono', color: ui.tone('muted'), max: inner.w});
  y += 20;
  let x = inner.x;
  chart.series.forEach((series, index) => {
    const tone = series.tone === 'muted' ? 'muted' : series.tone || SERIES[index % SERIES.length];
    ctx.fillStyle = ui.tone(tone); ctx.beginPath(); ctx.arc(x + 5, y, 4, 0, Math.PI * 2); ctx.fill();
    x += 16 + ui.text(`${series.label} (${series.points.length})`, x + 14, y + 1, {size: SIZE.xs - 1, color: ui.tone('muted')}) + 14;
  });
  return y + 18;
}

// -- the deck: transport and timeline ---------------------------------------------------------------------
function openDeck(app) {
  const id = 'replay:deck', replay = app.replay, scene = app.replayScene;
  const panel = app.panel({
    id, bare: true, width: 1.0, height: DECK_HEIGHT,
    draw(ui, content) {
      const recording = replay.recording;
      if (!recording) { ui.text(replay.loading ? 'Reading the episode…' : 'No episode is open.', content.cx, content.cy, {size: SIZE.sm, color: ui.tone('muted'), align: 'center'}); return; }
      const top = content.cutTop(44, 8), index = replay.rows.findIndex(row => row.name === replay.name);
      const keys = top.cutLeft(5 * 46 + 4 * 6, 16).cols(5, 6);
      ui.button(keys[0], '', () => replay.neighbour(-1), {id: 'previous', icon: 'skipBack', tone: 'muted', enabled: index > 0});
      ui.button(keys[1], '', () => replay.step(-1), {id: 'back', icon: 'stepBack'});
      ui.button(keys[2], '', () => replay.toggle(), {id: 'play', icon: replay.playing ? 'pause' : 'play', on: replay.playing});
      ui.button(keys[3], '', () => replay.step(1), {id: 'on', icon: 'stepOn'});
      ui.button(keys[4], '', () => replay.neighbour(1), {id: 'next', icon: 'skipOn', tone: 'muted', enabled: index >= 0 && index < replay.rows.length - 1});
      ui.button(top.cutRight(44, 12), '', () => endReplay(app), {id: 'end', icon: 'close', tone: 'muted'});
      // What is drawn on the table.
      const options = scene.options, shown = top.cutRight(5 * 66 + 4 * 5, 14).cols(5, 5), live = replay.world.state === 'ready';
      [['ghost', 'GHOST'], ['trails', 'PATHS'], ['cameras', 'CAMS'], ['surroundings', 'ROOM']].forEach(([name, label], at) =>
        ui.button(shown[at], label, () => scene.set(name, !options[name]), {id: `show:${name}`, size: SIZE.xs - 2, on: live && options[name], enabled: live, tone: 'alt'}));
      ui.button(shown[4], options.style === 'solid' ? 'SOLID' : 'HOLO', () => scene.set('style', options.style === 'solid' ? 'holo' : 'solid'), {id: 'show:style', size: SIZE.xs - 2, enabled: live});
      ui.button(top.cutRight(60, 14), 'LOOP', () => { replay.loop = !replay.loop; }, {id: 'loop', size: SIZE.xs - 2, on: replay.loop});
      ui.chips(top.cutRight(5 * 42 + 4 * 4, 12), [[0.25, '¼×'], [0.5, '½×'], [1, '1×'], [2, '2×'], [4, '4×']], replay.speed, speed => replay.setSpeed(speed), {id: 'speed', size: SIZE.xs - 1});
      const band = recording.bands[0]?.runs.find(run => replay.frame >= run.from && replay.frame < run.to);
      ui.text(`${seconds(replay.time)} / ${seconds(replay.end)}`, top.x, top.cy - 9, {size: SIZE.sm, family: 'mono', max: top.w});
      ui.text(`frame ${replay.frame + 1} of ${recording.count}${band ? ` · ${band.label}` : ''}`, top.x, top.cy + 12, {size: SIZE.xs - 1, family: 'mono', color: ui.tone('muted'), max: top.w});
      // The episode's two side panels: another panel may have taken their column, these bring them back.
      const side = content.cutRight(112, 12), half = (side.h - 6) / 2;
      [['cameras', 'CAMERAS', openCameras], ['signals', 'SIGNALS', openSignals]].forEach(([name, label, open], at) => {
        const shown = app.dock.has(`replay:${name}`);
        ui.button(new Rect(side.x, side.y + at * (half + 6), side.w, half), label, () => shown ? app.dock.close(`replay:${name}`) : open(app, sideHeights(app)[name]), {id: `panel:${name}`, size: SIZE.xs - 3, on: shown});
      });
      drawTimeline(ui, content, replay);
    },
  });
  panel.minInterval = 33;
  for (const type of ['change', 'seek', 'world']) replay.addEventListener(type, () => panel.invalidate(), {signal: panel.signal});
  scene.addEventListener('change', () => panel.invalidate(), {signal: panel.signal});
  app.dock.addEventListener('change', () => panel.invalidate(), {signal: panel.signal});
  return app.dock.open(panel, 'deck');
}

// The whole episode from left to right: what was happening (bands), what the checks flagged, the playhead.
function drawTimeline(ui, area, replay) {
  const ctx = ui.ctx, recording = replay.recording, times = replay.times, start = replay.start, span = Math.max(1e-6, replay.end - start);
  const x = time => area.x + area.w * (time - start) / span, bands = new Rect(area.x, area.y, area.w, area.h - 16);
  ctx.fillStyle = ui.tone('input', 0.7); ctx.fillRect(bands.x, bands.y, bands.w, bands.h);
  const runs = recording.bands[0]?.runs || [];
  runs.forEach((run, index) => {
    const left = x(times[run.from]), right = run.to < times.length ? x(times[run.to]) : area.r;
    ctx.fillStyle = ui.tone(index % 2 ? 'alt' : 'primary', 0.17); ctx.fillRect(left, bands.y, right - left, bands.h);
    ctx.fillStyle = ui.tone(index % 2 ? 'alt' : 'primary', 0.8); ctx.fillRect(left, bands.y, 1.5, bands.h);
    if (right - left > 34) ui.text(String(run.label), left + 7, bands.y + 13, {size: SIZE.xs - 2, family: 'display', color: ui.tone('fg', 0.85), track: 1, max: right - left - 10});
  });
  // A second kind of band (who commanded, for one) as a thin strip along the bottom of the first.
  (recording.bands[1]?.runs || []).forEach((run, index) => {
    ctx.fillStyle = ui.tone(SERIES[index % SERIES.length], 0.9);
    ctx.fillRect(x(times[run.from]), bands.b - 4, (run.to < times.length ? x(times[run.to]) : area.r) - x(times[run.from]), 4);
  });
  // Seconds along the bottom.
  const each = span > 120 ? 30 : span > 40 ? 10 : span > 12 ? 5 : 1;
  for (let tick = Math.ceil(start / each) * each; tick <= replay.end + 1e-6; tick += each) {
    ui.hair(x(tick), bands.b, x(tick), bands.b + 5, ui.tone('muted', 0.8));
    ui.text(`${tick.toFixed(0)}`, x(tick), bands.b + 12, {size: SIZE.xs - 3, family: 'mono', color: ui.tone('muted'), align: 'center'});
  }
  for (const flag of recording.flags) { ctx.fillStyle = ui.tone(LEVEL[flag.level] || 'warn'); ctx.fillRect(x(times[flag.index]) - 1, bands.b - 14, 2.5, 14); }
  // What has played, and the playhead.
  const head = x(replay.time);
  ctx.fillStyle = ui.tone('fg', 0.07); ctx.fillRect(bands.x, bands.y, head - bands.x, bands.h);
  ctx.shadowColor = ui.tone('fg'); ctx.shadowBlur = 10; ctx.fillStyle = ui.tone('fg'); ctx.fillRect(head - 1.5, bands.y - 3, 3, bands.h + 6); ctx.shadowBlur = 0;
  ctx.beginPath(); ctx.moveTo(head - 7, bands.y - 4); ctx.lineTo(head + 7, bands.y - 4); ctx.lineTo(head, bands.y + 5); ctx.closePath(); ctx.fill();
  const scrub = px => { replay.scrubbing = true; replay.seek(start + span * clamp((px - area.x) / area.w, 0, 1)); };
  ui.region(new Rect(area.x, area.y - 4, area.w, area.h + 4), {id: 'timeline', onDown: scrub, onDrag: scrub, onUp: () => { replay.scrubbing = false; }});
}

// -- cameras ------------------------------------------------------------------------------------------------
function openCameras(app, height) {
  const id = 'replay:cameras', replay = app.replay, state = {solo: null};
  const panel = app.panel({
    id, title: 'Cameras', glyph: 'camera', width: 0.44, height, onClose: () => app.dock.close(id),
    draw(ui, content) {
      const recording = replay.recording, all = replay.pictures;
      if (!recording) { ui.empty(content, 'No episode is open.'); return; }
      if (!all.length) { ui.empty(content, 'This episode has no camera images.'); return; }
      const shown = all.filter(pictures => !state.solo || pictures.name === state.solo), list = shown.length ? shown : all;
      panel.tag = `${all[0].width}×${all[0].height}`;
      list.forEach((pictures, index) => {
        const cell = content.cols(list.length, 10)[index], label = cell.cutBottom(24, 4), ready = pictures.shown === replay.frame;
        ui.ctx.fillStyle = ui.tone('bg', 0.9); ui.ctx.fillRect(cell.x, cell.y, cell.w, cell.h);
        if (pictures.shown >= 0) {
          const scale = Math.min(cell.w / pictures.canvas.width, cell.h / pictures.canvas.height), w = pictures.canvas.width * scale, h = pictures.canvas.height * scale;
          ui.ctx.imageSmoothingEnabled = scale < 2.5;
          ui.ctx.drawImage(pictures.canvas, cell.cx - w / 2, cell.cy - h / 2, w, h);
          ui.ctx.imageSmoothingEnabled = true;
        } else ui.text('reading…', cell.cx, cell.cy, {size: SIZE.xs, color: ui.tone('muted'), align: 'center'});
        if (!ready) ui.lamp(cell.x + 12, cell.y + 12, 'warn', true);
        const age = recording.scalars.find(scalar => scalar.name === `age:${pictures.name}`)?.values[replay.frame];
        ui.text(pictures.name, label.x + 2, label.cy + 1, {size: SIZE.xs, family: 'display', color: ui.tone('primary'), track: 1.5});
        ui.text(age == null ? '' : `${amount(age, 's')} old at this frame`, label.r, label.cy + 1, {size: SIZE.xs - 2, family: 'mono', color: ui.tone('muted'), align: 'right', max: label.w - 90});
        ui.region(cell, {id: `camera:${pictures.name}`, onClick: () => { state.solo = state.solo ? null : pictures.name; }});
      });
    },
  });
  panel.minInterval = 33;
  for (const type of ['picture', 'frame', 'open', 'change']) replay.addEventListener(type, () => panel.invalidate(), {signal: panel.signal});
  return app.dock.open(panel, 'right');
}

// -- signals ------------------------------------------------------------------------------------------------
// Tracks for one group of an episode's signals. Vector signals with the same labels are the same quantities
// seen several ways (a state, a command): one track per label with a line per signal. A lone small vector
// (a position) is one track with a line per component. Each number series is a track of its own.
function tracksOf(recording, group) {
  const tracks = [], families = new Map();
  for (const signal of recording.signals) if (signal.group === group) { const key = signal.labels.join('|'); if (!families.has(key)) families.set(key, []); families.get(key).push(signal); }
  const column = (signal, at) => signal.values.map(row => row?.[at] ?? null);
  for (const signals of families.values()) {
    const labels = signals[0].labels;
    if (signals.length > 1 || labels.length > 4) labels.forEach((label, at) => tracks.push({label, unit: signals[0].unit || '', series: signals.map(signal => ({name: signal.label, values: column(signal, at)}))}));
    else for (const signal of signals) tracks.push({label: signal.label, unit: signal.unit || '', series: labels.map((label, at) => ({name: label, values: column(signal, at)}))});
  }
  for (const scalar of recording.scalars) if (scalar.group === group) tracks.push({label: scalar.label, unit: scalar.unit || '', series: [{name: '', values: scalar.values}]});
  for (const track of tracks) {
    let low = Infinity, high = -Infinity;
    for (const series of track.series) for (const value of series.values) if (value != null) { if (value < low) low = value; if (value > high) high = value; }
    if (!Number.isFinite(low)) { low = 0; high = 1; }
    const room = Math.max((high - low) * 0.08, 1e-6);
    track.low = low - room; track.high = high + room;
  }
  return tracks;
}

function openSignals(app, height) {
  const id = 'replay:signals', replay = app.replay, state = {group: null, built: null, tracks: []};
  const panel = app.panel({
    id, title: 'Signals', glyph: 'pulse', width: 0.44, height, onClose: () => app.dock.close(id),
    draw(ui, content) {
      const recording = replay.recording;
      if (!recording) { ui.empty(content, 'No episode is open.'); return; }
      const present = new Set([...recording.signals, ...recording.scalars].map(entry => entry.group)), groups = GROUPS.filter(([group]) => present.has(group));
      if (!groups.length) { ui.empty(content, 'This episode has no recorded quantities.'); return; }
      if (!present.has(state.group)) state.group = groups[0][0];
      ui.chips(content.cutTop(34, 8), groups, state.group, group => { state.group = group; }, {id: 'group', size: SIZE.xs - 1});
      const key = `${recording.id}|${state.group}|${recording.signals.length}`;
      if (state.built !== key) { state.built = key; state.tracks = tracksOf(recording, state.group); }
      const tracks = state.tracks, names = tracks[0]?.series.map(series => series.name).filter(Boolean) || [];
      if (names.length > 1) {
        const legend = content.cutTop(20, 6);
        let x = legend.x;
        names.forEach((name, index) => { ui.ctx.fillStyle = ui.tone(SERIES[index % SERIES.length]); ui.ctx.fillRect(x, legend.cy - 1.5, 16, 3); x += 22 + ui.text(name, x + 22, legend.cy + 1, {size: SIZE.xs - 2, family: 'mono', color: ui.tone('muted')}) + 14; });
      }
      panel.tag = `${tracks.length} tracks`;
      ui.scroll(content, `tracks:${state.group}`, inner => {
        let y = inner.y;
        for (const track of tracks) { drawTrack(ui, new Rect(inner.x, y, inner.w, 78), track, replay); y += 84; }
        return y - inner.y;
      });
    },
  });
  panel.minInterval = 50;
  for (const type of ['seek', 'open', 'world', 'change']) replay.addEventListener(type, () => panel.invalidate(), {signal: panel.signal});
  return app.dock.open(panel, 'right');
}

function drawTrack(ui, rect, track, replay) {
  const ctx = ui.ctx, times = replay.times, start = replay.start, span = Math.max(1e-6, replay.end - start), frame = replay.frame;
  const plot = new Rect(rect.x, rect.y + 22, rect.w, rect.h - 24), range = track.high - track.low;
  const px = index => plot.x + plot.w * (times[index] - start) / span, py = value => plot.b - plot.h * (value - track.low) / range;
  ui.text(track.label, rect.x, rect.y + 10, {size: SIZE.xs, family: 'mono', color: ui.tone('fg'), max: rect.w * 0.45});
  // The values at the playhead, in the colours of their lines.
  let right = rect.r;
  for (let index = track.series.length - 1; index >= 0; index--) {
    right -= ui.text(amount(track.series[index].values[frame], track.unit), right, rect.y + 10, {size: SIZE.xs - 1, family: 'mono', color: ui.tone(SERIES[index % SERIES.length]), align: 'right'}) + 12;
  }
  ctx.fillStyle = ui.tone('bg', 0.45); ctx.fillRect(plot.x, plot.y, plot.w, plot.h);
  if (track.low < 0 && track.high > 0) ui.hair(plot.x, py(0), plot.r, py(0), ui.tone('muted', 0.35));
  ui.text(amount(track.high, track.unit), plot.x + 3, plot.y + 8, {size: SIZE.xs - 4, family: 'mono', color: ui.tone('muted', 0.8)});
  ui.text(amount(track.low, track.unit), plot.x + 3, plot.b - 7, {size: SIZE.xs - 4, family: 'mono', color: ui.tone('muted', 0.8)});
  // More samples than pixels are thinned; a gap in the data is a gap in the line.
  const stride = Math.max(1, Math.floor(times.length / (plot.w * 1.5)));
  ctx.save(); ctx.beginPath(); ctx.rect(plot.x, plot.y, plot.w, plot.h); ctx.clip();
  track.series.forEach((series, at) => {
    ctx.beginPath();
    let drawing = false;
    for (let index = 0; index < series.values.length; index += stride) {
      const value = series.values[index];
      if (value == null) { drawing = false; continue; }
      if (drawing) ctx.lineTo(px(index), py(value)); else ctx.moveTo(px(index), py(value));
      drawing = true;
    }
    ctx.strokeStyle = ui.tone(SERIES[at % SERIES.length], at ? 0.85 : 1); ctx.lineWidth = at ? 1.4 : 1.9; ctx.stroke();
  });
  ctx.restore();
  const head = plot.x + plot.w * (replay.time - start) / span;
  ctx.fillStyle = ui.tone('fg', 0.9); ctx.fillRect(head - 0.75, plot.y, 1.5, plot.h);
  track.series.forEach((series, at) => { const value = series.values[frame]; if (value != null) { ctx.fillStyle = ui.tone(SERIES[at % SERIES.length]); ctx.beginPath(); ctx.arc(px(frame), py(value), 3, 0, Math.PI * 2); ctx.fill(); } });
  const scrub = x => { replay.scrubbing = true; replay.seek(start + span * clamp((x - plot.x) / plot.w, 0, 1)); };
  ui.region(plot, {id: `track:${track.label}`, onDown: scrub, onDrag: scrub, onUp: () => { replay.scrubbing = false; }});
}
