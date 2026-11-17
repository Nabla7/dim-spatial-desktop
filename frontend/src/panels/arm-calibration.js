// One canvas panel in desktop and immersive XR. Backend capability discovery supplies every profile
// and target; the panel contains no robot or headset-specific math.
import {SIZE} from '../ui/holo.js';
import {Rect} from '../ui/rect.js';
import {ArmCalibrationPreview} from '../scene/viz/arm-calibration.js';

export function openArmCalibration(app, sourcePanel = null) {
  const id = 'arm-calibration';
  if (app.dock.has(id)) { app.dock.close(id); return; }
  const c = app.controls.xr.calibration;
  const preview = new ArmCalibrationPreview(app);
  let confirmDelete = false;
  const panel = app.panel({id, title: 'ARM CALIBRATION', width: 0.7, height: 0.86,
    draw(ui, content) {
      ui.scroll(content, 'arm-calibration:body', inner => {
        let y = inner.y;
        const row = (h = 38, gap = 8) => { const r = new Rect(inner.x, y, inner.w, h); y += h + gap; return r; };
        const text = (message, tone = 'muted') => { const h = ui.wrap(message, new Rect(inner.x, y, inner.w, 0), {size: SIZE.sm, color: ui.tone(tone), maxLines: 5, lineHeight: 1.4}); y += h + 12; };
        const status = c.status, draft = status?.draft, captures = draft?.captures || {};
        preview.update(status);
        text(c.capturing ? 'CALIBRATING · ROBOT HELD' : status?.active ? 'CALIBRATION ACTIVE' : 'CALIBRATION NOT ACTIVE', c.capturing ? 'warn' : status?.active ? 'ok' : 'muted');
        if (!c.available) { text('This backend does not offer arm calibration.'); return y - inner.y; }
        if (!status) { text(c.error || c.readError || 'Reading calibration…'); return y - inner.y; }
        text('Shoulders, neutral grip and full reach are saved per operator, input method and robot. Up stays up; forward stays forward. Saving never starts movement.');
        ui.field(row(42), c.name, {id: 'cal:name', placeholder: 'Operator / profile name', onInput: value => { c.name = value; }});
        text(c.inputsReady ? `INPUT · TRACKED ${c.identity.input_kind.toUpperCase()}` : 'INPUT · WAITING FOR TRACKED HANDS OR CONTROLLERS');
        for (const p of c.profiles) {
          const compatible = c.compatible.some(item => item.id === p.id);
          ui.button(row(42), `${p.name} · ${p.input_kind}`, () => { c.selected = p.id; c.name = p.name; confirmDelete = false; },
            {id: `cal:profile:${p.id}`, size: SIZE.sm, on: p.id === c.selected, tone: compatible ? 'primary' : 'muted',
              sub: compatible ? `Saved ${new Date(p.saved_at * 1000).toLocaleString()}` : p.schema_version !== 2 ? 'Recalibrate with shoulders' : 'Different tracked input profile'});
        }
        const canCapture = app.controls.armed && app.xr.presenting && app.bus.live && c.inputsReady && !c.busy;
        ui.button(row(46), draft ? 'RESTART CALIBRATION' : 'CALIBRATE / RECALIBRATE', () => c.begin(),
          {id: 'cal:begin', enabled: canCapture && !c.countdown, tone: 'primary', size: SIZE.sm});
        if (!app.xr.presenting) text('Enter VR or MIXED to capture poses. Saved profiles can be reviewed here on desktop.');
        else if (!app.controls.armed) text('Arm the controls to capture. Calibration itself holds the robot still.');
        else if (!c.inputsReady) text('Waiting for both tracked hands or controllers.');
        if (draft) {
          for (const side of ['left', 'right']) {
            const quality = status.tracking?.[side];
            text(`${side.toUpperCase()} · ${quality?.reason || 'Waiting for tracking'}${quality?.spread_m != null ? ` · ${(quality.spread_m * 1000).toFixed(0)} mm variation` : ''}`, quality?.ready && status.head_fresh ? 'ok' : 'warn');
          }
          text('Look forward and keep your head and body still during each capture. First place each tracked wrist or controller grip center at its own shoulder. Then capture neutral with hands in front, elbows bent and grips level, pointing forward.');
          const stages = [['shoulders', '1 · CAPTURE SHOULDERS'], ['neutral', '2 · CAPTURE NEUTRAL'], ['left_reach', '3 · CAPTURE LEFT REACH'], ['right_reach', '4 · CAPTURE RIGHT REACH']];
          for (const [stage, label] of stages) {
            const waiting = c.countdown?.stage === stage;
            ui.button(row(46), waiting ? `HOLD POSE · ${Math.max(0, Math.ceil((c.countdown.until - performance.now()) / 1000))}` : `${captures[stage] ? '✓ ' : ''}${label}`,
              () => c.capture(stage), {id: `cal:capture:${stage}`, size: SIZE.sm, tone: captures[stage] ? 'ok' : 'primary',
                enabled: c.capturing && !c.busy && !c.countdown && (stage === 'shoulders' || (stage === 'neutral' ? !!captures.shoulders : !!captures.neutral))});
          }
          text('For each reach, extend that arm straight forward comfortably at shoulder height. Grip angle does not set reach direction. Each capture waits 3 seconds so you can leave the button and hold still.');
        }
        for (const [side, review] of Object.entries(status.review || {})) {
          text(`${side.toUpperCase()} · reach gain ${review.scale.toFixed(2)}× · your arm ${(review.human_reach_m * 100).toFixed(1)} cm → robot wrist reach ${(review.robot_reach_m * 100).toFixed(1)} cm`, 'fg');
        }
        for (const side of ['left', 'right']) {
          const target = status.preview?.[side]?.position, actual = status.actual?.[side]?.position;
          if (status.limited?.[side]) text(`${side.toUpperCase()} · OUTSIDE WRIST REACH · target held at boundary`, 'warn');
          if (target && actual) {
            const error = Math.hypot(...target.map((value, i) => value - actual[i])) * 100;
            text(`${side.toUpperCase()} · target-to-robot distance ${error.toFixed(1)} cm`, error > 5 ? 'warn' : 'ok');
          }
        }
        // A top-down diagram of the robot's declared grasp-point anchors. Same SI coordinates as IK.
        const diagram = row(130), ctx = ui.ctx;
        if (ctx && status.targets) {
          for (const [side, anchors] of Object.entries(status.targets)) {
            const points = [anchors.neutral.position, anchors.reach.position].map(p => [diagram.cx - p[1] * 300, diagram.b - p[0] * 120]);
            ctx.strokeStyle = ui.tone('primary'); ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(...points[0]); ctx.lineTo(...points[1]); ctx.stroke();
            for (const [index, p] of points.entries()) { ctx.beginPath(); ctx.arc(p[0], p[1], index ? 7 : 4, 0, Math.PI * 2); ctx.stroke(); }
            ui.text(side.toUpperCase(), points[0][0], diagram.b - 8, {size: SIZE.xs, align: 'center', color: ui.tone('muted')});
          }
        }
        text('Robot grasp targets, top view: small dot = neutral; large dot = full reach. The body moves these targets with it.');
        text('The same targets appear on the robot in 3D. Hollow spheres mark your mapped neutral and full reach. Solid spheres show current targets; small white spheres show measured grippers. All four captures are required.');
        const complete = ['shoulders', 'neutral', 'left_reach', 'right_reach'].every(stage => captures[stage]);
        if (draft) ui.button(row(44), 'SAVE CALIBRATION', () => c.save(), {id: 'cal:save', enabled: complete && !c.busy, size: SIZE.sm, tone: 'ok'});
        if (draft || c.capturing) ui.button(row(40), 'CANCEL CAPTURE', () => c.cancel(), {id: 'cal:cancel', enabled: !c.busy, size: SIZE.sm, tone: 'muted'});
        if (!draft && c.selected) {
          ui.button(row(44), 'USE PROFILE', async () => { app.controls.xr.stop(); await app.controls.xr.start(); },
            {id: 'cal:use', enabled: canCapture && c.compatible.some(p => p.id === c.selected), size: SIZE.sm, tone: 'primary'});
          ui.button(row(40), confirmDelete ? 'CONFIRM DELETE PROFILE' : 'DELETE PROFILE', () => { if (confirmDelete) { void c.remove(); confirmDelete = false; } else confirmDelete = true; },
            {id: 'cal:delete', enabled: !c.busy, size: SIZE.sm, tone: 'danger'});
        }
        if (c.error || c.readError) text(c.error || c.readError, 'danger');
        if (!draft) text('After using a profile, release and re-press your normal arm-enable control. Arms follow your live headset heading and position. Head-only turns also change this reference. Re-enable after resetting tracking.');
        return y - inner.y;
      });
    },
  });
  app.controls.addEventListener('change', () => panel.invalidate(), {signal: panel.signal});
  app.xr.addEventListener('change', () => panel.invalidate(), {signal: panel.signal});
  const timer = setInterval(() => { void c.refresh(); panel.invalidate(); }, 500);
  panel.onDispose = () => { clearInterval(timer); preview.dispose(); c.countdown = null; if (c.capturing) void c.cancel(); };
  void c.refresh();
  app.dock.open(panel, 'left');
  // Keep the capture workflow in the same field of view as its entry button in XR.
  // Closing Control would disarm the lease, so this is a free overlay in front of it.
  if (sourcePanel) {
    panel.group.position.copy(sourcePanel.group.position);
    panel.group.quaternion.copy(sourcePanel.group.quaternion);
    panel.group.translateZ(0.04);
    app.dock.release(panel);
  }
  return panel;
}
