// Scenes: a USD scene on the table in place of the live blueprint, to walk through, check, mark and hand
// to an agent (docs/SCENES.md). The server finds scenes, derives what a browser draws, runs the check and
// answers rays (server/scenes.ts). This is the page's side of it: which scene and which revision is open,
// what is shown of it, what the user pointed at, and what was marked. It knows no file format.
import {gateway} from './gateway.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const LAYERS = {seen: true, solid: false, floor: true, marks: true, places: true, views: true, pins: true};
// Bodies to try a scene with, beside the one its manifest names: radius, height, step (metres).
export const BODIES = [['0.3,1.4,0.03', 'WHEELED'], ['0.25,1.35,0.2', 'LEGGED']];

export const bodyText = body => `${(body.radius * 2).toFixed(2)} m wide, ${body.height.toFixed(2)} m high, clears ${(body.step * 100).toFixed(0)} cm`;
const bodyKey = body => `${body.radius},${body.height},${body.step}`;
// The last part of a prim's path that says something: `/world/office/visual12/Mesh` is `visual12`.
export const shortShape = path => { const parts = String(path || '').split('/').filter(Boolean); return parts.length > 1 && /^(mesh|geom|shape)$/i.test(parts.at(-1)) ? parts.at(-2) : parts.at(-1) || ''; };

export class Scenes extends EventTarget {
  constructor(app) {
    super();
    this.app = app;
    this.list = null; this.runtime = null; this.error = ''; this.busy = false; this.loading = null;
    this.open = null; this.revision = 0; this.pins = [];
    this.view = {state: 'none', note: '', share: 0, report: null};
    this.check = {body: '', report: null, job: null}; this.floor = null;
    this.selected = null; this.picking = false; this.pinMode = false; this.pinFocus = null;
    this.against = null; this.diff = null; this.comparing = false;
    this.shown = null;   // the recorded view whose picture hangs in the scene
    this.layers = {...LAYERS, ...this.remembered().layers};
    this.token = 0;
    setInterval(() => { if (this.open && !document.hidden) this.pollRevisions(); }, 4000);
  }

  get active() { return !!this.open; }
  get id() { return this.open?.scene.id ?? null; }
  get current() { return this.open?.revisions.find(revision => revision.n === this.revision) ?? null; }
  emit(type = 'change') { this.dispatchEvent(new Event(type)); }

  remember() { try { localStorage.setItem('spatial.scenes', JSON.stringify({id: this.id ?? this.remembered().id ?? null, layers: this.layers})); } catch { /* private mode */ } }
  remembered() { try { return JSON.parse(localStorage.getItem('spatial.scenes') || '{}'); } catch { return {}; } }

  setLayer(name, on) { this.layers[name] = on; this.remember(); this.emit('layers'); this.emit(); }

  // -- what there is to open ----------------------------------------------------------------------------
  async refresh(rescan = false) {
    this.busy = true; this.emit();
    try { const found = await gateway.scenes.list(rescan); this.list = found.scenes; this.runtime = found.runtime; this.error = ''; }
    catch (error) { this.error = error.message; this.list ??= []; }
    this.busy = false; this.emit();
  }

  async add(path) {
    const found = await gateway.scenes.add(path);
    this.list = found.scenes; this.emit();
    await this.openScene(found.added);
  }

  // -- one scene ----------------------------------------------------------------------------------------
  async openScene(id, revision = null) {
    const token = ++this.token, first = this.id !== id;
    this.loading = id; this.error = ''; this.emit();
    try {
      const described = await gateway.scenes.scene(id, revision);
      if (token !== this.token) return;
      // One thing has the table: a recorded episode gives way to a scene.
      if (this.app.replay.active) this.app.replay.close();
      const stamp = this.open?.usd.stamp;
      this.open = described; this.revision = described.revision; this.pins = described.pins;
      this.check = {body: bodyKey(described.body), report: described.check.report, job: described.check.job};
      this.floor = null; this.selected = null; this.shown = first ? null : this.shown;
      if (first) { this.against = null; this.diff = null; this.pinMode = false; }
      // The agent works where the scene's author works.
      this.app.agentFolder = described.agent.cwd;
      this.remember();
      this.emit(first ? 'open' : 'revision'); this.emit('floor');
      if (first || stamp !== described.usd.stamp) this.loadView(token);
      if (this.check.report) this.loadFloor(token);
      if (this.check.job?.state === 'running') this.followCheck(token);
    } catch (error) { if (token === this.token) this.error = error.message; }
    if (token === this.token) { this.loading = null; this.emit(); }
  }

  close() {
    if (!this.open) return;
    this.token++; this.open = null; this.loading = null; this.pins = []; this.floor = null; this.selected = null; this.diff = null; this.against = null; this.shown = null;
    this.view = {state: 'none', note: '', share: 0, report: null}; this.check = {body: '', report: null, job: null};
    this.app.agentFolder = null;
    this.emit('close'); this.emit();
  }

