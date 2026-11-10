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
import {openShell} from './panels/shell.js';
import {openLauncher} from './panels/launcher.js';
import {openModules} from './panels/modules.js';
import {openKeyboard} from './panels/keyboard.js';

const TABLE = new THREE.Vector3(0, 0.95, 0);

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
    this.camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.02, 200);
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
    this.toasts = []; this.selected = null; this.last = performance.now();

    openShell(this);
    openLauncher(this);
    openModules(this);
    this.blueprint.start();
    // The first run to appear frames itself: open on what is there rather than on an empty table.
    this.blueprint.addEventListener('change', () => { if (this.blueprint.phase === 'failed' && this.blueprint.launch?.error) this.toast(`Launch failed: ${this.blueprint.launch.error}`, 'danger'); });
    this.text.addEventListener('focus', () => { if (this.xr.presenting && !this.xr.session?.isSystemKeyboardSupported) openKeyboard(this, true); });
    this.text.addEventListener('blur', () => { if (this.dock.has('keyboard')) this.dock.close('keyboard'); });

    addEventListener('resize', () => this.resize());
    this.followDesktop();
    renderer.setAnimationLoop((time, frame) => this.frame(time, frame));
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
    this.orbit.enabled = false;
    this.dock.setMode('room');
    this.backdrop.setPassthrough(this.xr.passthrough);
    this.pointers.bindSession(session, this.renderer.xr.getReferenceSpace());
    this.renderer.xr.getReferenceSpace().addEventListener?.('reset', () => this.xr.recenter());
  }

  onSessionEnd() {
    this.orbit.enabled = true;
    this.dock.setMode('hud');
    this.backdrop.setPassthrough(false);
    this.hands.hide();
    this.stage.root.position.copy(TABLE); this.stage.root.rotation.set(0, 0, 0);
    this.stage.setLifeSize(false);
    this.resetCamera(); this.resize();
  }

  // Put the table and the panels around a viewer standing at `head` and facing `yaw`.
  placeAround(head, yaw) {
    this.dock.setAnchor(head, yaw);
    const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
    this.stage.root.position.copy(head).addScaledVector(forward, 0.82);
    this.stage.root.position.y = Math.max(0.5, head.y - 0.58);
    this.stage.root.rotation.set(0, yaw, 0);
    this.viewer = {head: head.clone(), yaw};
  }

  frame(time, xrFrame) {
    const now = performance.now(), dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (this.toasts.length && this.toasts[this.toasts.length - 1].until < now) { this.toasts = this.toasts.filter(toast => toast.until >= now); this.dispatchEvent(new Event('toast')); }
    if (xrFrame) { this.xr.place(xrFrame); this.hands.update(xrFrame, this.renderer.xr.getReferenceSpace()); }
    else this.orbit.update();
    this.stage.update(time / 1000, dt);
    this.pointers.update(dt, xrFrame, this.theme.three.primary);
    this.layers.update(dt, now);
    this.halo.update(dt, now);
    this.dock.update(now, dt);
    this.backdrop.update(time / 1000, this.renderer);
    this.renderer.render(this.scene, this.camera);
  }
}
