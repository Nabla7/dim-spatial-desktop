// How the world sits on the table: its scale, whether it is cut at the table's edge, life size.
import {SIZE} from '../ui/holo.js';

export function openView(app) {
  const id = 'view';
  if (app.dock.has(id)) { app.dock.close(id); return; }
  const stage = app.stage;
  const panel = app.panel({
    id, title: 'View', glyph: 'scale', width: 0.36, height: 0.4, onClose: () => app.dock.close(id),
    draw(ui, content) {
      const scale = stage.target.scale;
      panel.tag = stage.lifeSize ? '1 : 1' : `1 : ${scale >= 1 ? scale.toFixed(1) : (1 / scale).toFixed(scale < 0.02 ? 0 : 1)}`;
      ui.heading(content.cutTop(26, 8), 'Scale', scale >= 1 ? `${scale.toFixed(2)}×` : `1 m → ${(scale * 100).toFixed(1)} cm`);
      // The slider is logarithmic: one notch is the same zoom anywhere along it.
      ui.slider(content.cutTop(44, 6), Math.log10(scale), Math.log10(0.002), Math.log10(4), value => { stage.target.scale = 10 ** value; if (stage.lifeSize) stage.setLifeSize(false); },
        {id: 'scale', format: value => (10 ** value >= 1 ? `${(10 ** value).toFixed(1)}×` : `1:${(1 / 10 ** value).toFixed(0)}`)});
      const steps = content.cutTop(44, 14).cols(4, 8);
      ui.button(steps[0], '', () => stage.scaleAbout(0.8), {id: 'smaller', icon: 'minus'});
      ui.button(steps[1], '', () => stage.scaleAbout(1.25), {id: 'larger', icon: 'plus'});
      ui.button(steps[2], 'FIT', () => { stage.setLifeSize(false); app.layers.frameAll(); }, {id: 'fit', size: SIZE.sm});
      ui.button(steps[3], '1 : 1', () => stage.setLifeSize(!stage.lifeSize), {id: 'life', size: SIZE.sm, on: stage.lifeSize, tone: 'alt'});
      ui.heading(content.cutTop(26, 8), 'Table');
      ui.toggle(content.cutTop(40, 4), 'Cut the world at the table\'s edge', stage.clipping, on => stage.setClipping(on), {id: 'clip', enabled: !stage.lifeSize});
      ui.toggle(content.cutTop(40, 4), 'Show the module ring', app.halo.enabled, on => { app.halo.enabled = on; }, {id: 'halo'});
      const actions = content.cutTop(44, 0).cols(2, 8);
      ui.button(actions[0], 'LEVEL & CENTRE', () => { stage.target.yaw = 0; app.layers.frameAll(); }, {id: 'level', size: SIZE.sm});
      if (app.xr.presenting) ui.button(actions[1], 'BRING TO ME', () => app.xr.recenter(), {id: 'recenter', size: SIZE.sm, icon: 'home'});
      else ui.button(actions[1], 'RESET CAMERA', () => app.resetCamera(), {id: 'camera', size: SIZE.sm, icon: 'home'});
    },
  });
  const timer = setInterval(() => panel.invalidate(), 500);
  panel.onDispose = () => clearInterval(timer);
  return app.dock.open(panel, 'right');
}