  // What a browser draws is derived from the USD once (seconds) and kept; then the page loads it.
  async loadView(token = this.token) {
    const id = this.id, revision = this.revision;
    this.view = {state: 'making', note: 'looking for the view', share: 0, report: null}; this.emit();
    try {
      let answer = await gateway.scenes.view(id, revision, true);
      while (!answer.ready) {
        if (token !== this.token) return;
        if (answer.job?.state === 'failed') throw new Error(answer.job.error || 'the view could not be made');
        this.view = {state: 'making', note: answer.job?.note || 'reading the scene', share: answer.job?.total ? answer.job.done / answer.job.total : 0, report: null}; this.emit();
        await sleep(600);
        answer = await gateway.scenes.view(id, revision);
      }
      if (token !== this.token) return;
      this.view = {state: 'loading', note: '', share: 0, report: answer.report};
      this.emit('view'); this.emit();
    } catch (error) { if (token === this.token) { this.view = {state: 'failed', note: error.message, share: 0, report: null}; this.emit(); } }
  }

  // The scene on the table tells how its loading goes (scene/scenes.js).
  viewProgress(share) { if (this.view.state === 'loading') { this.view.share = share; this.emit(); } }
  viewReady() {
    this.view = {...this.view, state: 'ready', share: 1}; this.emit('ready'); this.emit();
    // The first press on the scene should not wait for the engine to load it: have it loaded now.
    gateway.scenes.warm(this.id, this.revision).catch(() => {});
  }
  viewFailed(note) { this.view = {...this.view, state: 'failed', note}; this.emit(); }
  fileUrl(file) { return gateway.scenes.viewUrl(this.id, this.revision, file); }

  // -- the check ----------------------------------------------------------------------------------------
  async runCheck() {
    const token = this.token;
    try {
      const answer = await gateway.scenes.check(this.id, this.revision, this.check.body, true);
      this.check = {...this.check, job: answer.job, report: null}; this.floor = null; this.emit('floor'); this.emit();
      this.followCheck(token);
    } catch (error) { this.check = {...this.check, job: {state: 'failed', error: error.message}}; this.emit(); }
  }

  async followCheck(token) {
    const body = this.check.body;
    while (token === this.token && this.check.body === body && this.check.job?.state === 'running') {
      await sleep(900);
      try {
        const answer = await gateway.scenes.check(this.id, this.revision, body);
        if (token !== this.token || this.check.body !== body) return;
        this.check = {...this.check, job: answer.job, report: answer.report};
        if (answer.report) this.loadFloor(token);
      } catch { /* asked again */ }
      this.emit();
    }
  }

  // The same scene tried with another body: what was found for it before, if anything.
  async setBody(body) {
    if (body === this.check.body) return;
    const token = this.token;
    this.check = {body, report: null, job: null}; this.floor = null; this.emit('floor'); this.emit();
    try {
      const answer = await gateway.scenes.check(this.id, this.revision, body);
      if (token !== this.token || this.check.body !== body) return;
      this.check = {body, report: answer.report, job: answer.job};
      if (answer.report) this.loadFloor(token);
      if (answer.job?.state === 'running') this.followCheck(token);
    } catch { /* nothing known for this body */ }
    this.emit();
  }

  // The floor the body reached: x, y, z for each cell, to draw on the scene.
  async loadFloor(token = this.token) {
    try {
      const answer = await gateway.scenes.floor(this.id, this.revision, this.check.body);
      if (token !== this.token) return;
      this.floor = new Float32Array(answer.buffer, answer.offset, answer.meta.cells * 3);
    } catch { this.floor = null; }
    this.emit('floor'); this.emit();
  }

  result(id) { return this.check.report?.checks.find(check => check.id === id) ?? null; }

  // -- pointing -----------------------------------------------------------------------------------------
  // What a ray from the viewer meets, in the scene's frame: the shape that is seen there and the shape a
  // body would touch there. The engine that simulates the scene answers, not the picture on the page.
  async pick(origin, direction) {
    if (!this.open || this.picking) return;
    const token = this.token;
    this.picking = true; this.emit();
    try {
      const found = await gateway.scenes.ray(this.id, this.revision, origin, direction);
      if (token !== this.token) return;
      const hit = found.seen ?? found.solid;
      this.selected = hit ? {point: hit.point, seen: found.seen, solid: found.solid, gap: found.seen && found.solid ? found.solid.distance - found.seen.distance : null} : null;
      this.emit('select');
      if (this.selected && this.pinMode) { this.pinMode = false; await this.addPin(); }
    } catch (error) { this.app.toast(`Could not look there: ${error.message}`, 'warn'); }
    this.picking = false; this.emit();
  }

  select(point) { this.selected = point ? {point, seen: null, solid: null, gap: null} : null; this.emit('select'); this.emit(); }

