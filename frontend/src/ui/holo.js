// Holographic panels: a canvas drawn in immediate mode, shown on a plane in the 3D scene.
// The same panel works under a mouse, an XR controller ray and a tracked hand, since all three
// reach it as a point on its surface. There is no DOM in an immersive session, so there is none here.
import * as THREE from 'three';
import {Rect} from './rect.js';
import {icons} from './icons.js';

export const UNITS_PER_METRE = 1500; // layout units: a panel 0.4 m wide is 600 units across at any resolution
export const SIZE = {xs: 15, sm: 18, md: 21, lg: 26, xl: 34};
const TITLE_H = 58, PAD = 18;

const vertexShader = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

// The canvas, plus what makes it read as projected light: scanlines, a slow rolling band,
// a wipe when it opens, and a soft spot under each pointer.
const fragmentShader = /* glsl */`
uniform sampler2D map;
uniform float time, reveal, opacity, lines, aspect;
uniform vec3 tint;
uniform vec3 pointerA, pointerB;
varying vec2 vUv;
float spot(vec3 p) {
  vec2 d = (vUv - p.xy) * vec2(aspect, 1.0);
  return p.z * exp(-dot(d, d) * 70.0);
}
void main() {
  vec4 tex = texture2D(map, vUv);
  float y = 1.0 - vUv.y;
  float front = reveal * 1.06;
  float shown = 1.0 - smoothstep(front - 0.015, front, y);
  float edge = exp(-pow((y - front) * 46.0, 2.0)) * (1.0 - step(0.999, reveal));
  float scan = 1.0 - 0.06 * (0.5 + 0.5 * sin(y * lines * 3.14159265));
  float roll = 0.05 * exp(-pow((fract(y - time * 0.06) - 0.5) * 10.0, 2.0));
  float light = spot(pointerA) + spot(pointerB);
  vec3 color = tex.rgb * scan + tint * (roll * tex.a + light * 0.20 + edge);
  float alpha = (tex.a + light * 0.08) * shown + edge * 0.85;
  gl_FragColor = vec4(color, alpha * opacity);
  #include <colorspace_fragment>
}`;

const wrapCache = new Map();

