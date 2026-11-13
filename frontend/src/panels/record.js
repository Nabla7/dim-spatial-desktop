// Episodes for training (data/episodes.js): start one, save it or discard it, and see what it holds.
// The deck is the part an operator needs while working the robot: the state in large, the time, the three
// presses. It comes by itself when the running blueprint has an episode control. The panel says what each
// recorder reads and whether it is arriving, lists the episodes of this session, and, when nothing that
// records is running, the blueprints that do.
import {SIZE} from '../ui/holo.js';
import {Rect} from '../ui/rect.js';
import {hz, words} from '../util.js';
import {openLauncher} from './launcher.js';

const DECK = 'record:deck', PANEL = 'record', DECK_HEIGHT = 0.07;
let dismissed = null;   // the run whose deck the user put away

const clock = seconds => seconds == null ? '––:––' : `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${(seconds % 60).toFixed(1).padStart(4, '0')}`;
const runOf = app => app.blueprint.runId || app.blueprint.name;

// The state in a few words and its tone.
function stateOf(episodes) {
  if (!episodes.status) return episodes.error ? ['NO ANSWER', 'warn'] : ['ASKING…', 'muted'];
  return episodes.recording ? ['RECORDING', 'danger'] : ['READY', 'ok'];
}

// START, SAVE, DISCARD: the one that can be pressed now is lit.
function drawButtons(ui, row, episodes, size = SIZE.sm) {
  const recording = episodes.recording, free = !!episodes.status && !episodes.busy;
  const [start, save, discard] = row.cols([1.15, 1, 1], 8);
  // Each says the key that does the same, for hands that are on the robot's controls.
  ui.button(start, 'START', () => episodes.command('start'), {id: 'episode:start', tone: 'ok', icon: 'record', size, enabled: free && !recording, on: free && !recording, sub: 'key R'});
  ui.button(save, 'SAVE', () => episodes.command('save'), {id: 'episode:save', icon: 'check', size, enabled: free && recording, on: free && recording, sub: 'key R'});
  ui.button(discard, 'DISCARD', () => episodes.command('discard'), {id: 'episode:discard', tone: 'danger', icon: 'close', size, enabled: free && recording, sub: 'Backspace'});
}

// -- the deck ---------------------------------------------------------------------------------------------
function openDeck(app) {
  const episodes = app.episodes;
  const panel = app.panel({
    id: DECK, bare: true, width: 1.14, height: DECK_HEIGHT,
    draw(ui, content) {
      const [label, tone] = stateOf(episodes), status = episodes.status, recording = episodes.recording;
      ui.button(content.cutRight(44, 12), '', () => { dismissed = runOf(app); app.dock.close(DECK); }, {id: 'deck:close', icon: 'close', tone: 'muted'});
      // What is recorded, in one press: how many streams, and whether one of them has gone quiet.
      const streams = episodes.inputs().reduce((count, {inputs}) => count + inputs.length, 0), silent = episodes.silent;
      ui.button(content.cutRight(176, 14), silent ? `${silent} SILENT` : `${streams} STREAM${streams === 1 ? '' : 'S'}`, () => openRecord(app),
        {id: 'deck:streams', size: SIZE.xs, tone: silent ? 'warn' : 'primary', on: app.dock.has(PANEL), sub: silent ? `of ${streams} recorded` : streams ? 'recorded' : 'no recorder'});
      drawButtons(ui, content.cutRight(500, 18), episodes);
      const state = content.cutLeft(recording ? 372 : 190, 18);
      ui.lamp(state.x + 12, state.cy, tone, recording);
      ui.text(label, state.x + 32, state.cy + 1, {size: SIZE.sm, family: 'display', color: ui.tone(tone), track: 2.5});
      if (recording) ui.text(clock(episodes.elapsed()), state.r, state.cy + 1, {size: SIZE.lg, family: 'mono', weight: 500, align: 'right'});
      if (!status) { ui.text(episodes.error || 'Asking the episode control where it stands…', content.x, content.cy, {size: SIZE.xs, family: 'mono', color: ui.tone(episodes.error ? 'warn' : 'muted'), max: content.w}); return; }
      ui.text(status.task || 'no task named', content.x, content.cy - 11, {size: SIZE.sm, weight: 500, color: ui.tone(status.task ? 'fg' : 'muted'), max: content.w});
      ui.text(`${recording ? `episode ${status.saved + status.discarded + 1} · ` : ''}${status.saved} saved · ${status.discarded} discarded`,
        content.x, content.cy + 13, {size: SIZE.xs - 1, family: 'mono', color: ui.tone('muted'), max: content.w});
    },
  });
  panel.minInterval = 50;
  episodes.addEventListener('change', () => panel.invalidate(), {signal: panel.signal});
  app.blueprint.addEventListener('rates', () => panel.invalidate(), {signal: panel.signal});
  app.dock.addEventListener('change', () => panel.invalidate(), {signal: panel.signal});
  // The time of a running episode is drawn ten times a second.
  const timer = setInterval(() => { if (episodes.recording) panel.invalidate(); }, 100);
  episodes.watch(true);
  panel.onDispose = () => { clearInterval(timer); episodes.watch(false); };
  return app.dock.open(panel, 'deck');
}

