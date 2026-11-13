// One camera as a screen of its own. It is what an operator looks at while driving from somewhere else,
// so it stays: a screen starts kept (no other panel that opens takes its place), it has four sizes, and the
// screens that were open come back when the same blueprint runs again.
// The picture is the camera's video itself on a surface in front of the panel (the texture the table
// uses), not a copy drawn into the panel's canvas: it shows every frame the stream has, at any size.
import * as THREE from 'three';
import {UNITS_PER_METRE} from '../ui/holo.js';

const WIDTHS = {s: 0.3, m: 0.44, l: 0.62, xl: 0.86}, SIZES = Object.keys(WIDTHS);
// A panel's title bar and its edge, in metres (the content rectangle of ui/holo.js's chrome).
const TITLE = 70 / UNITS_PER_METRE, EDGE = 18 / UNITS_PER_METRE;
const STORE = 'spatial.screens';   // {blueprint: {topic key: {size, aspect}}}: the screens the user keeps

const load = () => { try { return JSON.parse(localStorage.getItem(STORE) || '{}'); } catch { return {}; } };
const save = all => { try { localStorage.setItem(STORE, JSON.stringify(all)); } catch { /* private mode */ } };
function remember(app, key, values) {
  const all = load(), name = app.blueprint.name;
  if (!name) return;
  (all[name] ||= {})[key] = {...all[name][key], ...values}; save(all);
}
function forget(app, key) {
  const all = load(), name = app.blueprint.name;
  if (!all[name]?.[key]) return;
  delete all[name][key]; if (!Object.keys(all[name]).length) delete all[name];
  save(all);
}

// The panel that holds a picture of this shape at this size, no taller than a side of the screen.
function measure(size, aspect, limit) {
  let width = WIDTHS[size], height = (width - 2 * EDGE) / aspect + TITLE + EDGE;
  if (height > limit) { height = limit; width = (height - TITLE - EDGE) * aspect + 2 * EDGE; }
  return {width, height};
}

// SCREEN on a camera's row: opens its screen, or puts it away (toggle).
export function openScreen(app, topic, {toggle = true} = {}) {
  const id = `feed:${topic.key}`;
  if (app.dock.has(id)) { if (toggle) { forget(app, topic.key); app.dock.close(id); } return; }
  const known = load()[app.blueprint.name]?.[topic.key];
  build(app, topic, {size: WIDTHS[known?.size] ? known.size : 'm', aspect: known?.aspect > 0 ? known.aspect : 4 / 3}, false);
}

function build(app, topic, state, again) {
  const id = `feed:${topic.key}`, feed = app.layers.feeds.acquire(topic);
  const {width, height} = measure(state.size, state.aspect, app.dock.sideHeight());
  let resizing = false, shown = null, playing = false;
  // Another size, or the shape of the video now that it is known: the panel is made again in the same place.
  const resize = () => {
    if (resizing || panel.closing) return;
    resizing = true;
    setTimeout(() => { if (!panel.closing && app.dock.get(id) === panel) build(app, topic, state, true); });
  };
  const panel = app.panel({
    id, title: topic.topic.replace(/^\//, ''), glyph: 'camera', width, height, kept: true,
    onClose: () => { forget(app, topic.key); app.dock.close(id); },
    tools: [{id: 'size', label: state.size.toUpperCase(), hint: 'SIZE OF THE SCREEN', onClick: () => { state.size = SIZES[(SIZES.indexOf(state.size) + 1) % SIZES.length]; resize(); }}],
    draw(ui, content) {
      ui.ctx.fillStyle = ui.tone('bg', 0.9); ui.ctx.fillRect(content.x, content.y, content.w, content.h);
      if (!playing) ui.empty(content, feed.error || 'Waiting for the first frame…');
    },
  });
  const picture = new THREE.Mesh(new THREE.PlaneGeometry(width - 2 * EDGE, height - TITLE - EDGE), new THREE.MeshBasicMaterial({map: feed.texture, toneMapped: false}));
  picture.position.set(0, (EDGE - TITLE) / 2, 0.0008); picture.renderOrder = 31; picture.visible = false;
  panel.group.add(picture);
  panel.onFrame = now => {
    const video = feed.video, ready = video.readyState >= 2 && video.videoWidth > 0, stalled = ready && now - feed.lastAt > 1500;
    // The picture comes when the panel has finished opening and goes when it starts to close.
    playing = ready; picture.visible = ready && !panel.closing && now - panel.opened > 420;
    picture.material.color.setScalar(stalled ? 0.4 : 1);
    // The gateway's encoder changes the picture's size as the link allows, and rounds it: only another shape counts.
    if (ready && Math.abs(video.videoWidth / video.videoHeight / state.aspect - 1) > 0.04) { state.aspect = video.videoWidth / video.videoHeight; resize(); }
    const next = `${picture.visible}|${stalled}|${video.videoWidth}x${video.videoHeight}`;
    if (next === shown) return;
    shown = next;
    panel.tag = !ready ? '' : stalled ? 'NO FRAMES' : `${video.videoWidth}×${video.videoHeight}`;
    panel.invalidate();
  };
  // Only a kept screen is one to bring back; one the user lets go of is shown this once.
  panel.onKept = kept => kept ? remember(app, topic.key, state) : forget(app, topic.key);
  panel.onDispose = () => { app.layers.feeds.release(feed); picture.geometry.dispose(); picture.material.dispose(); };
  if (again) app.dock.swap(panel); else app.dock.open(panel, 'right');
  if (panel.kept) remember(app, topic.key, state);
  return panel;
}

// When a blueprint runs again, the screens the user kept for it open again, once its cameras are known.
export function watchScreens(app) {
  let restoredFor = null;
  app.blueprint.addEventListener('change', () => { if (!app.blueprint.running) restoredFor = null; });
  app.layers.addEventListener('change', () => {
    const blueprint = app.blueprint, run = blueprint.runId || blueprint.name;
    if (!blueprint.running || !run || restoredFor === run) return;
    const cameras = new Map(app.layers.list().filter(layer => layer.colorTopic).map(layer => [layer.colorTopic.key, layer.colorTopic]));
    if (!cameras.size) return;   // the cameras are not known yet
    restoredFor = run;
    for (const key of Object.keys(load()[blueprint.name] || {})) if (cameras.has(key)) openScreen(app, cameras.get(key), {toggle: false});
  });
}
