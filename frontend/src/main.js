// Entry point. `?emulate` installs an in-page WebXR runtime (IWER) so the headset code paths can be
// exercised in a desk browser; it is a development aid and is never loaded otherwise.
import {App} from './app.js';

const boot = document.querySelector('#boot'), note = document.querySelector('#boot-note');

async function emulate() {
  const {XRDevice, metaQuest3} = await import('../vendor/dev/iwer.module.min.js');
  const device = new XRDevice(metaQuest3);
  // A desk browser has navigator.xr with no device behind it; the emulator takes its place.
  device.installRuntime({forceInstall: true});
  window.xrDevice = device;
}

try {
  if (new URLSearchParams(location.search).has('emulate')) await emulate();
  const app = window.spatial = new App();
  await app.start();
  boot.classList.add('done');
  setTimeout(() => boot.remove(), 900);
} catch (error) {
  console.error(error);
  note.textContent = `Could not start: ${error.message || error}`;
  boot.classList.add('failed');
}
