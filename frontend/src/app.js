// The spatial desktop: one scene that is a heads-up cockpit on a flat screen and a room of holograms
// in a headset. It knows no robot. What it shows comes from the running blueprint (data/blueprint.js)
// and from the streams that blueprint publishes (scene/layers.js).
import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {Theme} from './theme.js';
import {Stage} from './scene/stage.js';
import {Backdrop} from './scene/backdrop.js';
import {Halo} from './scene/halo.js';
import {Layers} from './scene/layers.js';
import {Dock} from './ui/dock.js';
import {HoloPanel} from './ui/holo.js';
import {TextBridge} from './ui/textinput.js';
import {Pointers} from './input/pointers.js';
import {Hands} from './xr/hands.js';
import {XRManager} from './xr/session.js';
import {Bus} from './data/bus.js';
import {Blueprint} from './data/blueprint.js';
import {gateway} from './data/gateway.js';
import {Controls} from './data/controls.js';
import {Replay} from './data/replay.js';
import {ReplayScene} from './scene/replay.js';
import {Scenes} from './data/scenes.js';
import {SceneView} from './scene/scenes.js';
import {openShell} from './panels/shell.js';
import {openLauncher} from './panels/launcher.js';
import {openModules} from './panels/modules.js';
import {openModule} from './panels/module.js';
import {openKeyboard} from './panels/keyboard.js';
import {openReplay, watchReplay} from './panels/replay.js';
import {openScenes, watchScenes} from './panels/scenes.js';

const TABLE = new THREE.Vector3(0, 0.95, 0), FOV = 50;

export class App extends EventTarget {
  async start() {
    this.theme = new Theme();
    await this.theme.fontsReady();
    const renderer = this.renderer = new THREE.WebGLRenderer({antialias: true, alpha: true, powerPreference: 'high-performance'});
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(innerWidth, innerHeight);
    renderer.setClearColor(0x000000, 0);
    renderer.localClippingEnabled = true;
    renderer.xr.enabled = true;
    renderer.xr.setFramebufferScaleFactor(1.25);
    document.body.prepend(renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(FOV, innerWidth / innerHeight, 0.02, 200);
    this.scene.add(this.camera);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.8); key.position.set(1.5, 3, 2); this.scene.add(key);

    this.stage = new Stage(this.theme, {radius: 0.5});
    this.stage.root.position.copy(TABLE);
    this.scene.add(this.stage.root);
    this.backdrop = new Backdrop(this.theme); this.scene.add(this.backdrop.group);

    this.orbit = new OrbitControls(this.camera, renderer.domElement);
    this.orbit.enablePan = false; this.orbit.enableDamping = true; this.orbit.dampingFactor = 0.08;
    this.orbit.minDistance = 0.5; this.orbit.maxDistance = 6; this.orbit.maxPolarAngle = Math.PI * 0.52;
    this.resetCamera();

    this.text = new TextBridge();
    this.dock = new Dock({scene: this.scene, camera: this.camera, stage: this.stage});
    this.pointers = new Pointers({renderer, scene: this.scene, camera: this.camera, dock: this.dock, stage: this.stage, orbit: this.orbit, text: this.text});
    this.hands = new Hands(this.scene, this.theme);
    this.xr = new XRManager(this);

    this.bus = new Bus();
    this.blueprint = new Blueprint(this.bus);
    this.layers = new Layers(this);
    this.halo = new Halo(this);
    this.controls = new Controls(this);
    this.replay = new Replay(this);
    this.replayScene = new ReplayScene(this);
    this.scenes = new Scenes(this);
    this.sceneView = new SceneView(this);
    // One thing has the table: an episode that opens takes it from a scene.
    this.replay.addEventListener('open', () => this.scenes.close());
    this.pointers.onTablePoint = point => this.controls.place(point);
    this.pointers.driveSticks = (left, right) => this.controls.sticks(left, right);
    this.toasts = []; this.selected = null; this.last = performance.now();

    openShell(this);
    watchReplay(this);
    watchScenes(this);
    this.reopen();
    this.blueprint.start();
    // The left side shows what matters now: the catalog while nothing runs, the modules once something does.
    let wasRunning = null;
    this.blueprint.addEventListener('change', () => {
      const running = this.blueprint.phase === 'running' || this.blueprint.phase === 'starting';
      if (running === wasRunning) return;
      // Not over a replay or a scene: its panel has the left side until the user opens something else there.
      if (!this.dock.has('replay') && !this.dock.has('scenes') && (wasRunning === null || !this.dock.entries.get(running ? 'launcher' : 'modules')?.free)) {
        if (running && !this.dock.has('modules')) openModules(this);
        if (!running && !this.dock.has('launcher')) openLauncher(this);
      }
      if (wasRunning !== null) this.toast(running ? `${this.blueprint.name} is starting` : `${this.blueprint.name || 'Blueprint'} stopped`, running ? 'ok' : 'warn');
      // Panels about a module or a camera of the run that ended have nothing left to show.
      if (!running) for (const panel of this.dock.panels) if (/^(module|feed):/.test(panel.id)) this.dock.close(panel.id);
      wasRunning = running;
    });
    this.text.addEventListener('focus', () => { if (this.xr.presenting && !this.xr.session?.isSystemKeyboardSupported) openKeyboard(this, true); });
    this.text.addEventListener('blur', () => { if (this.dock.has('keyboard')) this.dock.close('keyboard'); });

    this.shareView();
    addEventListener('resize', () => this.resize());
    this.followDesktop();
    renderer.setAnimationLoop((time, frame) => this.frame(time, frame));
  }