  // -- pins: points with a note, for the agent and for later --------------------------------------------
  async addPin(note = '') {
    const selected = this.selected;
    if (!selected) return;
    try {
      const picture = await this.app.sceneView.snapshot().catch(() => null);
      const snapshot = picture ? (await gateway.scenes.snapshot(this.id, picture).catch(() => null))?.path ?? null : null;
      const {pins} = await gateway.scenes.pin(this.id, {
        position: selected.point, note, revision: this.revision, seen: selected.seen?.shape ?? null, solid: selected.solid?.shape ?? null, gap: selected.gap,
        camera: this.app.sceneView.viewer(), snapshot,
      });
      this.pins = pins; this.pinFocus = pins.at(-1).n;
      this.emit('pins'); this.emit();
    } catch (error) { this.app.toast(`The pin was not kept: ${error.message}`, 'warn'); }
  }

  async editPin(n, changes) {
    const pin = this.pins.find(entry => entry.n === n);
    if (pin) Object.assign(pin, changes);
    this.emit('pins'); this.emit();
    try { this.pins = (await gateway.scenes.editPin(this.id, n, changes)).pins; } catch (error) { this.app.toast(`Not saved: ${error.message}`, 'warn'); }
    this.emit('pins'); this.emit();
  }

  async removePin(n) {
    try { this.pins = (await gateway.scenes.removePin(this.id, n)).pins; } catch (error) { this.app.toast(`Not removed: ${error.message}`, 'warn'); }
    if (this.pinFocus === n) this.pinFocus = null;
    this.emit('pins'); this.emit();
  }

  // -- revisions ----------------------------------------------------------------------------------------
  // An agent announces a new revision by a file; it is shown as soon as it is there, against the one before.
  async pollRevisions() {
    if (!this.open || this.polling) return;
    this.polling = true;
    try {
      const {revisions} = await gateway.scenes.revisions(this.id);
      if (!this.open) return;
      const known = this.open.revisions.length;
      const changed = JSON.stringify(revisions) !== JSON.stringify(this.open.revisions);
      this.open.revisions = revisions;
      if (revisions.length > known) {
        const fresh = revisions.at(-1), before = this.revision;
        this.app.toast(`A new revision of ${this.open.scene.name}: ${fresh.label}`, 'ok', 7);
        await this.show(fresh.n, before);
      } else if (changed) this.emit();
    } catch { /* asked again in a moment */ }
    this.polling = false;
  }

  // Put a revision on the table, and optionally say what it is compared with.
  async show(n, against = null) {
    await this.openScene(this.id, n);
    this.against = against; this.diff = null;
    if (against != null && against !== n) await this.compare(against);
    else { this.emit('diff'); this.emit(); }
  }

  async compare(n) {
    const token = this.token;
    this.against = n; this.diff = null; this.comparing = true; this.emit('diff'); this.emit();
    try {
      // Always the later revision against the earlier one, whichever of the two is on the table: what
      // came and what went mean the same after a flip.
      const diff = await gateway.scenes.diff(this.id, Math.min(n, this.revision), Math.max(n, this.revision));
      if (token === this.token && this.against === n) this.diff = diff;
    } catch (error) { this.app.toast(`Could not compare the revisions: ${error.message}`, 'warn'); this.against = null; }
    this.comparing = false; this.emit('diff'); this.emit();
  }

  // The other one of the two revisions being compared.
  flip() { if (this.against != null) this.show(this.against, this.revision); }

  async mark(n, state) {
    try {
      this.open.revisions = (await gateway.scenes.mark(this.id, n, state)).revisions;
      // A rejected revision leaves the table to the newest one that was not rejected.
      if (state === 'rejected' && n === this.revision) {
        const back = [...this.open.revisions].reverse().find(revision => revision.state !== 'rejected');
        await this.show(back.n);
      } else if (state === 'kept') { this.against = null; this.diff = null; this.emit('diff'); }
    } catch (error) { this.app.toast(error.message, 'warn'); }
    this.emit();
  }

  // -- for an agent -------------------------------------------------------------------------------------
  // What an agent needs to work on what the user is looking at, as the first lines of a message.
  brief() {
    const open = this.open, revision = this.current, pins = this.pins.filter(pin => pin.state === 'open');
    const at = point => `(${point.map(value => value.toFixed(2)).join(', ')})`;
    return [
      `Work on the scene "${open.scene.name}" with me. On screen is revision ${revision.n} (${revision.label}): ${revision.usd}`,
      open.scene.manifest ? `Its manifest: ${open.scene.manifest}` : 'It has no manifest (scene.json) yet.',
      `What a scene is and how it is checked: ${open.agent.guide}`,
      `Test a scene file with: ${open.agent.check}`,
      pins.length ? `I marked ${pins.length} point${pins.length > 1 ? 's' : ''} (the scene's frame: metres, z up). ${open.agent.pins} has them all:` : '',
      ...pins.map(pin => `  #${pin.n} at ${at(pin.position)}${pin.seen ? ` on ${shortShape(pin.seen)}` : ''}: ${pin.note || '(no note)'}${pin.snapshot ? `  [what I saw: ${pin.snapshot}]` : ''}`),
      `Do not change the scene's files in place. Write a new revision as a new USD file, then announce it by writing {"usd": "<full path>", "label": "<what changed>"} as a .json file into ${open.agent.inbox}`,
      '',
    ].filter((line, index, lines) => line || index === lines.length - 1).join('\n');
  }
}
