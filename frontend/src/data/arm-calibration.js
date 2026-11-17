// The backend owns calibration math, quality checks, persistence and robot holds.
// This client only selects the source, requests captures and displays the protocol.
import {gateway} from './gateway.js';

export function calibrationProvider(module) {
  const names = new Set(module?.rpcs.map(rpc => rpc.name) || []);
  return ['get_arm_calibration', 'begin_arm_calibration', 'capture_arm_calibration', 'save_arm_calibration',
    'activate_arm_calibration', 'cancel_arm_calibration', 'delete_arm_calibration'].every(name => names.has(name)) ? module : null;
}

export function inputIdentity(session) {
  const sources = [...(session?.inputSources || [])].filter(input => ['left', 'right'].includes(input.handedness));
  const controllers = sources.filter(input => !input.hand && input.targetRayMode === 'tracked-pointer' && input.gamepad);
  const kind = controllers.length ? 'controllers' : 'hands';
  const selected = controllers.length ? controllers : sources.filter(input => input.hand);
  // WebXR profiles describe coordinate/layout conventions. We do not assume a headset brand or serial.
  const profiles = [...new Set(selected.flatMap(input => input.profiles?.length ? input.profiles : [kind === 'hands' ? 'tracked-hand' : input.gamepad?.mapping || 'tracked-controller']))].sort();
  return {input_kind: kind, device: profiles.join('+') || kind};
}

export class ArmCalibrationUI {
  constructor(xr) {
    this.xr = xr; this.provider = null; this.status = null; this.error = null; this.readError = null; this.busy = false; this.reading = false;
    this.name = 'Default'; this.selected = ''; this.session = ''; this.countdown = null; this.generation = 0;
  }
  get available() { return !!this.provider; }
  get identity() { return inputIdentity(this.xr.controls.app.xr.session); }
  get inputsReady() {
    const kind = this.identity.input_kind, sources = [...(this.xr.controls.app.xr.session?.inputSources || [])];
    return ['left', 'right'].every(side => sources.some(input => input.handedness === side &&
      (kind === 'hands' ? !!input.hand : !input.hand && input.targetRayMode === 'tracked-pointer' && !!input.gamepad)));
  }
  get profiles() { return this.status?.profiles || []; }
  get compatible() { const source = this.identity; return this.profiles.filter(p => p.schema_version === 2 && p.input_kind === source.input_kind && p.device === source.device); }
  get capturing() { return this.xr.calibrating; }
  discover(module) {
    const provider = calibrationProvider(module);
    if (provider?.id !== this.provider?.id) {
      this.generation++; this.countdown = null; this.status = null; this.selected = ''; this.error = null; this.readError = null;
    }
    this.provider = provider;
  }
  accept(status) {
    if (status?.version !== 2) throw new Error('Unsupported arm calibration protocol');
    this.status = status;
    if (!this.selected || !status.profiles.some(p => p.id === this.selected)) this.selected = status.profile_id || '';
    this.xr.controls.emit();
  }
  async refresh() {
    if (!this.provider || this.reading) return;
    const generation = this.generation, id = this.provider.id; this.reading = true;
    try {
      const answer = await gateway.callRpc(id, 'get_arm_calibration', this.selected ? {profile_id: this.selected} : {});
      if (generation !== this.generation) return;
      if (!answer.ok) throw new Error(answer.error || 'Could not read calibration');
      this.readError = null; this.accept(answer.result);
    } catch (error) { if (generation === this.generation) { this.readError = error.message; this.xr.controls.emit(); } }
    finally { this.reading = false; }
  }
  async call(method, args) {
    if (!this.provider) throw new Error('This backend does not offer arm calibration');
    const generation = this.generation;
    const answer = await gateway.callRpc(this.provider.id, method, args);
    if (generation !== this.generation) throw new Error('The running robot changed');
    if (!answer.ok) throw new Error(answer.error || 'Calibration request refused');
    this.accept(answer.result); return answer.result;
  }
  async action(fn) {
    if (this.busy) return;
    this.busy = true; this.error = null; this.xr.controls.emit();
    try { await fn(); }
    catch (error) { this.error = error.message; }
    finally { this.busy = false; this.xr.controls.emit(); }
  }
  async begin() {
    const c = this.xr.controls;
    if (!c.armed || !c.app.xr.presenting || !c.bus.live) return;
    return this.action(async () => {
      if (!this.inputsReady) throw new Error('Waiting for both tracked hands or controllers.');
      const b = this.xr.binding;
      await c.claim([b.pose.key, b.joy.key, b.head?.key, b.pad?.key].filter(Boolean));
      if (c.lease.status !== 'held') throw new Error(c.lease.reason || 'Could not acquire the controls');
      this.xr.stop(); this.session = crypto.randomUUID();
      await this.call('begin_arm_calibration', {name: this.name, ...this.identity, session: this.session});
      await this.xr.start({calibrating: true});
      if (!this.xr.enabled) throw new Error(this.xr.error || 'Could not start tracked input');
    });
  }
  async activate() {
    this.error = null;
    if (!this.inputsReady) throw new Error('Waiting for both tracked hands or controllers.');
    await this.refresh();
    if (!this.compatible.some(p => p.id === this.selected)) throw new Error('Choose a calibration for this input method, or open CALIBRATION to create one.');
    this.session = crypto.randomUUID();
    await this.call('activate_arm_calibration', {profile_id: this.selected, ...this.identity, session: this.session});
  }
  capture(stage, now = performance.now()) {
    if (!this.capturing || this.busy || this.countdown) return;
    this.countdown = {stage, until: now + 3000, session: this.session}; this.xr.controls.emit();
  }
  frame(now) {
    if (!this.countdown) return;
    const c = this.xr.controls;
    if (!this.capturing || !c.armed || !c.app.xr.presenting || !c.bus.live || c.lease.status !== 'held') { this.countdown = null; return; }
    if (now < this.countdown.until) { c.emit(); return; }
    const {stage, session} = this.countdown; this.countdown = null;
    void this.action(() => this.call('capture_arm_calibration', {stage, session}));
  }
  save() {
    return this.action(async () => {
      const result = await this.call('save_arm_calibration', {session: this.session});
      this.selected = result.profile_id; this.xr.stop();
    });
  }
  cancel() {
    return this.action(async () => {
      this.xr.stop(); this.countdown = null;
      await this.call('cancel_arm_calibration', {session: this.session || this.status?.session});
    });
  }
  remove() {
    return this.action(async () => {
      this.xr.stop(); await this.call('delete_arm_calibration', {profile_id: this.selected}); this.selected = '';
    });
  }
}