  // -- staying current (update.js) --------------------------------------------------------------------
  // Why the page must not reload right now, or null when it may.
  holdReload() {
    if (this.xr.presenting) return 'you leave the headset view';
    if (this.controls.armed) return 'the controls are safe again';
    if (this.agents?.some(agent => agent.busy && agent.session)) return 'the agent has finished';
    if (this.text.active && this.text.value.trim()) return 'you finish typing';
    return null;
  }

  // What a reload should bring back: the panels that were open.
  beforeReload() {
    const open = this.dock.panels.filter(panel => !panel.closing).map(panel => panel.id).filter(id => !['head', 'bar', 'keyboard'].includes(id));
    const replay = this.replay.active ? {dataset: this.replay.dataset?.id, episode: this.replay.name, time: this.replay.time} : null;
    const scene = this.scenes.active ? {id: this.scenes.id, revision: this.scenes.revision} : null;
    sessionStorage.setItem('spatial.reopen', JSON.stringify({at: Date.now(), open, replay, scene}));
  }

  // After a reload the page made itself: the panels that were open come back (a module's panel once
  // the modules are known, a replayed episode at the moment it was at).
  reopen() {
    let kept = null;
    try { kept = JSON.parse(sessionStorage.getItem('spatial.reopen') || 'null'); sessionStorage.removeItem('spatial.reopen'); } catch { /* no storage */ }
    if (!kept || Date.now() - kept.at > 20000) return;
    for (const id of kept.open) if (this.openers[id] && !this.dock.has(id) && !(id === 'replay' && kept.replay) && !(id === 'scenes' && kept.scene)) this.openers[id]();
    if (kept.replay) openReplay(this, kept.replay);
    if (kept.scene) openScenes(this, kept.scene);
    const modules = kept.open.filter(id => id.startsWith('module:')).map(id => id.slice(7));
    if (modules.length) this.blueprint.addEventListener('modules', () => { for (const id of modules) if (this.blueprint.module(id) && !this.dock.has(`module:${id}`)) openModule(this, id); }, {once: true});
  }

  // A panel wired to this app's text entry.
  panel(options) {
    const panel = new HoloPanel(this.theme, options);
    panel.onFocus = target => this.text.focus({...target, panel});
    panel.onBlur = () => this.text.blur();
    return panel;
  }

