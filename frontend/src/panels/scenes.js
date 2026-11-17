// Scenes: a USD scene on the table in place of the live blueprint. Three panels:
//   Scenes   the scenes on this machine; the open one's checks, pins, revisions and facts
//   the deck how the scene is looked at (on the table or from inside), what is drawn over it, and what
//            the last press on it found (above the command bar)
//   Views    the cameras of the recording the scene was made from, to stand where one stood and lay its
//            picture over the scene
// The scene itself is drawn by scene/scenes.js. Everything shown comes from the scene as the server
// describes it (data/scenes.js): no panel here knows a file format or a particular scene.
import {SIZE} from '../ui/holo.js';
import {Rect} from '../ui/rect.js';
import {gateway} from '../data/gateway.js';
import {BODIES, bodyText, shortShape} from '../data/scenes.js';
import {openAgent} from './agent.js';
import {openLauncher} from './launcher.js';

const DECK_HEIGHT = 0.108;
const STATE = {pass: 'ok', fail: 'danger', not_run: 'muted'};
const REVISION = {original: ['FIRST', 'muted'], proposed: ['PROPOSED', 'warn'], kept: ['KEPT', 'ok'], rejected: ['REJECTED', 'danger']};
const LAYERS = [['seen', 'SEEN'], ['solid', 'SOLID'], ['floor', 'FLOOR'], ['marks', 'MARKS'], ['places', 'PLACES'], ['views', 'VIEWS'], ['pins', 'PINS']];