export class HoloPanel {
  // width/height in metres. draw(ui, content) lays the panel out; it runs only when the panel is invalidated.
  // bare: no title bar (a toolbar, a status strip); the whole background is then the handle.
  constructor(theme, {id, title = '', tag = '', width = 0.42, height = 0.5, ppm = 1800, draw, onClose = null, glyph = 'grid', bare = false}) {
    this.theme = theme; this.id = id; this.title = title; this.tag = tag; this.glyph = glyph; this.bare = bare;
    this.width = width; this.height = height; this.draw = draw; this.onClose = onClose;
    this.dw = width * UNITS_PER_METRE; this.dh = height * UNITS_PER_METRE;
    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.round(width * ppm); this.canvas.height = Math.round(height * ppm);
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 8;
    this.uniforms = {
      map: {value: this.texture}, time: {value: 0}, reveal: {value: 0}, opacity: {value: 1},
      lines: {value: this.canvas.height / 3}, aspect: {value: width / height},
      tint: {value: theme.three.primary.clone()},
      pointerA: {value: new THREE.Vector3()}, pointerB: {value: new THREE.Vector3()},
    };
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader, fragmentShader, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    }));
    this.mesh.renderOrder = 30; this.mesh.userData.panel = this;
    this.group = new THREE.Group(); this.group.add(this.mesh); this.group.userData.panel = this;
    this.regions = []; this.hots = new Map(); this.presses = new Map(); this.scrolls = new Map();
    this.dirty = true; this.lastDraw = 0; this.minInterval = 50; this.opened = performance.now(); this.closing = 0;
    this.focusId = null; this.busy = false;
    // Listeners a panel adds with {signal: panel.signal} go when the panel does.
    this.abort = new AbortController(); this.signal = this.abort.signal;
  }

  invalidate() { this.dirty = true; }

  // -- drawing --------------------------------------------------------------------------------------
  update(now) {
    const u = this.uniforms;
    u.time.value = now / 1000;
    u.reveal.value = this.closing
      ? Math.max(0, 1 - (now - this.closing) / 220)
      : Math.min(1, (now - this.opened) / 420);
    u.tint.value.copy(this.theme.three.primary);
    let slot = 0;
    for (const pointer of [u.pointerA.value, u.pointerB.value]) pointer.z = 0;
    for (const hot of this.hots.values()) {
      if (slot > 1) break;
      (slot++ ? u.pointerB.value : u.pointerA.value).set(hot.x / this.dw, 1 - hot.y / this.dh, 1);
    }
    if (!this.dirty || now - this.lastDraw < this.minInterval || !this.group.visible) return;
    this.dirty = false; this.lastDraw = now;
    const ctx = this.ctx, k = this.canvas.width / this.dw;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.clearRect(0, 0, this.dw, this.dh);
    this.regions = [];
    const ui = new Ui(this);
    const content = ui.chrome();
    try { this.draw(ui, content); } catch (error) {
      console.error(`panel ${this.id}:`, error);
      ui.text(String(error.message || error), content.x, content.y + 20, {color: this.theme.c('danger'), size: SIZE.sm});
    }
    this.texture.needsUpdate = true;
  }

  // -- pointers (x, y in layout units) --------------------------------------------------------------
  regionAt(x, y, want = null) {
    for (let i = this.regions.length - 1; i >= 0; i--) {
      const region = this.regions[i];
      if (want && !region[want]) continue;
      if (region.rect.contains(x, y) && (!region.clip || region.clip.contains(x, y))) return region;
    }
    return null;
  }

  pointerMove(pointer, x, y) {
    const region = this.regionAt(x, y), before = this.hots.get(pointer)?.id;
    this.hots.set(pointer, {x, y, id: region?.id ?? null});
    if (before !== (region?.id ?? null)) this.invalidate();
    const press = this.presses.get(pointer);
    if (!press) return;
    if (press.region.onDrag) { press.region.onDrag(x, y, press); this.invalidate(); return; }
    // A press that travels inside a scroll area scrolls it and is no longer a click.
    const moved = Math.hypot(x - press.x, y - press.y);
    if (!press.scrolling && moved > 14 && press.scroll) press.scrolling = true;
    if (press.scrolling) {
      const state = this.scrolls.get(press.scroll.scrollId);
      state.offset = press.offset - (y - press.y); state.stick = false; this.invalidate();
    }
  }

  // Returns 'grab' when the title bar was pressed (the caller then moves the panel), else whether anything was hit.
  pointerDown(pointer, x, y) {
    const region = this.regionAt(x, y), scroll = this.regionAt(x, y, 'scrollId');
    if (this.focusId && region?.id !== this.focusId) { this.focusId = null; this.onBlur?.(); }
    this.presses.set(pointer, {region: region ?? {}, x, y, scroll, offset: scroll ? this.scrolls.get(scroll.scrollId).offset : 0});
    if (region?.onDown) region.onDown(x, y);
    this.invalidate();
    return region?.grab ? 'grab' : !!region;
  }

  pointerUp(pointer, x, y) {
    const press = this.presses.get(pointer);
    this.presses.delete(pointer);
    this.invalidate();
    if (!press || press.scrolling) return;
    const region = x === null ? null : this.regionAt(x, y);
    if (region && region.id === press.region.id && region.onClick) region.onClick(x, y);
  }

  pointerLeave(pointer) {
    if (this.hots.delete(pointer)) this.invalidate();
  }

  scroll(x, y, delta) {
    const region = this.regionAt(x, y, 'scrollId');
    if (!region) return false;
    const state = this.scrolls.get(region.scrollId);
    state.offset += delta; state.stick = false; this.invalidate();
    return true;
  }

  close() { if (!this.closing) this.closing = performance.now(); }
  get closed() { return this.closing && performance.now() - this.closing > 220; }

  dispose() {
    this.abort.abort(); this.onDispose?.();
    this.group.removeFromParent(); this.texture.dispose(); this.mesh.geometry.dispose(); this.mesh.material.dispose();
  }
}