  toast(message, tone = 'info', seconds = 4.5) {
    this.toasts.unshift({message: String(message), tone, until: performance.now() + seconds * 1000});
    this.toasts.length = Math.min(this.toasts.length, 4);
    this.dispatchEvent(new Event('toast'));
  }

  select(moduleId) { this.selected = moduleId; this.dispatchEvent(new Event('select')); }
  pulse(moduleId) { this.halo.pulse(moduleId); }

  resetCamera() {
    this.camera.position.set(TABLE.x, TABLE.y + 0.98, TABLE.z + 1.42);
    this.orbit.target.set(TABLE.x, TABLE.y + 0.06, TABLE.z);
    this.orbit.update();
  }

  resize() {
    if (this.renderer.xr.isPresenting) return;
    this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
    this.dock.layout();
  }

  // Desktop keeps a note of what each app shows, which an agent can read to know what the user is looking
  // at, and an agent can ask Desktop to point something out. Both go through here: the note is rewritten
  // when the selection, the panels or the layers change, and a highlight flashes that module's plate.
  shareView() {
    const name = location.pathname.split('/').filter(Boolean)[1] || 'dim-spatial-desktop';
    let timer = 0;
    const report = () => {
      clearTimeout(timer);
      timer = setTimeout(() => gateway.reportView(name, {
        view: 'spatial-desktop', blueprint: this.blueprint.name, phase: this.blueprint.phase, selected: this.selected, immersive: this.xr.presenting,
        // A recorded episode on the table instead of the live blueprint: which one, and where the playhead is.
        replay: this.replay.active ? {folder: `${this.replay.dataset?.path}/${this.replay.name}`, frame: this.replay.frame, seconds: this.replay.time, playing: this.replay.playing} : null,
        // A scene on the table: which file, where the user stands in it, what they pointed at, and how an agent answers.
        scene: this.scenes.active ? {name: this.scenes.open.scene.name, usd: this.scenes.current?.usd, revision: this.scenes.revision, manifest: this.scenes.open.scene.manifest, ...this.scenes.open.agent,
          camera: this.sceneView.viewer(), pointed_at: this.scenes.selected?.point ?? null, open_pins: this.scenes.pins.filter(pin => pin.state === 'open').length} : null,
        visible: {
          modules: this.blueprint.modules.map(module => ({id: module.id, label: module.name})),
          panels: this.dock.panels.map(panel => panel.id),
          layers: this.layers.list().filter(layer => layer.visible).map(layer => layer.label),
        },
      }).catch(() => {}), 1200);
    };
    this.addEventListener('select', report); this.dock.addEventListener('change', report); this.replay.addEventListener('change', report); this.scenes.addEventListener('change', report);
    this.layers.addEventListener('change', report); this.blueprint.addEventListener('modules', report); this.xr.addEventListener('change', report);
    this.bus.ready.then(() => this.bus.subscribeEvents('desktop', event => {
      if (event.type !== 'view-highlight' || (event.app && event.app !== name)) return;
      const module = this.blueprint.modules.find(entry => entry.id === event.id || entry.name === event.id || entry.name.toLowerCase() === String(event.id).toLowerCase());
      if (!module) return;
      this.select(module.id); this.toast(`Highlighted: ${module.name}`, 'info');
      for (let i = 0; i < (event.times || 3); i++) setTimeout(() => this.pulse(module.id), i * 600);
    }));
  }

  // Desktop's shell tells an embedded page how much of its bottom edge the dock covers, and which skin is on.
  followDesktop() {
    const skin = () => {
      try {
        const theme = localStorage.getItem('portal.theme'), corners = localStorage.getItem('portal.corners');
        if (theme) document.documentElement.dataset.skin = theme;
        if (corners && corners !== 'theme') document.documentElement.dataset.corners = corners; else delete document.documentElement.dataset.corners;
      } catch { /* storage blocked: the default skin stays */ }
    };
    skin();
    addEventListener('storage', event => { if (event.key?.startsWith('portal.')) skin(); });
    addEventListener('message', event => {
      if (event.origin !== location.origin || event.data?.type !== 'dimos-inset') return;
      this.dock.inset = {top: +event.data.top || 0, bottom: +event.data.bottom || 0};
      this.dock.layout();
    });
    if (parent !== window) parent.postMessage({type: 'dimos-inset-request'}, location.origin);
  }