// The deck comes with a blueprint that has an episode control and goes with it. R and Backspace are the
// presses for hands that are on the robot's controls: they act only while the deck is there.
export function watchRecord(app) {
  const episodes = app.episodes;
  episodes.addEventListener('change', () => {
    if (!episodes.available) { if (app.dock.has(DECK)) app.dock.close(DECK); return; }
    if (!app.dock.has(DECK) && dismissed !== runOf(app)) openDeck(app);
  });
  app.blueprint.addEventListener('change', () => { if (!app.blueprint.running) dismissed = null; });
  addEventListener('keydown', event => {
    if (event.repeat || event.metaKey || event.ctrlKey || event.altKey || app.text.active || !app.dock.has(DECK) || !episodes.status) return;
    if (event.code === 'KeyR') { event.preventDefault(); episodes.command(episodes.recording ? 'save' : 'start'); }
    else if (event.code === 'Backspace' && episodes.recording) { event.preventDefault(); episodes.command('discard'); }
  });
}

// -- the panel --------------------------------------------------------------------------------------------
export function openRecord(app) {
  if (app.dock.has(PANEL)) { app.dock.close(PANEL); return; }
  const episodes = app.episodes, blueprint = app.blueprint;
  // RECORD in the bar also brings back a deck that was put away.
  if (episodes.available && !app.dock.has(DECK)) { dismissed = null; openDeck(app); }
  blueprint.loadCatalog();

  // Nothing that records is running: say so, and list what would.
  function drawIdle(ui, content) {
    const note = content.cutTop(96, 10);
    ui.text(blueprint.running ? 'This blueprint records no episodes.' : 'No blueprint is running.', note.x, note.y + 14, {size: SIZE.md, weight: 500, max: note.w});
    ui.wrap('A blueprint records episodes when one of its modules is an episode control: it answers get_status() and command(event) with an episode status.',
      new Rect(note.x, note.y + 34, note.w, 60), {size: SIZE.xs, color: ui.tone('muted'), lineHeight: 1.45, maxLines: 3});
    const able = (blueprint.catalog || []).filter(entry => (entry.abilities || []).includes('data-collection'));
    ui.heading(content.cutTop(26, 6), 'Blueprints that record', blueprint.catalog ? `${able.length}` : '');
    if (!blueprint.catalog) { ui.empty(content, 'Reading the catalog…'); return; }
    if (!able.length) { ui.empty(content, 'None in this dimos checkout.'); return; }
    ui.scroll(content, 'able', inner => {
      let y = inner.y;
      for (const entry of able) {
        const row = new Rect(inner.x, y, inner.w, 54);
        ui.row(row, {id: `able:${entry.name}`, onClick: () => openLauncher(app, {choose: entry.name})});
        ui.text(entry.title || entry.name, row.x + 12, row.y + 18, {size: SIZE.md, weight: 500, color: ui.tone(entry.importable === false ? 'muted' : 'fg'), max: row.w - 110});
        ui.text(entry.name, row.x + 12, row.y + 40, {size: SIZE.xs, family: 'mono', color: ui.tone('muted'), max: row.w - 110});
        if (entry.robot) ui.badge(row.r - 8, row.y + 18, entry.robot, {tone: 'info', align: 'right'});
        y += 54; ui.hair(inner.x, y, inner.r, y);
      }
      return y - inner.y;
    });
  }

  function drawEpisodes(ui, content) {
    const [label, tone] = stateOf(episodes), status = episodes.status, recording = episodes.recording;
    const head = content.cutTop(62, 8);
    ui.lamp(head.x + 10, head.y + 20, tone, recording);
    ui.text(label, head.x + 28, head.y + 21, {size: SIZE.md, family: 'display', color: ui.tone(tone), track: 2.5});
    if (recording) ui.text(clock(episodes.elapsed()), head.r, head.y + 20, {size: SIZE.lg, family: 'mono', weight: 500, align: 'right'});
    ui.text(status ? status.task || 'no task named' : episodes.error || 'Asking the episode control where it stands…', head.x + 28, head.y + 48,
      {size: SIZE.xs, family: status ? 'sans' : 'mono', color: ui.tone(!status && episodes.error ? 'warn' : 'muted'), max: head.w - 30});
    drawButtons(ui, content.cutTop(60, 12), episodes);
    const recorders = episodes.inputs(), rates = blueprint.ratesUp;
    ui.scroll(content, 'episodes', inner => {
      let y = inner.y;
      const streams = recorders.reduce((count, {inputs}) => count + inputs.length, 0);
      ui.heading(new Rect(inner.x, y + 4, inner.w, 26), 'What an episode holds', streams ? `${streams} stream${streams === 1 ? '' : 's'}` : ''); y += 38;
      if (!recorders.length) y += ui.wrap('No module of this blueprint reads the episode control\'s events, so they mark nothing that is recorded here.', new Rect(inner.x, y, inner.w, 0), {size: SIZE.xs, color: ui.tone('warn'), lineHeight: 1.45, maxLines: 3}) + 10;
      for (const {module, inputs} of recorders) {
        ui.text(`${words(module.name)}${module.alias ? ` · ${module.alias}` : ''}`, inner.x, y + 10, {size: SIZE.xs, family: 'mono', color: ui.tone('muted'), max: inner.w}); y += 26;
        // What this launch told the recorder (the folder it writes, when the launch named one).
        for (const [field, value] of Object.entries(blueprint.launch?.config?.modules?.[module.id.split(':').pop()] || {})) {
          y += ui.wrap(`${field}: ${value}`, new Rect(inner.x + 4, y, inner.w - 8, 0), {size: SIZE.xs - 1, family: 'mono', color: ui.tone('fg', 0.85), lineHeight: 1.35, maxLines: 3}) + 6;
        }
        for (const input of inputs) {
          const row = new Rect(inner.x, y, inner.w, 46);
          ui.text(input.name, row.x + 4, row.y + 14, {size: SIZE.sm, weight: 500, max: row.w - 150});
          ui.text(`${input.type || 'a Python value'}${input.writers.length ? ` · from ${input.writers.map(words).join(', ')}` : ' · nothing writes it'}`, row.x + 4, row.y + 34, {size: SIZE.xs - 2, family: 'mono', color: ui.tone(input.writers.length ? 'muted' : 'warn'), max: row.w - 150});
          // A stream with nothing arriving is a hole in every episode: say it where it is seen before START.
          ui.text(!rates ? '—' : input.silent ? 'NOTHING ARRIVING' : hz(input.hz), row.r - 4, row.cy, {size: SIZE.xs, family: 'mono', align: 'right', color: ui.tone(!rates ? 'muted' : input.silent ? 'warn' : 'ok')});
          y += 46; ui.hair(inner.x, y, inner.r, y);
        }
        y += 8;
      }
      ui.heading(new Rect(inner.x, y + 4, inner.w, 26), 'This session', status ? `${status.saved} saved · ${status.discarded} discarded` : ''); y += 38;
      if (!episodes.log.length) { ui.text('Episodes that end while this page is open are listed here.', inner.x, y + 10, {size: SIZE.xs, color: ui.tone('muted'), max: inner.w}); y += 30; }
      for (const entry of episodes.log) {
        ui.text(`#${entry.number}`, inner.x + 4, y + 14, {size: SIZE.sm, family: 'mono', color: ui.tone('muted')});
        ui.text(entry.result, inner.x + 70, y + 14, {size: SIZE.sm, weight: 500, color: ui.tone(entry.result === 'saved' ? 'ok' : 'warn')});
        ui.text(entry.seconds == null ? '' : `${entry.seconds.toFixed(1)} s`, inner.r - 4, y + 14, {size: SIZE.sm, family: 'mono', align: 'right'});
        y += 30; ui.hair(inner.x, y, inner.r, y);
      }
      return y - inner.y + 6;
    });
  }

  const panel = app.panel({
    id: PANEL, title: 'Record', glyph: 'record', width: 0.42, height: app.dock.sideHeight(), onClose: () => app.dock.close(PANEL),
    draw(ui, content) {
      panel.tag = episodes.available ? stateOf(episodes)[0] : '';
      if (episodes.available) drawEpisodes(ui, content); else drawIdle(ui, content);
    },
  });
  episodes.addEventListener('change', () => panel.invalidate(), {signal: panel.signal});
  for (const type of ['change', 'catalog', 'rates']) blueprint.addEventListener(type, () => panel.invalidate(), {signal: panel.signal});
  const timer = setInterval(() => { if (episodes.recording) panel.invalidate(); }, 100);
  episodes.watch(true);
  panel.onDispose = () => { clearInterval(timer); episodes.watch(false); };
  return app.dock.open(panel, 'left');
}