// One redraw of one panel. Widgets draw themselves and register the regions that pointers can hit.
export class Ui {
  constructor(panel) {
    this.panel = panel; this.ctx = panel.ctx; this.theme = panel.theme;
    this.clip = null; this.shift = 0; this.now = performance.now();
  }

  font(size = SIZE.md, family = 'sans', weight = 400) { return `${weight} ${size}px ${this.theme.font[family]}`; }
  tone(name, alpha = 1) { return this.theme.c(name, alpha); }

  isHot(id) { for (const hot of this.panel.hots.values()) if (hot.id === id) return true; return false; }
  isDown(id) { for (const press of this.panel.presses.values()) if (press.region.id === id && !press.scrolling) return true; return false; }

  region(rect, handlers) {
    const absolute = this.shift ? new Rect(rect.x, rect.y - this.shift, rect.w, rect.h) : rect;
    const panel = this.panel, wrap = handler => handler && ((...args) => { handler(...args); panel.invalidate(); });
    panel.regions.push({...handlers, rect: absolute, clip: this.clip,
      onClick: wrap(handlers.onClick), onDrag: wrap(handlers.onDrag), onDown: wrap(handlers.onDown)});
  }

  // -- text -----------------------------------------------------------------------------------------
  text(string, x, y, {size = SIZE.md, family = 'sans', weight = 400, color = this.tone('fg'), align = 'left',
    baseline = 'middle', max = 0, track = 0} = {}) {
    const ctx = this.ctx;
    ctx.font = this.font(size, family, weight); ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = baseline;
    ctx.letterSpacing = track ? `${track}px` : '0px';
    string = String(string ?? '');
    if (max > 0) string = this.fit(string, max);
    ctx.fillText(string, x, y);
    return ctx.measureText(string).width;
  }