  // -- XR -------------------------------------------------------------------------------------------
  onSessionStart(session) {
    if (this.sceneView.walk.on) this.sceneView.leave();
    this.orbit.enabled = false;
    this.dock.setMode('room');
    this.backdrop.setPassthrough(this.xr.passthrough);
    this.pointers.bindSession(session, this.renderer.xr.getReferenceSpace());
    this.renderer.xr.getReferenceSpace().addEventListener?.('reset', () => this.xr.recenter());
  }

  onSessionEnd() {
    if (this.sceneView.walk.on) this.sceneView.leave();
    this.orbit.enabled = true;
    this.dock.setMode('hud');
    this.backdrop.setPassthrough(false);
    this.hands.hide();
    this.controls.setInput('sticks', 0, 0, 0);
    this.stage.root.position.copy(TABLE); this.stage.root.rotation.set(0, 0, 0);
    this.stage.setLifeSize(false);
    // A session leaves the headset's field of view on the camera; the screen has its own.
    this.camera.fov = FOV; this.camera.zoom = 1;
    this.resetCamera(); this.resize();
  }

  // Put the table and the panels around a viewer standing at `head` and facing `yaw`.
  placeAround(head, yaw) {
    this.dock.setAnchor(head, yaw);
    const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
    this.stage.root.position.copy(head).addScaledVector(forward, 0.98);
    this.stage.root.position.y = Math.max(0.5, head.y - 0.58);
    this.stage.root.rotation.set(0, yaw, 0);
    this.viewer = {head: head.clone(), yaw};
  }

  frame(time, xrFrame) {
    const now = performance.now(), dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (this.toasts.length && this.toasts[this.toasts.length - 1].until < now) { this.toasts = this.toasts.filter(toast => toast.until >= now); this.dispatchEvent(new Event('toast')); }
    if (xrFrame) { this.xr.place(xrFrame); this.hands.update(xrFrame, this.renderer.xr.getReferenceSpace()); }
    else if (!this.sceneView.walk.on) this.orbit.update();   // a viewer inside a scene holds the camera
    this.stage.update(time / 1000, dt);
    this.pointers.update(dt, xrFrame, this.theme.three.primary);
    this.controls.tick(now);
    this.replay.tick(now, dt);
    // A scene or a replayed episode has the table: the live layers wait until it is closed.
    if (this.scenes.active) this.sceneView.update(now, dt); else if (this.replay.active) this.replayScene.update(now); else this.layers.update(dt, now);
    this.halo.update(dt, now);
    this.dock.update(now, dt);
    this.backdrop.update(time / 1000, this.renderer);
    if (this.sceneView.walk.on && !xrFrame) this.renderInside(); else this.renderer.render(this.scene, this.camera);
  }

  // Inside a scene, things of the scene come nearer to the eye than the panels that ride with the camera.
  // The panels are drawn after the scene and over it, so a table in front of the viewer never hides one.
  renderInside() {
    const {renderer, scene, camera, dock} = this;
    const shown = dock.hud.visible;
    dock.hud.visible = false;
    renderer.render(scene, camera);
    if (!shown) return;   // the viewer put the panels away
    const rest = scene.children.filter(child => child !== camera && child.visible);
    for (const child of rest) child.visible = false;
    dock.hud.visible = true;
    renderer.autoClear = false; renderer.clearDepth();
    renderer.render(scene, camera);
    renderer.autoClear = true;
    for (const child of rest) child.visible = true;
  }
}
