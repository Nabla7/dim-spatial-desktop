// Optional arm-home protocol. Pose values and motion ownership remain on the backend.
import {gateway} from './gateway.js';

export const armHomeProvider = modules => modules.find(module =>
  ['home_arms', 'cancel_arm_home', 'get_arm_home_status'].every(name => module.rpcs.some(rpc => rpc.name === name))) || null;

export class ArmHome {
  constructor(controls) { this.controls = controls; this.provider = null; this.active = false; this.busy = false; this.status = null; this.error = null; this.timer = null; this.cancelled = false; }
  discover(modules) {
    const provider = armHomeProvider(modules);
    if (provider?.id !== this.provider?.id) { clearTimeout(this.timer); this.active = this.busy = false; this.status = null; this.error = null; }
    this.provider = provider;
  }
  async call(provider, method) {
    const answer = await gateway.callRpc(provider.id, method, {});
    if (!answer.ok) throw new Error(answer.error || `${method} failed`);
    return answer.result;
  }
  async start() {
    if (!this.controls.armed || !this.provider || this.busy || this.active) return;
    const provider = this.provider;
    this.controls.xr.stop('returning_home');
    for (const source of ['pad', 'keys', 'sticks']) this.controls.setInput(source, 0, 0, 0);
    this.active = this.busy = true; this.cancelled = false; this.error = null; this.controls.emit();
    try {
      const binding = this.controls.xr.binding;
      if (binding) {
        await this.controls.claim([binding.pose.key, binding.joy.key]);
        if (this.controls.lease.status !== 'held') throw new Error('Could not acquire robot controls');
      }
      if (this.cancelled || !this.controls.armed || provider.id !== this.provider?.id) return;
      this.status = await this.call(provider, 'home_arms');
      if (!this.cancelled) this.controls.app.toast('Returning arms home. Re-enable tracking afterward.', 'info');
    } catch (error) { this.error = error.message; this.controls.app.toast(`Arm home: ${error.message}`, 'danger'); }
    finally {
      this.busy = false;
      // STOP may have raced a pending home request: cancel again after its response.
      if (this.cancelled) await this.cancel(provider);
      else if (provider.id === this.provider?.id) await this.refresh(provider);
      this.controls.emit();
    }
  }
  async cancel(provider = this.provider) {
    if (!provider || (!this.active && !this.busy)) return;
    this.cancelled = true; clearTimeout(this.timer);
    try { this.status = await this.call(provider, 'cancel_arm_home'); if (!this.busy) this.active = false; }
    catch (error) { this.error = `Cancel unconfirmed: ${error.message}`; }
    this.controls.emit();
  }
  async refresh(provider = this.provider) {
    if (provider.id !== this.provider?.id || !this.active || this.cancelled) return;
    try {
      const status = await this.call(provider, 'get_arm_home_status');
      if (provider.id !== this.provider?.id) return;
      this.status = status;
      this.active = status.state === 'moving';
    } catch (error) { this.error = error.message; }
    this.controls.emit();
    if (this.active && !this.cancelled) this.timer = setTimeout(() => this.refresh(provider), 1000);
  }
}