  // The text cut to a width, ending in an ellipsis. ctx.font must be set.
  fit(string, max) {
    const ctx = this.ctx;
    if (ctx.measureText(string).width <= max) return string;
    let low = 0, high = string.length;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (ctx.measureText(string.slice(0, mid) + '…').width <= max) low = mid; else high = mid - 1;
    }
    return string.slice(0, low) + '…';
  }

  lines(string, width, font) {
    const key = `${font}|${width | 0}|${string}`;
    let lines = wrapCache.get(key);
    if (lines) return lines;
    const ctx = this.ctx; ctx.font = font; ctx.letterSpacing = '0px';
    lines = [];
    for (const paragraph of String(string ?? '').split('\n')) {
      let line = '';
      for (const word of paragraph.split(/(\s+)/)) {
        if (ctx.measureText(line + word).width <= width || !line) { line += word; continue; }
        lines.push(line.trimEnd()); line = word.trimStart();
        // A single word wider than the column (a path, a topic) breaks by character.
        while (ctx.measureText(line).width > width && line.length > 1) {
          let n = line.length;
          while (n > 1 && ctx.measureText(line.slice(0, n)).width > width) n--;
          lines.push(line.slice(0, n)); line = line.slice(n);
        }
      }
      lines.push(line.trimEnd());
    }
    if (wrapCache.size > 4000) wrapCache.clear();
    wrapCache.set(key, lines);
    return lines;
  }

  // Wrapped text from the rect's top; returns the height it used. measure: lay out without drawing.
  wrap(string, rect, {size = SIZE.md, family = 'sans', weight = 400, color = this.tone('fg'), lineHeight = 1.35,
    maxLines = Infinity, measure = false} = {}) {
    const font = this.font(size, family, weight), lines = this.lines(string, rect.w, font), step = size * lineHeight;
    const count = Math.min(lines.length, maxLines);
    if (!measure) {
      const ctx = this.ctx;
      ctx.font = font; ctx.fillStyle = color; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.letterSpacing = '0px';
      for (let i = 0; i < count; i++) {
        const last = i === count - 1 && lines.length > count;
        ctx.fillText(last ? this.fit(lines[i] + '…', rect.w) : lines[i], rect.x, rect.y + step * (i + 0.5));
      }
    }
    return count * step;
  }

  // -- shapes ---------------------------------------------------------------------------------------
  // A rectangle with its top-left and bottom-right corners cut.
  chamfer(rect, cut = 9) {
    const {x, y, r, b} = rect, ctx = this.ctx, c = Math.min(cut, rect.h / 2, rect.w / 2);
    ctx.beginPath();
    ctx.moveTo(x + c, y); ctx.lineTo(r, y); ctx.lineTo(r, b - c); ctx.lineTo(r - c, b); ctx.lineTo(x, b); ctx.lineTo(x, y + c);
    ctx.closePath();
  }

  hair(x1, y1, x2, y2, color = this.tone('hair'), width = 1) {
    const ctx = this.ctx;
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }

  icon(name, cx, cy, size, color) {
    const ctx = this.ctx;
    ctx.save(); ctx.translate(cx, cy); ctx.scale(size / 24, size / 24);
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1.8; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    (icons[name] || icons.dot)(ctx);
    ctx.restore();
  }

  // -- the panel's own frame; returns the content rect ----------------------------------------------
  chrome() {
    const {panel, ctx, theme} = this, {dw: w, dh: h} = panel, full = new Rect(1.5, 1.5, w - 3, h - 3);
    if (panel.bare) {
      this.chamfer(full, 14);
      ctx.fillStyle = theme.c('surface', 0.80); ctx.fill();
      ctx.strokeStyle = this.tone('primary', 0.34); ctx.lineWidth = 1.5; ctx.stroke();
      ctx.strokeStyle = this.tone('primary', 0.95); ctx.lineWidth = 3; ctx.beginPath();
      ctx.moveTo(w - 22, 1.5); ctx.lineTo(w - 1.5, 1.5); ctx.lineTo(w - 1.5, 22);
      ctx.moveTo(1.5, h - 22); ctx.lineTo(1.5, h - 1.5); ctx.lineTo(22, h - 1.5);
      ctx.stroke();
      this.region(new Rect(0, 0, w, h), {id: '@title', grab: true});
      return new Rect(12, 10, w - 24, h - 20);
    }
    this.chamfer(full, 22);
    const glass = ctx.createLinearGradient(0, 0, 0, h);
    glass.addColorStop(0, theme.mix('surface', 'primary', 0.07, 0.86));
    glass.addColorStop(0.35, theme.c('surface', 0.80));
    glass.addColorStop(1, theme.c('bg', 0.84));
    ctx.fillStyle = glass; ctx.fill();
    // A dot lattice, so the glass has depth where it is empty.
    ctx.save(); ctx.clip(); ctx.fillStyle = this.tone('primary', 0.055);
    for (let y = TITLE_H + 14; y < h; y += 22) for (let x = 14; x < w; x += 22) ctx.fillRect(x, y, 1.6, 1.6);
    ctx.restore();
    this.chamfer(full, 22); ctx.strokeStyle = this.tone('primary', 0.34); ctx.lineWidth = 1.5; ctx.stroke();
    // Corner brackets.
    ctx.strokeStyle = this.tone('primary', 0.95); ctx.lineWidth = 3; ctx.beginPath();
    ctx.moveTo(w - 30, 1.5); ctx.lineTo(w - 1.5, 1.5); ctx.lineTo(w - 1.5, 30);
    ctx.moveTo(1.5, h - 30); ctx.lineTo(1.5, h - 1.5); ctx.lineTo(30, h - 1.5);
    ctx.stroke();
    // Title bar: the handle a pointer grabs to move the panel.
    const bar = new Rect(0, 0, w, TITLE_H);
    this.region(bar, {id: '@title', grab: true});
    const hot = this.isHot('@title');
    const sweep = ctx.createLinearGradient(0, 0, w, 0);
    sweep.addColorStop(0, this.tone('primary', hot ? 0.22 : 0.13)); sweep.addColorStop(1, this.tone('primary', 0));
    ctx.fillStyle = sweep; ctx.fillRect(24, 3, w - 27, TITLE_H - 3);
    this.hair(PAD, TITLE_H, w - PAD, TITLE_H, this.tone('primary', 0.3));
    this.icon(panel.glyph, 42, TITLE_H / 2 + 2, 26, this.tone('primary'));
    let right = w - PAD;
    if (panel.onClose) {
      const close = new Rect(right - 40, 10, 40, 40); right -= 48;
      const over = this.isHot('@close');
      this.icon('close', close.cx, close.cy, 22, this.tone(over ? 'danger' : 'muted'));
      this.region(close, {id: '@close', onClick: () => panel.onClose()});
    }
    if (panel.tag) right -= this.text(panel.tag, right, TITLE_H / 2 + 2, {size: SIZE.xs, family: 'mono', color: this.tone('muted'), align: 'right'}) + 12;
    this.text(theme.label(panel.title), 66, TITLE_H / 2 + 3, {size: SIZE.sm, family: 'display', color: this.tone('primary'), track: 3, max: right - 70});
    if (panel.busy) {
      const t = (this.now / 900) % 1;
      this.hair(PAD + (w - 2 * PAD) * t * 0.7, TITLE_H, PAD + (w - 2 * PAD) * (t * 0.7 + 0.3), TITLE_H, this.tone('primary'), 2.5);
      panel.invalidate();
    }
    return new Rect(PAD, TITLE_H + 12, w - 2 * PAD, h - TITLE_H - 12 - PAD);
  }

  // -- widgets --------------------------------------------------------------------------------------
  heading(rect, label, right = '') {
    this.text(this.theme.label(label), rect.x, rect.cy, {size: SIZE.xs, family: 'display', color: this.tone('muted'), track: 2.5});
    if (right) this.text(right, rect.r, rect.cy, {size: SIZE.xs, family: 'mono', color: this.tone('muted'), align: 'right'});
    this.hair(rect.x, rect.b - 1, rect.r, rect.b - 1);
  }

  button(rect, label, onClick, {id = `b:${label}`, tone = 'primary', enabled = true, on = false, icon = null,
    size = SIZE.md, align = 'center', sub = ''} = {}) {
    const ctx = this.ctx, hot = enabled && this.isHot(id), down = enabled && this.isDown(id);
    this.chamfer(rect, Math.min(9, rect.h / 4));
    ctx.fillStyle = on ? this.tone(tone, down ? 1 : 0.88) : this.tone(tone, !enabled ? 0.02 : down ? 0.34 : hot ? 0.17 : 0.06);
    if (hot) { ctx.shadowColor = this.tone(tone, 0.9); ctx.shadowBlur = 16; }
    ctx.fill(); ctx.shadowBlur = 0;
    ctx.strokeStyle = enabled ? this.tone(tone, hot || on ? 1 : 0.5) : this.tone('muted', 0.22); ctx.lineWidth = 1.5; ctx.stroke();
    const color = on ? this.tone('primaryFg') : !enabled ? this.tone('muted', 0.5) : hot ? this.tone('fg') : this.theme.mix(tone, 'fg', 0.45);
    let x = align === 'center' ? rect.cx : rect.x + 14;
    if (icon) {
      const iconX = align === 'center' && label ? rect.cx - this.measure(label, size, 600) / 2 - size * 0.25 : align === 'center' ? rect.cx : rect.x + 14 + size / 2;
      this.icon(icon, iconX, rect.cy, size * 1.05, color);
      if (align === 'center' && label) x = rect.cx + size * 0.6; else x += size * 1.5;
    }
    if (label) this.text(label, x, rect.cy + (sub ? -size * 0.42 : 1), {size, weight: 600, color, align, max: rect.w - (icon ? size * 2.2 : 16)});
    if (sub) this.text(sub, x, rect.cy + size * 0.62, {size: SIZE.xs, family: 'mono', color: on ? this.tone('primaryFg', 0.75) : this.tone('muted'), align, max: rect.w - 20});
    if (enabled && onClick) this.region(rect, {id, onClick});
    else this.region(rect, {id});
  }

  measure(string, size = SIZE.md, weight = 400, family = 'sans') {
    this.ctx.font = this.font(size, family, weight); this.ctx.letterSpacing = '0px';
    return this.ctx.measureText(string).width;
  }

  // A two-state switch with its label on the left.
  toggle(rect, label, value, onChange, {id = `t:${label}`, tone = 'primary', enabled = true} = {}) {
    const ctx = this.ctx, hot = enabled && this.isHot(id), track = new Rect(rect.r - 54, rect.cy - 12, 54, 24);
    this.text(label, rect.x, rect.cy + 1, {size: SIZE.md, color: this.tone(enabled ? 'fg' : 'muted'), max: rect.w - 66});
    this.chamfer(track, 6);
    ctx.fillStyle = value ? this.tone(tone, 0.28) : this.tone('input', 0.9); ctx.fill();
    ctx.strokeStyle = this.tone(value ? tone : 'muted', hot ? 1 : 0.6); ctx.lineWidth = 1.5; ctx.stroke();
    ctx.fillStyle = value ? this.tone(tone) : this.tone('muted', 0.8);
    if (value) { ctx.shadowColor = this.tone(tone); ctx.shadowBlur = 10; }
    ctx.fillRect(value ? track.r - 24 : track.x + 4, track.y + 4, 20, 16); ctx.shadowBlur = 0;
    this.region(rect, {id, onClick: enabled ? () => onChange(!value) : null});
  }

  slider(rect, value, min, max, onChange, {id, tone = 'primary', step = 0, format = v => v.toFixed(2)} = {}) {
    const ctx = this.ctx, hot = this.isHot(id) || this.isDown(id), rail = new Rect(rect.x + 6, rect.cy - 2, rect.w - 96, 4);
    const t = Math.max(0, Math.min(1, (value - min) / (max - min || 1)));
    ctx.fillStyle = this.tone('muted', 0.3); ctx.fillRect(rail.x, rail.y, rail.w, rail.h);
    ctx.fillStyle = this.tone(tone, 0.9); ctx.fillRect(rail.x, rail.y, rail.w * t, rail.h);
    for (let i = 0; i <= 10; i++) ctx.fillRect(rail.x + rail.w * i / 10 - 0.5, rail.y + 8, 1, i % 5 ? 4 : 8);
    ctx.shadowColor = this.tone(tone); ctx.shadowBlur = hot ? 16 : 6;
    ctx.fillStyle = this.tone(hot ? 'fg' : tone); ctx.fillRect(rail.x + rail.w * t - 4, rect.cy - 12, 8, 24); ctx.shadowBlur = 0;
    this.text(format(value), rect.r, rect.cy + 1, {size: SIZE.sm, family: 'mono', align: 'right', color: this.tone('fg')});
    const set = x => {
      let next = min + (max - min) * Math.max(0, Math.min(1, (x - rail.x) / rail.w));
      if (step) next = Math.round(next / step) * step;
      onChange(next);
    };
    this.region(rect, {id, onDown: set, onDrag: set});
  }

  // One of several options, as a row of segments.
  chips(rect, options, value, onChange, {id = 'chips', tone = 'primary', size = SIZE.sm} = {}) {
    const cells = rect.cols(options.length, 6);
    options.forEach((option, i) => {
      const [key, label] = Array.isArray(option) ? option : [option, String(option)];
      this.button(cells[i], label, () => onChange(key), {id: `${id}:${key}`, tone, on: key === value, size});
    });
  }

  // A text box. Typing goes through the page's hidden input (see textinput.js), so a real keyboard,
  // a headset's system keyboard and the holographic keyboard all end up in the same place.
  field(rect, value, {id, placeholder = '', onInput, onSubmit, multiline = false, family = 'sans', numeric = false}) {
    const ctx = this.ctx, panel = this.panel, focused = panel.focusId === id, hot = this.isHot(id);
    this.chamfer(rect, 7);
    ctx.fillStyle = this.tone('input', 0.92); ctx.fill();
    ctx.strokeStyle = this.tone(focused ? 'primary' : 'muted', focused ? 1 : hot ? 0.8 : 0.4); ctx.lineWidth = focused ? 2 : 1.5;
    if (focused) { ctx.shadowColor = this.tone('primary', 0.8); ctx.shadowBlur = 12; }
    ctx.stroke(); ctx.shadowBlur = 0;
    const inner = rect.inset(12, 8), size = SIZE.md, font = this.font(size, family);
    const shown = String(value ?? '');
    ctx.save(); ctx.beginPath(); ctx.rect(inner.x, rect.y, inner.w, rect.h); ctx.clip();
    let caretX = inner.x, caretY = inner.cy;
    if (!shown && !focused) this.text(placeholder, inner.x, multiline ? inner.y + size * 0.7 : inner.cy + 1, {size, family, color: this.tone('muted', 0.7), max: inner.w});
    else if (multiline) {
      const lines = this.lines(shown, inner.w, font), step = size * 1.3, visible = Math.max(1, Math.floor(inner.h / step));
      const first = Math.max(0, lines.length - visible);
      ctx.font = font; ctx.fillStyle = this.tone('fg'); ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.letterSpacing = '0px';
      lines.slice(first).forEach((line, i) => ctx.fillText(line, inner.x, inner.y + step * (i + 0.5)));
      const last = lines[lines.length - 1] ?? '';
      caretX = inner.x + ctx.measureText(last).width; caretY = inner.y + step * (Math.min(lines.length, visible) - 0.5);
    } else {
      ctx.font = font; ctx.letterSpacing = '0px';
      const width = ctx.measureText(shown).width, slide = Math.max(0, width - inner.w + 4);
      this.text(shown, inner.x - slide, inner.cy + 1, {size, family});
      caretX = inner.x - slide + width;
    }
    if (focused && Math.floor(this.now / 520) % 2 === 0) { ctx.fillStyle = this.tone('primary'); ctx.fillRect(caretX + 2, caretY - size * 0.6, 2, size * 1.2); }
    ctx.restore();
    if (focused) panel.invalidate();
    this.region(rect, {id, onClick: () => {
      panel.focusId = id;
      panel.onFocus?.({id, value: shown, multiline, numeric, onInput, onSubmit});
    }});
  }

  // A clipped, scrolling area. draw(inner) lays the content out from inner's top and returns its height.
  scroll(rect, id, draw, {stickBottom = false} = {}) {
    const {ctx, panel} = this;
    if (!panel.scrolls.has(id)) panel.scrolls.set(id, {offset: 0, stick: stickBottom, max: 0});
    const state = panel.scrolls.get(id);
    state.offset = Math.max(0, Math.min(state.max, state.offset));
    if (state.stick) state.offset = state.max;
    const outerClip = this.clip, outerShift = this.shift;
    this.region(rect, {id: `@scroll:${id}`, scrollId: id});
    ctx.save(); ctx.beginPath(); ctx.rect(rect.x, rect.y, rect.w, rect.h); ctx.clip();
    ctx.translate(0, -state.offset);
    this.clip = rect; this.shift = outerShift + state.offset;
    const used = draw(new Rect(rect.x, rect.y, rect.w - 10, 1e6)) || 0;
    ctx.restore(); this.clip = outerClip; this.shift = outerShift;
    const max = Math.max(0, used - rect.h), wasAtBottom = state.offset >= state.max - 2;
    if (max !== state.max) {
      if (stickBottom && wasAtBottom) state.stick = true;
      state.max = max;
      if (state.stick || state.offset > max) panel.invalidate();
    }
    // Scrolling away lets go of the bottom; coming back to it takes hold again.
    if (stickBottom && !state.stick && max > 0 && state.offset >= max - 2) state.stick = true;
    if (max > 0) {
      const height = Math.max(24, rect.h * rect.h / used), y = rect.y + (rect.h - height) * (state.offset / max);
      ctx.fillStyle = this.tone('primary', 0.14); ctx.fillRect(rect.r - 3, rect.y, 2, rect.h);
      ctx.fillStyle = this.tone('primary', 0.8); ctx.fillRect(rect.r - 4, y, 4, height);
    }
    return state;
  }

  // A list row: hover fill, a marker when selected, a click.
  row(rect, {id, onClick, selected = false, tone = 'primary'}) {
    const ctx = this.ctx, hot = this.isHot(id);
    if (hot || selected) { ctx.fillStyle = this.tone(tone, selected ? 0.16 : 0.08); ctx.fillRect(rect.x, rect.y, rect.w, rect.h); }
    if (selected) { ctx.fillStyle = this.tone(tone); ctx.fillRect(rect.x, rect.y, 3, rect.h); }
    this.region(rect, {id, onClick});
    return hot;
  }

  meter(rect, fraction, {tone = 'primary', segments = 24} = {}) {
    const ctx = this.ctx, gap = 2, w = (rect.w - gap * (segments - 1)) / segments, lit = Math.round(Math.max(0, Math.min(1, fraction)) * segments);
    for (let i = 0; i < segments; i++) {
      ctx.fillStyle = i < lit ? this.tone(i > segments * 0.85 ? 'danger' : i > segments * 0.65 ? 'warn' : tone, 0.95) : this.tone('muted', 0.18);
      ctx.fillRect(rect.x + i * (w + gap), rect.y, w, rect.h);
    }
  }

  spark(rect, values, {tone = 'primary', max = null} = {}) {
    if (values.length < 2) return;
    const ctx = this.ctx, top = max ?? Math.max(...values, 1e-9);
    ctx.beginPath();
    values.forEach((value, i) => {
      const x = rect.x + rect.w * i / (values.length - 1), y = rect.b - rect.h * Math.min(1, value / top);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.strokeStyle = this.tone(tone); ctx.lineWidth = 1.6; ctx.shadowColor = this.tone(tone); ctx.shadowBlur = 8; ctx.stroke(); ctx.shadowBlur = 0;
    ctx.lineTo(rect.r, rect.b); ctx.lineTo(rect.x, rect.b); ctx.closePath();
    const fill = ctx.createLinearGradient(0, rect.y, 0, rect.b);
    fill.addColorStop(0, this.tone(tone, 0.25)); fill.addColorStop(1, this.tone(tone, 0));
    ctx.fillStyle = fill; ctx.fill();
  }

  // A small outlined tag ("SKILL", "30 Hz").
  badge(x, y, label, {tone = 'primary', size = SIZE.xs, align = 'left', filled = false} = {}) {
    const ctx = this.ctx, width = this.measure(label, size, 500, 'mono') + 14, height = size + 9;
    const left = align === 'right' ? x - width : x;
    ctx.fillStyle = this.tone(tone, filled ? 0.9 : 0.1); ctx.fillRect(left, y - height / 2, width, height);
    ctx.strokeStyle = this.tone(tone, 0.7); ctx.lineWidth = 1; ctx.strokeRect(left + 0.5, y - height / 2 + 0.5, width - 1, height - 1);
    this.text(label, left + 7, y + 1, {size, family: 'mono', weight: 500, color: filled ? this.tone('primaryFg') : this.tone(tone)});
    return width;
  }

  // A status lamp.
  lamp(x, y, tone, pulse = false) {
    const ctx = this.ctx, a = pulse ? 0.55 + 0.45 * Math.sin(this.now / 260) : 1;
    ctx.shadowColor = this.tone(tone); ctx.shadowBlur = 10; ctx.fillStyle = this.tone(tone, a);
    ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
    if (pulse) this.panel.invalidate();
  }

  empty(rect, message, hint = '') {
    this.text(message, rect.cx, rect.y + Math.min(rect.h / 2, 80), {size: SIZE.md, color: this.tone('muted'), align: 'center', max: rect.w});
    if (hint) this.text(hint, rect.cx, rect.y + Math.min(rect.h / 2, 80) + 30, {size: SIZE.sm, color: this.tone('muted', 0.7), align: 'center', max: rect.w});
  }
}
