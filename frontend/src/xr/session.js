// Entering and leaving a headset session. VR replaces the room with the backdrop; mixed reality
// (immersive-ar) keeps the room and draws only the holograms. WebXR needs a secure context:
// localhost counts, a headset on the network needs Desktop's HTTPS port (config.yaml desktop.tls).
import * as THREE from 'three';

export class XRManager extends EventTarget {
  constructor(app) {
    super();
    this.app = app; this.modes = []; this.presenting = false; this.mode = null; this.needsPlacement = false;
    this.reason = !window.isSecureContext ? 'WebXR needs HTTPS (or localhost)' : !navigator.xr ? 'this browser has no WebXR' : '';
    this.detect();
  }

  async detect() {
    if (!navigator.xr) return;
    const modes = [];
    for (const mode of ['immersive-vr', 'immersive-ar']) {
      try { if (await navigator.xr.isSessionSupported(mode)) modes.push(mode); } catch { /* blocked by policy: not offered */ }
    }
    this.modes = modes;
    if (!modes.length) this.reason = 'no headset found by this browser';
    this.dispatchEvent(new Event('change'));
  }

  async enter(mode) {
    const {renderer} = this.app;
    if (this.presenting) return;
    try {
      const session = await navigator.xr.requestSession(mode, {requiredFeatures: ['local-floor'], optionalFeatures: ['hand-tracking']});
      renderer.xr.setReferenceSpaceType('local-floor');
      await renderer.xr.setSession(session);
      this.session = session; this.mode = mode; this.presenting = true; this.needsPlacement = true;
      // 'alpha-blend' and 'additive' sessions show the room behind the frame.
      this.passthrough = session.environmentBlendMode && session.environmentBlendMode !== 'opaque';
      this.app.onSessionStart(session);
      session.addEventListener('end', () => {
        this.presenting = false; this.session = null; this.mode = null; this.passthrough = false;
        this.app.onSessionEnd();
        this.dispatchEvent(new Event('change'));
      });
      this.dispatchEvent(new Event('change'));
    } catch (error) {
      this.app.toast(`Cannot enter XR: ${error.message}`, 'danger');
    }
  }

  exit() { this.session?.end().catch(() => {}); }

  // The viewer's head, flattened to a position and a heading, once per session start or recentre.
  place(frame) {
    if (!this.needsPlacement) return;
    const reference = this.app.renderer.xr.getReferenceSpace(), viewer = reference && frame.getViewerPose(reference);
    if (!viewer) return;
    const position = new THREE.Vector3().copy(viewer.transform.position);
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion().copy(viewer.transform.orientation));
    forward.y = 0;
    if (forward.lengthSq() < 0.01) return;
    forward.normalize();
    this.needsPlacement = false;
    this.app.placeAround(position, Math.atan2(-forward.x, -forward.z));
  }

  recenter() { this.needsPlacement = true; }
}
