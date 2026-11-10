// What is drawn on the table, one row per stream that has a drawing: show or hide it, see whether it
// is arriving, open a camera as its own screen.
import {SIZE} from '../ui/holo.js';
import {Rect} from '../ui/rect.js';
import {hz} from '../util.js';

const GROUPS = [['robot', 'Robot'], ['rgbd', 'Depth cameras'], ['camera', 'Cameras'], ['cloud', 'Point clouds'], ['pose', 'Poses'], ['path', 'Paths'], ['grid', 'Maps'], ['frames', 'Frames']];

export function openLayers(app) {
  const id = 'layers';
  if (app.dock.has(id)) { app.dock.close(id); return; }
  const layers = app.layers;
  const panel = app.panel({
    id, title: 'Layers', glyph: 'layers', width: 0.4, height: 0.56, onClose: () => app.dock.close(id),
    draw(ui, content) {
      const all = layers.list();
      panel.tag = all.length ? `${all.filter(layer => layer.visible).length}/${all.length} ON` : '';
      if (!app.blueprint.running) { ui.empty(content, 'No blueprint is running.', 'Its streams appear here when one is.'); return; }
      if (!app.bus.live) { ui.empty(content, app.bus.state === 'connecting' ? 'Linking to the stream gateway…' : 'No stream link.', app.bus.error || ''); return; }
      if (!all.length) { ui.empty(content, 'None of this blueprint\'s streams has a drawing yet.', 'Clouds, images, poses, paths, maps, tf, URDF.'); return; }
      const actions = content.cutTop(42, 10).cols(2, 10);
      ui.button(actions[0], 'FIT TO TABLE', () => { layers.frameAll(); }, {id: 'fit', icon: 'scale', size: SIZE.sm});
      const robot = all.find(layer => layer.kind === 'robot');
      const root = robot?.model?.links[0]?.link;
      ui.button(actions[1], layers.follow ? 'FOLLOWING ROBOT' : 'FOLLOW ROBOT', () => { layers.follow = layers.follow ? null : root; }, {id: 'follow', icon: 'robot', size: SIZE.sm, on: !!layers.follow, enabled: !!root});
      ui.scroll(content, 'list', inner => {
        let y = inner.y;
        for (const [kind, title] of GROUPS) {
          const group = all.filter(layer => layer.kind === kind);
          if (!group.length) continue;
          ui.heading(new Rect(inner.x, y + 6, inner.w, 26), title, `${group.length}`); y += 38;
          for (const layer of group) {
            const row = new Rect(inner.x, y, inner.w, 58), topic = layer.topic ? app.blueprint.topics.get(layer.topic.key) : null;
            const hot = ui.row(row, {id: `layer:${layer.key}`, onClick: () => layers.toggle(layer.key), selected: layer.visible});
            ui.icon(layer.glyph, row.x + 24, row.cy, 22, ui.tone(layer.visible ? 'primary' : 'muted', hot ? 1 : 0.85));
            ui.text(layer.label, row.x + 48, row.y + 20, {size: SIZE.md, weight: 500, color: ui.tone(layer.visible ? 'fg' : 'muted'), max: row.w - 190});
            const status = !layer.visible ? 'hidden' : layer.live ? (layer.detail || 'live') : 'waiting for data';
            ui.text(`${status}${topic?.hz ? ` · ${hz(topic.hz)}` : ''}`, row.x + 48, row.y + 42, {size: SIZE.xs, family: 'mono', color: ui.tone(layer.visible && !layer.live ? 'warn' : 'muted'), max: row.w - 190});
            let right = row.r - 8;
            ui.icon(layer.visible ? 'eye' : 'eyeOff', right - 14, row.cy, 22, ui.tone(layer.visible ? 'primary' : 'muted')); right -= 40;
            if (layer.kind === 'robot') {
              const chips = new Rect(right - 132, row.y + 12, 132, 34);
              ui.chips(chips, [['holo', 'HOLO'], ['solid', 'SOLID']], layer.style, style => layer.setStyle(style), {id: `style:${layer.key}`, size: SIZE.xs});
            } else if (layer.colorTopic) {
              const feed = new Rect(right - 84, row.y + 12, 84, 34), open = app.dock.has(`feed:${layer.colorTopic.key}`);
              ui.button(feed, 'SCREEN', () => openFeed(app, layer.colorTopic), {id: `feed:${layer.key}`, size: SIZE.xs, on: open});
            }
            y += 58; ui.hair(inner.x, y, inner.r, y);
          }
        }
        return y - inner.y + 6;
      });
    },
  });
  layers.addEventListener('change', () => panel.invalidate(), {signal: panel.signal});
  for (const type of ['rates', 'modules', 'change']) app.blueprint.addEventListener(type, () => panel.invalidate(), {signal: panel.signal});
  app.bus.addEventListener('state', () => panel.invalidate(), {signal: panel.signal});
  const timer = setInterval(() => panel.invalidate(), 1000);
  panel.onDispose = () => clearInterval(timer);
  return app.dock.open(panel, 'left');
}

// One camera as a screen of its own: the same decoded video the table uses, drawn into a panel.
export function openFeed(app, topic) {
  const id = `feed:${topic.key}`;
  if (app.dock.has(id)) { app.dock.close(id); return; }
  const feed = app.layers.feeds.acquire(topic);
  const panel = app.panel({
    id, title: topic.topic.replace(/^\//, ''), glyph: 'camera', width: 0.44, height: 0.36, onClose: () => app.dock.close(id),
    draw(ui, content) {
      const video = feed.video, live = performance.now() - feed.lastAt < 1500;
      panel.tag = feed.width ? `${feed.width}×${feed.height}` : '';
      ui.ctx.fillStyle = ui.tone('bg', 0.9); ui.ctx.fillRect(content.x, content.y, content.w, content.h);
      if (video.readyState >= 2 && video.videoWidth) {
        const scale = Math.min(content.w / video.videoWidth, content.h / video.videoHeight), w = video.videoWidth * scale, h = video.videoHeight * scale;
        ui.ctx.drawImage(video, content.cx - w / 2, content.cy - h / 2, w, h);
      } else ui.empty(content, feed.error || 'Waiting for the first frame…');
      ui.lamp(content.x + 14, content.y + 14, live ? 'ok' : 'warn', !live);
      panel.invalidate();
    },
  });
  panel.minInterval = 66;
  panel.onDispose = () => app.layers.feeds.release(feed);
  return app.dock.open(panel, 'right');
}