const metres = point => point.map(value => value.toFixed(2)).join(', ');
const megabytes = bytes => `${(bytes / 1e6).toFixed(bytes > 1e8 ? 0 : 1)} MB`;
const when = at => new Date(at).toLocaleString([], {hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short'});

export function endScene(app) { app.scenes.close(); }

// An open scene brings its deck with it, and the recorded views when it has some.
export function watchScenes(app) {
  app.scenes.addEventListener('open', () => {
    if (!app.dock.has('scenes:deck')) openDeck(app);
    if (app.scenes.open.evidence?.views.length && !app.dock.has('scenes:views')) openViews(app);
  });
  app.scenes.addEventListener('close', () => { for (const id of ['scenes:deck', 'scenes:views']) if (app.dock.has(id)) app.dock.close(id); });
  // Another panel may have taken the views' column: a press on a camera in the scene brings them back.
  app.sceneView.addEventListener('shown', () => { if (app.scenes.shown != null && !app.dock.has('scenes:views')) openViews(app); });
}

// Hand the scene to a coding agent: what it is, what was marked, and what the user asks.
function ask(app, text) { openAgent(app, {draft: `${app.scenes.brief()}${text}`}); }

// -- the library and the open scene ------------------------------------------------------------------------
export function openScenes(app, restore = null) {
  const id = 'scenes', scenes = app.scenes;
  if (app.dock.has(id)) { if (!restore) app.dock.close(id); return; }
  const state = {tab: 'scenes', path: '', adding: false, note: '', ask: '', editing: null};

  async function add() {
    if (!state.path.trim() || state.adding) return;
    state.adding = true; state.note = ''; panel.invalidate();
    try { await scenes.add(state.path); state.path = ''; if (app.text.active) app.text.blur(); }
    catch (error) { state.note = error.message; }
    state.adding = false; panel.invalidate();
  }

  // How the open scene's shapes are coming along, as one line and a meter.
  function drawProgress(ui, area) {
    const view = scenes.view;
    if (view.state === 'ready' || view.state === 'none') return;
    const line = area.cutTop(view.state === 'failed' ? 48 : 34, 8);
    if (view.state === 'failed') { ui.wrap(`The scene could not be shown: ${view.note}`, line, {size: SIZE.xs, color: ui.tone('danger'), maxLines: 3}); return; }
    ui.text(view.state === 'making' ? `Making what a browser draws: ${view.note}` : `Loading the shapes: ${megabytes(view.report?.seen.bytes || 0)}`, line.x, line.y + 9, {size: SIZE.xs, color: ui.tone('muted'), max: line.w});
    ui.meter(new Rect(line.x, line.y + 22, line.w, 8), view.share, {segments: 48});
  }

  function drawScenes(ui, area) {
    if (scenes.list === null) { ui.empty(area, 'Looking for scenes…'); return; }
    if (scenes.runtime?.error) area.cutTop(ui.wrap(scenes.runtime.error, new Rect(area.x, area.y, area.w, 0), {size: SIZE.xs, color: ui.tone('warn'), lineHeight: 1.4}) + 10, 0);
    drawProgress(ui, area);
    const head = area.cutTop(26, 8);
    ui.heading(new Rect(head.x, head.y, head.w - 56, head.h), 'Scenes on this machine', `${scenes.list.length}`);
    ui.button(new Rect(head.r - 44, head.y - 6, 44, 34), '', () => scenes.refresh(true), {id: 'rescan', icon: 'refresh', tone: 'muted', enabled: !scenes.busy});
    const adder = area.cutBottom(state.note ? 118 : 86, 8);
    ui.text('A scene.json, a USD file, a MuJoCo scene, or a folder that holds one:', adder.x, adder.y + 12, {size: SIZE.xs, color: ui.tone('muted'), max: adder.w});
    const row = new Rect(adder.x, adder.y + 28, adder.w, 44), button = row.cutRight(96, 8);
    ui.field(row, state.path, {id: 'path', placeholder: '/full/path/to/a/scene', family: 'mono', onInput: value => { state.path = value; }, onSubmit: add});
    ui.button(button, state.adding ? '…' : 'ADD', add, {id: 'path:add', size: SIZE.sm, enabled: !!state.path.trim() && !state.adding});
    if (state.note) ui.wrap(state.note, new Rect(adder.x, adder.y + 80, adder.w, 0), {size: SIZE.xs, color: ui.tone('warn'), maxLines: 2});
    // The open scene, with the robot of a blueprint that simulates standing at its first place.
    if (scenes.id) ui.button(area.cutBottom(44, 8), 'RUN A ROBOT HERE', () => openLauncher(app, {scene: scenes.id}), {id: 'run-here', icon: 'rocket', size: SIZE.sm});
    if (!scenes.list.length) { ui.empty(area, 'No scene was found under Desktop\'s app data.', 'Add one by its path.'); return; }
    ui.scroll(area, 'scenes', inner => {
      let y = inner.y;
      for (const scene of scenes.list) {
        const cell = new Rect(inner.x, y, inner.w, 58), open = scene.id === scenes.id;
        ui.row(cell, {id: `scene:${scene.id}`, selected: open, onClick: () => { if (!open) scenes.openScene(scene.id); }});
        ui.lamp(cell.x + 16, cell.y + 21, open ? 'ok' : 'muted', scenes.loading === scene.id);
        const badge = ui.badge(cell.r - 8, cell.y + 21, scene.manifest ? 'MANIFEST' : 'USD ONLY', {tone: scene.manifest ? 'primary' : 'muted', align: 'right', size: SIZE.xs - 3});
        ui.text(scene.name, cell.x + 32, cell.y + 21, {size: SIZE.sm, weight: 500, max: cell.w - badge - 52});
        ui.text(scene.usd, cell.x + 32, cell.y + 42, {size: SIZE.xs - 2, family: 'mono', color: ui.tone('muted'), max: cell.w - 44});
        y += 58; ui.hair(inner.x, y, inner.r, y);
      }
      return y - inner.y;
    });
  }

  // A check: a lamp, what was asked, and what was found.
  function drawCheck(ui, inner, y, check) {
    ui.lamp(inner.x + 10, y + 13, STATE[check.state] || 'muted');
    ui.text(check.id, inner.x + 28, y + 13, {size: SIZE.sm, weight: 500, max: inner.w - 30});
    return y + 28 + ui.wrap(check.text, new Rect(inner.x + 28, y + 26, inner.w - 30, 0), {size: SIZE.xs, color: ui.tone('muted'), lineHeight: 1.4}) + 10;
  }

  function drawChecks(ui, area) {
    if (!scenes.active) { ui.empty(area, 'Open a scene to check it.'); return; }
    const check = scenes.check, report = check.report, running = check.job?.state === 'running';
    // The body the scene is tried with: the one its manifest names, or one of two usual shapes.
    const named = `${scenes.open.body.radius},${scenes.open.body.height},${scenes.open.body.step}`;
    const bodies = [[named, 'AS NAMED'], ...BODIES.filter(([value]) => value !== named)];
    ui.chips(area.cutTop(34, 6), bodies, check.body, body => scenes.setBody(body), {id: 'body', size: SIZE.xs});
    const [radius, height, step] = check.body.split(',').map(Number);
    ui.text(`A body ${bodyText({radius, height, step})}`, area.x, area.cutTop(20, 8).cy, {size: SIZE.xs - 1, family: 'mono', color: ui.tone('muted'), max: area.w});
    const top = area.cutTop(44, 8);
    const label = running ? `${(check.job.note || 'CHECKING').toUpperCase()}${check.job.done ? ` · ${check.job.done.toLocaleString()} cells` : ''} · ${Math.round((Date.now() - check.job.startedAt) / 1000)} s` : report ? 'CHECK THE SCENE AGAIN' : 'CHECK THE SCENE';
    ui.button(top, label, () => scenes.runCheck(), {id: 'check', size: SIZE.xs, enabled: !running, icon: running ? null : 'check'});
    if (running) panel.invalidate();
    if (check.job?.state === 'failed') area.cutTop(ui.wrap(`The check did not finish: ${check.job.error}`, new Rect(area.x, area.y, area.w, 0), {size: SIZE.xs, color: ui.tone('warn'), maxLines: 3}) + 8, 0);
    if (!report) { if (!running) ui.empty(area, 'Asks the scene a fixed list of questions,', 'the last of them with sim2\'s own loader. About a minute.'); return; }
    const failing = report.checks.filter(entry => entry.state === 'fail');
    const fix = area.cutBottom(40, 8);
    ui.button(fix, failing.length ? 'ASK AN AGENT TO MAKE IT PASS' : 'ASK AN AGENT ABOUT THIS SCENE', () => ask(app, failing.length
      ? `The check reports these failures. Make a revision that passes them, or tell me why one of them should not:\n${failing.map(entry => `  ${entry.id}: ${entry.text}`).join('\n')}\n`
      : ''), {id: 'fix', icon: 'agent', size: SIZE.xs, tone: 'agent'});
    ui.scroll(area, `checks:${scenes.id}:${scenes.revision}:${check.body}`, inner => {
      let y = inner.y;
      const verdict = report.level ? `The scene is ${report.level}.` : 'The scene is at no level yet.';
      ui.lamp(inner.x + 10, y + 12, report.level === report.asked ? 'ok' : report.level ? 'warn' : 'danger');
      ui.text(verdict, inner.x + 28, y + 13, {size: SIZE.sm, weight: 500, max: inner.w - 30});
      ui.text(`${report.holds} · checked ${report.at ? when(report.at * 1000) : ''}`, inner.x + 28, y + 34, {size: SIZE.xs - 2, family: 'mono', color: ui.tone('muted'), max: inner.w - 30});
      y += 54;
      for (const level of ['viewable', 'navigable']) {
        const mine = report.checks.filter(entry => entry.level === level);
        if (!mine.length) continue;
        ui.heading(new Rect(inner.x, y + 4, inner.w, 24), level, `${mine.filter(entry => entry.state === 'pass').length} of ${mine.length}`); y += 40;
        for (const entry of mine) y = drawCheck(ui, inner, y, entry);
      }
      // Where what is seen and what is solid disagree most: press one to go and look.
      const solid = scenes.result('seen is solid')?.data;
      for (const [title, list, tone] of [['A body stops at these and nothing shows', solid?.unseen_by, 'danger'], ['These show and a body passes through', solid?.hollow_at, 'warn']]) {
        if (!list?.length) continue;
        ui.heading(new Rect(inner.x, y + 4, inner.w, 24), title); y += 38;
        for (const entry of list) {
          const row = new Rect(inner.x, y, inner.w, 34);
          ui.row(row, {id: `where:${entry.shape}`, onClick: () => { app.sceneView.goTo(entry.near); scenes.select(entry.near); }});
          ui.lamp(row.x + 10, row.cy, tone);
          ui.text(shortShape(entry.shape), row.x + 28, row.cy + 1, {size: SIZE.xs, family: 'mono', max: row.w - 150});
          ui.text(`${entry.rays} rays · ${metres(entry.near)}`, row.r - 6, row.cy + 1, {size: SIZE.xs - 2, family: 'mono', color: ui.tone('muted'), align: 'right'});
          y += 36;
        }
      }
      return y - inner.y + 6;
    });
  }

  function drawPins(ui, area) {
    if (!scenes.active) { ui.empty(area, 'Open a scene to mark points in it.'); return; }
    const open = scenes.pins.filter(pin => pin.state === 'open');
    // What the agent is asked, with the open pins.
    const box = area.cutBottom(128, 10);
    ui.field(new Rect(box.x, box.y, box.w, 76), state.ask, {id: 'ask', placeholder: open.length ? 'What should be done about the marked points?' : 'What should change in this scene?', multiline: true, onInput: value => { state.ask = value; }});
    ui.button(new Rect(box.x, box.y + 84, box.w, 40), open.length ? `ASK AN AGENT · ${open.length} PIN${open.length > 1 ? 'S' : ''}` : 'ASK AN AGENT', () => { ask(app, state.ask); state.ask = ''; }, {id: 'ask:send', icon: 'agent', size: SIZE.xs, tone: 'agent'});
    if (!scenes.pins.length) { ui.empty(area, 'Press a point of the scene, then PIN.', 'A pin keeps the point, a note and a picture of what you saw.'); return; }
    ui.scroll(area, `pins:${scenes.id}`, inner => {
      let y = inner.y;
      for (const pin of scenes.pins) {
        const focus = scenes.pinFocus === pin.n, done = pin.state !== 'open';
        const facts = [`${metres(pin.position)}`, pin.seen ? shortShape(pin.seen) : null, pin.gap != null && Math.abs(pin.gap) > 0.02 ? `solid ${Math.abs(pin.gap).toFixed(2)} m ${pin.gap > 0 ? 'behind' : 'in front'}` : null, `revision ${pin.revision}`, pin.snapshot ? 'with a picture' : null].filter(Boolean).join(' · ');
        const noteHeight = focus ? 64 : Math.max(20, ui.wrap(pin.note || 'no note yet', new Rect(inner.x + 44, 0, inner.w - 50, 0), {size: SIZE.xs, lineHeight: 1.4, measure: true}));
        const height = 30 + noteHeight + (focus ? 52 : 8), cell = new Rect(inner.x, y, inner.w, height);
        ui.row(cell, {id: `pin:${pin.n}`, selected: focus, onClick: () => { scenes.pinFocus = focus ? null : pin.n; scenes.select(pin.position); app.sceneView.goTo(pin.position); scenes.emit('pins'); }});
        ui.text(`#${pin.n}`, cell.x + 12, y + 15, {size: SIZE.sm, weight: 600, family: 'mono', color: ui.tone(done ? 'muted' : 'agent')});
        ui.text(facts, cell.x + 44, y + 15, {size: SIZE.xs - 2, family: 'mono', color: ui.tone('muted'), max: cell.w - 50});
        if (focus) {
          ui.field(new Rect(cell.x + 44, y + 28, cell.w - 50, 60), pin.note, {id: `note:${pin.n}`, placeholder: 'What is wrong here? What should it be?', multiline: true, onInput: value => { pin.note = value; state.editing = pin.n; }, onSubmit: () => scenes.editPin(pin.n, {note: pin.note})});
          const keys = new Rect(cell.x + 44, y + 96, cell.w - 50, 34).cols(3, 6);
          ui.button(keys[0], 'SAVE NOTE', () => { state.editing = null; scenes.editPin(pin.n, {note: pin.note}); }, {id: `save:${pin.n}`, size: SIZE.xs - 2, on: state.editing === pin.n});
          ui.button(keys[1], done ? 'REOPEN' : 'RESOLVED', () => scenes.editPin(pin.n, {state: done ? 'open' : 'resolved'}), {id: `done:${pin.n}`, size: SIZE.xs - 2, tone: done ? 'primary' : 'ok'});
          ui.button(keys[2], 'REMOVE', () => scenes.removePin(pin.n), {id: `remove:${pin.n}`, size: SIZE.xs - 2, tone: 'muted'});
        } else ui.wrap(pin.note || 'no note yet', new Rect(cell.x + 44, y + 28, cell.w - 50, 0), {size: SIZE.xs, color: ui.tone(pin.note ? (done ? 'muted' : 'fg') : 'muted'), lineHeight: 1.4});
        y += height; ui.hair(inner.x, y, inner.r, y); y += 2;
      }
      return y - inner.y;
    });
  }

  function drawRevisions(ui, area) {
    if (!scenes.active) { ui.empty(area, 'Open a scene to see its revisions.'); return; }
    const revisions = scenes.open.revisions, current = scenes.current;
    // The revision on the table: keep it or send it back, and see what it changed.
    if (current && current.n > 0) {
      const keys = area.cutTop(40, 8).cols(3, 6), before = [...revisions].reverse().find(revision => revision.n < current.n && revision.state !== 'rejected');
      ui.button(keys[0], 'KEEP', () => scenes.mark(current.n, 'kept'), {id: 'keep', size: SIZE.xs, tone: 'ok', on: current.state === 'kept', icon: 'check'});
      ui.button(keys[1], 'REJECT', () => scenes.mark(current.n, 'rejected'), {id: 'reject', size: SIZE.xs, tone: 'danger', enabled: current.state !== 'rejected'});
      ui.button(keys[2], scenes.against != null ? 'HIDE CHANGES' : 'WHAT CHANGED', () => scenes.against != null ? scenes.show(scenes.revision) : scenes.compare(before.n), {id: 'compare', size: SIZE.xs, on: scenes.against != null, enabled: !!before && !scenes.comparing});
    }
    if (scenes.against != null) {
      const diff = scenes.diff, other = revisions.find(revision => revision.n === scenes.against);
      const flip = area.cutTop(40, 6);
      ui.button(flip, `SHOW THE OTHER ONE: REVISION ${scenes.against}${other ? ` (${other.label})` : ''}`, () => scenes.flip(), {id: 'flip', size: SIZE.xs - 1, tone: 'alt', enabled: !scenes.loading});
      const part = (label, side) => side ? `${label}: ${side.added_m2 || side.removed_m2 ? `${side.added_m2} m² came, ${side.removed_m2} m² went` : 'the same'}` : '';
      const text = scenes.comparing ? 'Comparing the two revisions…' : diff ? (diff.same ? 'The two revisions hold the same shapes in the same places.' : `Revision ${diff.b} against revision ${diff.a}. ${part('What is seen', diff.seen)}. ${part('What is solid', diff.solid)}. Green boxes are around what came with revision ${diff.b}, red around what went.`) : '';
      area.cutTop(ui.wrap(text, new Rect(area.x, area.y, area.w, 0), {size: SIZE.xs, color: ui.tone('muted'), lineHeight: 1.4}) + 10, 0);
    }
    const foot = area.cutBottom(64, 8);
    ui.wrap(`An agent announces a revision by writing {"usd": "…", "label": "…"} as a .json file into ${scenes.open.agent.inbox}`, foot, {size: SIZE.xs - 2, family: 'mono', color: ui.tone('muted', 0.8), lineHeight: 1.35, maxLines: 4});
    ui.scroll(area, `revisions:${scenes.id}`, inner => {
      let y = inner.y;
      for (const revision of [...revisions].reverse()) {
        const cell = new Rect(inner.x, y, inner.w, 58), shown = revision.n === scenes.revision, [tag, tone] = REVISION[revision.state] || REVISION.proposed;
        ui.row(cell, {id: `revision:${revision.n}`, selected: shown, onClick: () => { if (!shown) scenes.show(revision.n); }});
        ui.lamp(cell.x + 16, cell.y + 21, shown ? 'ok' : 'muted', scenes.loading && shown);
        const badge = ui.badge(cell.r - 8, cell.y + 21, tag, {tone, align: 'right', size: SIZE.xs - 3});
        ui.text(`${revision.n}  ${revision.label}`, cell.x + 32, cell.y + 21, {size: SIZE.sm, weight: 500, max: cell.w - badge - 52});
        ui.text(`${when(revision.at)} · ${revision.usd}`, cell.x + 32, cell.y + 42, {size: SIZE.xs - 2, family: 'mono', color: ui.tone('muted'), max: cell.w - 44});
        y += 58; ui.hair(inner.x, y, inner.r, y);
      }
      return y - inner.y;
    });
  }

  function drawFacts(ui, area) {
    if (!scenes.active) { ui.empty(area, 'Open a scene to see what it is.'); return; }
    const open = scenes.open, usd = open.usd, manifest = open.manifest, view = scenes.view.report;
    const groups = [
      ['The scene', [['name', open.scene.name], ['USD', usd.usd], ['manifest', open.scene.manifest || 'none: the scene says nothing about itself'], ['its author works in', open.scene.project]]],
      ['What it holds', [['shapes', usd.holds], ['frame', `${usd.frame.metres_per_unit === 1 ? 'metres' : `${usd.frame.metres_per_unit} m a unit`}, ${usd.frame.up} up, starts at ${usd.frame.root}`],
        ['files', `${usd.layers} USD layers, ${megabytes(usd.bytes)}`], ['robots in the file', usd.robots.length ? usd.robots.join(', ') : 'none'], ['lights', usd.lights], ['cameras', usd.cameras.map(camera => camera.name).join(', ') || 'none']]],
    ];
    if (manifest) groups.push(['What it was made from', [['source', manifest.source ? `${manifest.source.file}  (${String(manifest.source.sha256 || '').slice(0, 12)})` : 'not stated'],
      ...Object.entries(manifest.forms || {}).map(([name, form]) => [`form: ${name}`, [form.file || form.project, form.level, form.source_sha256 ? `made from ${form.source_sha256.slice(0, 12)}` : null].filter(Boolean).join(' · ')]),
      ['places', (manifest.places || []).map(place => place.name).join(', ') || 'none'], ['recorded views', open.evidence ? `${open.evidence.views.length}` : 'none'], ...(manifest.note ? [['note', manifest.note]] : [])]]);
    if (view) groups.push(['What this page draws', [['seen', `${view.seen.shapes} shapes, ${view.seen.triangles.toLocaleString()} triangles, ${view.seen.materials} materials, ${view.seen.images} images, ${megabytes(view.seen.bytes)}`],
      ['solid', `${view.solid.shapes} shapes, ${view.solid.triangles.toLocaleString()} triangles`], ['left out', view.robots_left_out.length ? `the robots in the file: ${view.robots_left_out.join(', ')}` : 'nothing'],
      ...(view.limits.length ? [['not as in the scene', view.limits.join('; ')]] : []), ['read with', open.runtime]]]);
    ui.scroll(area, `facts:${scenes.id}:${scenes.revision}`, inner => {
      let y = inner.y;
      for (const [title, rows] of groups) {
        ui.heading(new Rect(inner.x, y + 8, inner.w, 24), title); y += 42;
        for (const [key, value] of rows) {
          ui.text(key, inner.x, y + 10, {size: SIZE.xs, color: ui.tone('muted'), max: 150});
          y += Math.max(24, ui.wrap(String(value), new Rect(inner.x + 160, y, inner.w - 160, 0), {size: SIZE.xs, family: 'mono', lineHeight: 1.4}) + 4);
        }
      }
      return y - inner.y + 8;
    });
  }

  const tabs = {scenes: drawScenes, checks: drawChecks, pins: drawPins, revisions: drawRevisions, facts: drawFacts};
  const panel = app.panel({
    id, title: 'Scenes', glyph: 'scene', width: 0.42, height: app.dock.sideHeight() - (app.dock.has('scenes:deck') ? 0 : DECK_HEIGHT + 0.016), onClose: () => app.dock.close(id),
    draw(ui, content) {
      panel.tag = scenes.active ? `${scenes.open.scene.name} · ${scenes.revision}` : '';
      panel.busy = scenes.busy || !!scenes.loading || ['making', 'loading'].includes(scenes.view.state);
      const open = scenes.pins.filter(pin => pin.state === 'open').length, proposed = scenes.open?.revisions.filter(revision => revision.state === 'proposed').length;
      ui.chips(content.cutTop(38, 10), [['scenes', 'SCENES'], ['checks', 'CHECKS'], ['pins', open ? `PINS ${open}` : 'PINS'], ['revisions', proposed ? `REVISIONS ${proposed}` : 'REVISIONS'], ['facts', 'FACTS']], state.tab, tab => { state.tab = tab; }, {id: 'tab', size: SIZE.xs - 1});
      if (scenes.error) content.cutTop(ui.wrap(scenes.error, new Rect(content.x, content.y, content.w, 0), {size: SIZE.xs, color: ui.tone('danger'), maxLines: 3}) + 8, 0);
      if (state.tab !== 'scenes') drawProgress(ui, content);
      tabs[state.tab](ui, content);
    },
  });
  scenes.addEventListener('change', () => panel.invalidate(), {signal: panel.signal});
  // A new pin wants its note, and a new revision wants a look.
  scenes.addEventListener('pins', () => { if (scenes.pinFocus != null) state.tab = 'pins'; panel.invalidate(); }, {signal: panel.signal});
  scenes.addEventListener('diff', () => { if (scenes.against != null) state.tab = 'revisions'; panel.invalidate(); }, {signal: panel.signal});
  app.dock.open(panel, 'left');
  // What was open before a reload comes back; otherwise the one that was open last.
  scenes.refresh().then(() => {
    const wanted = restore?.id ?? (scenes.active ? null : scenes.remembered().id);
    if (wanted && scenes.list?.some(scene => scene.id === wanted) && scenes.id !== wanted) scenes.openScene(wanted, restore?.revision ?? null);
  });
  return panel;
}

// -- the deck: how the scene is looked at ------------------------------------------------------------------
function openDeck(app) {
  const id = 'scenes:deck', scenes = app.scenes, view = app.sceneView, stage = app.stage;
  const panel = app.panel({
    id, bare: true, width: 1.14, height: DECK_HEIGHT,
    draw(ui, content) {
      if (!scenes.active) { ui.text('No scene is open.', content.cx, content.cy, {size: SIZE.sm, color: ui.tone('muted'), align: 'center'}); return; }
      const top = content.cutTop(44, 8), walking = view.walk.on, ready = scenes.view.state === 'ready';
      ui.chips(top.cutLeft(170, 14), [[false, 'TABLE'], [true, 'WALK']], walking, on => on ? view.enter(scenes.selected?.point ?? null) : view.leave(), {id: 'mode', size: SIZE.xs});
      ui.button(top.cutRight(44, 12), '', () => endScene(app), {id: 'end', icon: 'close', tone: 'muted'});
      ui.button(top.cutRight(64, 12), 'PIN', () => { if (scenes.selected) scenes.addPin(); else { scenes.pinMode = !scenes.pinMode; scenes.emit(); } }, {id: 'pin', icon: 'pin', size: SIZE.xs - 2, tone: 'agent', on: scenes.pinMode, enabled: ready});
      // What is drawn: the shapes that are seen, the shapes that are solid, and what the check found.
      const shown = top.cutRight(LAYERS.length * 72 + (LAYERS.length - 1) * 4, 14).cols(LAYERS.length, 4), has = {
        seen: true, solid: !!scenes.view.report?.solid.triangles, floor: !!scenes.floor, marks: !!scenes.result('seen is solid')?.data.marks?.length,
        places: !!scenes.open.manifest?.places?.length, views: !!scenes.open.evidence?.views.length, pins: !!scenes.pins.length,
      };
      LAYERS.forEach(([name, label], at) => ui.button(shown[at], label, () => { scenes.setLayer(name, !scenes.layers[name]); if (name === 'views' && scenes.layers.views && !app.dock.has('scenes:views')) openViews(app); }, {id: `layer:${name}`, size: SIZE.xs - 3, on: has[name] && scenes.layers[name], enabled: has[name], tone: 'alt'}));
      if (!walking) {
        // On the table: which storey's floor lies on it, and how far above it the scene is cut open.
        ui.button(top.cutLeft(54, 12), 'FIT', () => view.fit(), {id: 'fit', size: SIZE.xs - 2});
        const storeys = scenes.result('walkable')?.data.storeys || [];
        if (storeys.length > 1) {
          const cells = top.cutLeft(storeys.length * 64 + (storeys.length - 1) * 4, 12).cols(storeys.length, 4);
          storeys.forEach((storey, at) => ui.button(cells[at], `${storey.height.toFixed(1)} m`, () => view.setFloor(storey.height), {id: `storey:${at}`, size: SIZE.xs - 2, on: Math.abs(stage.target.center.z + 0.04 - storey.height) < 0.3}));
        } else {
          const cells = top.cutLeft(92, 12).cols(2, 4);
          ui.button(cells[0], '', () => { stage.target.center.z -= 0.5; }, {id: 'floor:down', icon: 'down'});
          ui.button(cells[1], '', () => { stage.target.center.z += 0.5; }, {id: 'floor:up', icon: 'up'});
        }
        ui.text('CUT', top.x, top.cy + 1, {size: SIZE.xs - 2, family: 'display', color: ui.tone('muted'), track: 1.5});
        ui.slider(new Rect(top.x + 38, top.y, top.w - 38, top.h), Math.min(stage.ceiling, 12), 0.5, 12, value => { stage.ceiling = value >= 11.9 ? Infinity : value; },
          {id: 'cut', step: 0.1, format: value => (value >= 11.9 ? 'off' : `${value.toFixed(1)} m above the floor`)});
      } else {
        ui.text(app.xr.presenting ? 'The left stick moves you, the right stick turns you.' : 'W A S D move · Q E down and up · Shift faster · drag to look · H hides the panels · Esc leaves', top.x, top.cy + 1, {size: SIZE.xs - 1, family: 'mono', color: ui.tone('muted'), max: top.w});
      }
      // What the last press found.
      const selected = scenes.selected, line = content;
      if (scenes.picking) ui.text('Asking the scene what is there…', line.x, line.cy, {size: SIZE.xs, family: 'mono', color: ui.tone('muted')});
      else if (!ready) ui.text(scenes.view.state === 'failed' ? scenes.view.note : scenes.view.state === 'making' ? `Making what a browser draws: ${scenes.view.note}` : 'Loading the shapes…', line.x, line.cy, {size: SIZE.xs, family: 'mono', color: ui.tone(scenes.view.state === 'failed' ? 'danger' : 'muted'), max: line.w});
      else if (!selected) ui.text(scenes.pinMode ? 'Press the point to pin.' : 'Press a point of the scene to ask what is there.', line.x, line.cy, {size: SIZE.xs, family: 'mono', color: ui.tone(scenes.pinMode ? 'agent' : 'muted')});
      else {
        const keys = line.cutRight(walking ? 108 : 228, 12).cols(walking ? 1 : 2, 6);
        if (!walking) ui.button(keys[0], 'CENTRE', () => view.goTo(selected.point), {id: 'centre', size: SIZE.xs - 3});
        ui.button(keys.at(-1), 'STAND HERE', () => view.enter(selected.point), {id: 'stand', size: SIZE.xs - 3});
        const gap = selected.gap, apart = gap == null ? '' : Math.abs(gap) <= 0.02 ? ' · solid there too' : gap > 0 ? ` · solid ${gap.toFixed(2)} m behind` : ` · solid ${(-gap).toFixed(2)} m in front, where nothing shows`;
        const what = selected.seen ? `seen: ${shortShape(selected.seen.shape)}` : selected.solid ? `nothing seen; solid: ${shortShape(selected.solid.shape)}` : '';
        ui.text(`${metres(selected.point)} m`, line.x, line.cy - 9, {size: SIZE.sm, family: 'mono', max: line.w});
        ui.text(`${what}${selected.seen && !selected.solid ? ' · nothing solid there' : apart}`, line.x, line.cy + 12, {size: SIZE.xs - 1, family: 'mono', color: ui.tone(gap != null && Math.abs(gap) > 0.02 || (selected.seen && !selected.solid) ? 'warn' : 'muted'), max: line.w});
      }
    },
  });
  panel.minInterval = 50;
  scenes.addEventListener('change', () => panel.invalidate(), {signal: panel.signal});
  const timer = setInterval(() => panel.invalidate(), 600);
  panel.onDispose = () => clearInterval(timer);
  return app.dock.open(panel, 'deck');
}

// -- the recorded views -------------------------------------------------------------------------------------
function openViews(app) {
  const id = 'scenes:views', scenes = app.scenes, view = app.sceneView, state = {all: false}, thumbs = new Map();
  // A small picture of a view, fetched the first time it is drawn.
  const thumb = k => {
    if (!thumbs.has(k)) { const image = new Image(); image.onload = () => panel.invalidate(); image.src = gateway.scenes.evidenceUrl(scenes.id, k, true); thumbs.set(k, image); }
    const image = thumbs.get(k);
    return image.complete && image.naturalWidth ? image : null;
  };
  const stamp = time => time == null ? '' : `${Math.floor(time / 60)}:${String(Math.round(time % 60)).padStart(2, '0')}`;
  const panel = app.panel({
    id, title: 'Recorded views', glyph: 'camera', width: 0.44, height: app.dock.sideHeight(0.72) - 0.004, onClose: () => app.dock.close(id),
    draw(ui, content) {
      const evidence = scenes.open?.evidence;
      if (!evidence?.views.length) { ui.empty(content, 'This scene names no recording it was made from.'); return; }
      const named = evidence.views.filter(entry => entry.name), list = state.all || !named.length ? evidence.views : named, chosen = evidence.views[scenes.shown];
      panel.tag = `${evidence.views.length}`;
      // The chosen view: its picture, and the way to stand where its camera stood.
      if (chosen) {
        const box = content.cutTop(Math.min(240, content.w * (evidence.camera.height / evidence.camera.width)) + 96, 10), picture = box.cutTop(box.h - 96, 8), image = thumb(chosen.k);
        ui.ctx.fillStyle = ui.tone('bg', 0.9); ui.ctx.fillRect(picture.x, picture.y, picture.w, picture.h);
        if (image) { const scale = Math.min(picture.w / image.naturalWidth, picture.h / image.naturalHeight); ui.ctx.drawImage(image, picture.cx - image.naturalWidth * scale / 2, picture.cy - image.naturalHeight * scale / 2, image.naturalWidth * scale, image.naturalHeight * scale); }
        const keys = box.cutTop(40, 8).cols(2, 8);
        ui.button(keys[0], 'STAND WHERE IT STOOD', () => view.enterView(chosen.k), {id: 'stand', size: SIZE.xs - 1, icon: 'camera'});
        ui.button(keys[1], 'PUT IT AWAY', () => view.show(chosen.k), {id: 'away', size: SIZE.xs - 1, tone: 'muted'});
        ui.text('PICTURE', box.x, box.cy + 1, {size: SIZE.xs - 2, family: 'display', color: ui.tone('muted'), track: 1.5});
        ui.slider(new Rect(box.x + 70, box.y, box.w - 70, box.h), view.pictureOpacity, 0, 1, value => view.setPictureOpacity(value), {id: 'opacity', step: 0.01, format: value => (value < 0.02 ? 'the scene only' : value > 0.98 ? 'the recording only' : `${Math.round(value * 100)} % recording`)});
      } else content.cutTop(ui.wrap('Each dot in the scene is where the camera of the recording stood. Press a dot, or a picture here, to hang that picture in front of its camera.', new Rect(content.x, content.y, content.w, 0), {size: SIZE.xs, color: ui.tone('muted'), lineHeight: 1.4}) + 10, 0);
      if (named.length) ui.chips(content.cutTop(32, 8), [[false, `NAMED ${named.length}`], [true, `ALL ${evidence.views.length}`]], state.all, all => { state.all = all; }, {id: 'which', size: SIZE.xs - 1});
      const columns = 3, gap = 8, width = (content.w - 14 - gap * (columns - 1)) / columns, height = width * evidence.camera.height / evidence.camera.width + 22;
      ui.scroll(content, `views:${state.all}`, inner => {
        list.forEach((entry, at) => {
          const cell = new Rect(inner.x + (at % columns) * (width + gap), inner.y + Math.floor(at / columns) * (height + gap), width, height), picture = new Rect(cell.x, cell.y, cell.w, cell.h - 22);
          // Only what is in sight is fetched and drawn.
          if (cell.b < content.y - 40 || cell.y > content.b + 40) return;
          const image = thumb(entry.k), on = scenes.shown === entry.k;
          ui.ctx.fillStyle = ui.tone('bg', 0.9); ui.ctx.fillRect(picture.x, picture.y, picture.w, picture.h);
          if (image) ui.ctx.drawImage(image, picture.x, picture.y, picture.w, picture.h);
          if (on) { ui.ctx.strokeStyle = ui.tone('alt'); ui.ctx.lineWidth = 3; ui.ctx.strokeRect(picture.x + 1.5, picture.y + 1.5, picture.w - 3, picture.h - 3); }
          ui.text(entry.name || stamp(entry.time), cell.x + 2, cell.b - 9, {size: SIZE.xs - 3, family: 'mono', color: ui.tone(on ? 'fg' : 'muted'), max: cell.w - 44});
          if (entry.name) ui.text(stamp(entry.time), cell.r - 2, cell.b - 9, {size: SIZE.xs - 4, family: 'mono', color: ui.tone('muted', 0.8), align: 'right'});
          ui.region(cell, {id: `view:${entry.k}`, onClick: () => { view.show(entry.k); if (scenes.shown === entry.k && !view.walk.on) view.goTo(entry.pose.map(row => row[3])); }});
        });
        return Math.ceil(list.length / columns) * (height + gap);
      });
    },
  });
  scenes.addEventListener('change', () => panel.invalidate(), {signal: panel.signal});
  return app.dock.open(panel, 'right');
}
