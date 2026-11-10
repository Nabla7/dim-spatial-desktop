// Keeps an open page current. The app's server gives the build it serves a stamp (GET api/version); this
// asks now and then and reloads the page when the stamp is no longer the one it was loaded with. It is
// a script of its own, apart from the app, so a page whose app failed to start still picks up the fix.
//
// The app can ask for a delay (window.spatial.holdReload() returns why): never under a headset, never
// while the robot's controls are armed.
const PERIOD = 2500;
let loaded = null, seen = null, told = null;

async function look() {
  let stamp;
  try {
    const response = await fetch(new URL('api/version', location.href), {cache: 'no-store'});
    if (!response.ok) return;            // an install with no server (a static page): nothing to follow
    stamp = (await response.json()).stamp;
  } catch { return; }                    // the server is restarting; the next look will say
  if (!stamp) return;
  if (loaded === null) { loaded = stamp; return; }
  if (stamp === loaded) { seen = null; return; }
  // Files are often saved several at a time: wait until two looks in a row agree.
  if (stamp !== seen) { seen = stamp; return; }
  const app = window.spatial, hold = app?.holdReload?.();
  if (hold) {
    if (told !== stamp) { told = stamp; app.toast?.(`A newer version of this page is ready. It loads when ${hold}.`, 'info', 8); }
    return;
  }
  try { app?.beforeReload?.(); } catch { /* the reload matters more than what it remembers */ }
  location.reload();
}

setInterval(look, PERIOD);
look();
