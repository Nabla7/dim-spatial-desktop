// Optional shared speed capability. The provider describes values, bounds, input ports and which
// values scale a normalized drive. No robot, module class or topic name is assumed here.
import {gateway} from './gateway.js';

export class MotionSpeeds {
  constructor(controls) {
    this.controls = controls; this.provider = null; this.settings = {}; this.drive = {};
    this.ready = false; this.busy = false; this.reading = false; this.pending = {}; this.generation = 0; this.revision = 0;
  }

  discover(modules) {
    const providers = modules.filter(module =>
      module.rpcs.some(rpc => rpc.name === 'get_motion_speeds' && !rpc.params.some(param => param.required)) &&
      module.rpcs.some(rpc => rpc.name === 'set_motion_speeds'));
    // Multiple independent robots need an explicit binding; never pick one by list order.
    const provider = providers.length === 1 ? providers[0] : null;
    if (provider?.id === this.provider?.id) { this.provider = provider; return; }
    this.generation++; this.provider = provider; this.ready = false; this.settings = {}; this.drive = {};
    this.pending = {}; this.busy = false; this.reading = false;
  }

  get keys() {
    const ports = new Set(Object.values(this.settings).map(setting => setting.port));
    return new Set((this.provider?.streams || []).filter(stream => ports.has(stream.name)).map(stream => stream.key));
  }

  sync() {
    for (const axis of ['linear', 'angular']) {
      const value = this.settings[this.drive[axis]]?.value;
      if (Number.isFinite(value)) this.controls.speed[axis] = value;
    }
    this.controls.emit();
  }

  async refresh() {
    if (!this.provider || this.busy || this.reading) return;
    const generation = this.generation, revision = this.revision;
    this.reading = true;
    try {
      const answer = await gateway.callRpc(this.provider.id, 'get_motion_speeds');
      if (generation !== this.generation || this.busy || revision !== this.revision) return;
      if (!answer.ok) throw new Error(answer.error || 'Speed settings unavailable');
      const {settings, drive} = answer.result || {};
      if (!settings || !drive || !Object.values(settings).every(setting =>
        [setting.value, setting.min, setting.max].every(Number.isFinite) &&
        setting.min <= setting.value && setting.value <= setting.max) ||
        !['linear', 'angular'].every(axis => settings[drive[axis]])) throw new Error('Invalid speed settings');
      this.settings = settings; this.drive = drive; this.ready = true; this.error = null; this.sync();
    } catch (error) {
      if (generation === this.generation) { this.error = error.message; this.controls.emit(); }
    } finally { if (generation === this.generation) this.reading = false; }
  }

  set(name, value) {
    const setting = this.settings[name];
    if (!this.controls.armed || !this.ready || !setting || !Number.isFinite(value) || value < setting.min || value > setting.max) return;
    this.revision++; this.pending[name] = value; this.controls.emit(); return this.flush();
  }

  async flush() {
    if (this.busy) return;
    const generation = this.generation;
    this.busy = true;
    try {
      // One write in flight. Coalesce slider drags, including the final released value.
      while (this.controls.armed && Object.keys(this.pending).length && generation === this.generation) {
        const changes = this.pending; this.pending = {};
        const answer = await gateway.callRpc(this.provider.id, 'set_motion_speeds', changes);
        if (generation !== this.generation) return;
        if (!answer.ok) throw new Error(answer.error || 'Speed change refused');
        for (const [name, value] of Object.entries(answer.result || {})) {
          const setting = this.settings[name];
          if (setting && Number.isFinite(value)) setting.value = value;
        }
        this.error = null; this.sync();
      }
    } catch (error) {
      if (generation === this.generation) {
        this.error = error.message; this.controls.app.toast(`Speed change failed: ${error.message}`, 'danger');
      }
    } finally {
      if (generation === this.generation) { this.pending = {}; this.busy = false; this.controls.emit(); }
    }
  }
}
