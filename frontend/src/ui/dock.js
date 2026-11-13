// Where panels live. On a flat screen they ride with the camera as a heads-up display, so orbiting
// the table never loses them. In a headset they stand in the room on an arc around the viewer.
// A panel the user has dragged stays where it was put; the rest are arranged by slot.
// On a screen a side holds one tool at a time: the next one opened takes its place. A panel the user
// keeps (the pin in its title bar) is not given up for another; the other then stands beside it (ui/flow.js).
import * as THREE from 'three';
import {flow} from './flow.js';

const HUD_DISTANCE = 1.0, GAP = 0.016, MARGIN = 0.022;
const KEPT = 'spatial.kept';   // which panels the user pinned or let go, by panel id
// Arc slots for the room: azimuth (degrees, + is right), radius, and whether it stacks downward from eye height.
const ARC = {
  left: {azimuth: -44, radius: 1.05}, right: {azimuth: 44, radius: 1.05},
  farLeft: {azimuth: -82, radius: 1.05}, farRight: {azimuth: 82, radius: 1.05},
};

export class Dock extends EventTarget {
  constructor({scene, camera, stage}) {
    super();
    this.scene = scene; this.camera = camera; this.stage = stage;
    this.hud = new THREE.Group(); this.hud.name = 'hud'; camera.add(this.hud);
    this.room = new THREE.Group(); this.room.name = 'room-panels'; scene.add(this.room);
    this.entries = new Map(); this.mode = 'hud'; this.sequence = 0;
    this.anchor = {position: new THREE.Vector3(0, 1.5, 0), yaw: 0};
    this.inset = {top: 0, bottom: 0}; // CSS pixels of the window that Desktop's shell covers
    try { this.keeps = JSON.parse(localStorage.getItem(KEPT) || '{}'); } catch { this.keeps = {}; }
  }

  get panels() { return [...this.entries.values()].map(entry => entry.panel); }
  has(id) { return this.entries.has(id) && !this.entries.get(id).panel.closing; }
  get(id) { return this.entries.get(id)?.panel; }

  // slot: left | right | farLeft | farRight | bar (bottom centre) | head (top centre) | deck (above the bar) | keys (above those)
  open(panel, slot = 'right') {
    const existing = this.entries.get(panel.id);
    if (existing) { existing.panel.dispose(); this.entries.delete(panel.id); }
    const entry = {panel, slot, free: false, order: this.sequence++, position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), placed: false};
    this.entries.set(panel.id, entry);
    (this.mode === 'hud' ? this.hud : this.room).add(panel.group);
    panel.opened = performance.now(); panel.closing = 0;
    // What the user chose for this panel before holds; else the panel's own start (a camera screen starts kept).
    if (panel.keepable) { panel.kept = this.keeps[panel.id] ?? panel.kept; panel.onKeep = () => this.pin(panel.id); }
    this.layout();
    this.dispatchEvent(new Event('change'));
    return panel;
  }

  close(id) { this.entries.get(id)?.panel.close(); this.layout(); this.dispatchEvent(new Event('change')); }

  // The pin in a title bar. A panel the user put somewhere by hand goes back to its column; any other is
  // kept, or let go.
  pin(id) {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (!entry.free) { this.keep(id, !entry.panel.kept); return; }
    entry.free = entry.panel.free = false; entry.panel.invalidate();
    this.layout();
    this.dispatchEvent(new Event('change'));
  }

  // Keep a panel: no other panel that opens on its side takes its place. The choice is remembered for the panel.
  keep(id, on) {
    const panel = this.get(id);
    if (!panel?.keepable) return;
    panel.kept = !!on; panel.invalidate();
    this.keeps[id] = panel.kept;
    try { localStorage.setItem(KEPT, JSON.stringify(this.keeps)); } catch { /* private mode: the choice lasts as long as the page */ }
    panel.onKept?.(panel.kept);
    this.layout();
    this.dispatchEvent(new Event('change'));
  }

  // The same panel made again (a camera screen at another size): it takes the place the old one had, its
  // turn in the column and where the user put it, with no jump.
  swap(panel) {
    const entry = this.entries.get(panel.id), old = entry?.panel;
    if (!entry || old.closing) return this.open(panel, entry?.slot);
    panel.kept = old.kept; panel.free = old.free; panel.onKeep = old.onKeep;
    panel.group.position.copy(old.group.position); panel.group.quaternion.copy(old.group.quaternion);
    panel.opened = old.opened; panel.closing = 0;
    entry.panel = panel; old.group.parent.add(panel.group);
    old.dispose();
    this.layout();
    this.dispatchEvent(new Event('change'));
    return panel;
  }

  // The viewer's place in the room: panels and the table are arranged around it.
  setAnchor(position, yaw) { this.anchor.position.copy(position); this.anchor.yaw = yaw; for (const entry of this.entries.values()) entry.free = entry.panel.free = false; this.layout(true); }

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    for (const entry of this.entries.values()) { (mode === 'hud' ? this.hud : this.room).add(entry.panel.group); entry.free = entry.panel.free = false; entry.placed = false; }
    this.layout(true);
  }

  // How tall a side panel may be where panels are now: the HUD column on a screen, a comfortable reach in a room.
  sideHeight(preferred = 0.62) {
    if (this.mode !== 'hud') return preferred;
    const {height} = this.hudExtent(), perPixel = height / Math.max(1, innerHeight);
    let free = height - 2 * MARGIN - (this.inset.top + this.inset.bottom) * perPixel;
    for (const entry of this.entries.values()) if (['bar', 'head', 'deck'].includes(entry.slot) && !entry.panel.closing) free -= entry.panel.height + GAP;
    return Math.max(0.4, Math.min(0.8, free));
  }

  // The HUD rectangle at its distance from the camera, in metres.
  hudExtent() {
    const height = 2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * HUD_DISTANCE;
    return {width: height * this.camera.aspect, height};
  }

  layout(snap = false) {
    const live = [...this.entries.values()].filter(entry => !entry.panel.closing).sort((a, b) => a.order - b.order);
    if (this.mode === 'hud') this.layoutHud(live); else this.layoutRoom(live);
    if (snap) for (const entry of live) entry.placed = false;
  }

  layoutHud(live) {
    const {width, height} = this.hudExtent(), perPixel = height / Math.max(1, innerHeight);
    const top = height / 2 - MARGIN - this.inset.top * perPixel, bottom = -height / 2 + MARGIN + this.inset.bottom * perPixel;
    const barHeight = live.filter(e => e.slot === 'bar').reduce((h, e) => Math.max(h, e.panel.height), 0);
    const headHeight = live.filter(e => e.slot === 'head').reduce((h, e) => Math.max(h, e.panel.height), 0);
    // Decks stand on one another above the bar (an episode's controls under a scene's, say).
    const decks = live.filter(e => e.slot === 'deck'), deckHeight = decks.reduce((h, e) => h + e.panel.height + GAP, 0);
    const low = (barHeight ? barHeight + GAP : 0) + deckHeight;
    // Side columns run from under the status strip to above the command bar.
    const columnTop = top - (headHeight ? headHeight + GAP : 0), available = columnTop - bottom - low;
    // left/farLeft stand at the left edge, right/farRight at the right edge. A panel the user dragged is where
    // it was put: it takes no room in a column and no other panel closes it.
    const sides = {left: [], right: []};
    for (const entry of live) {
      if (['bar', 'head', 'keys', 'deck'].includes(entry.slot) || entry.free) continue;
      sides[entry.slot.toLowerCase().includes('left') ? 'left' : 'right'].push(entry);
    }
    for (const [side, entries] of Object.entries(sides)) {
      const sign = side === 'left' ? -1 : 1;
      const {columns, closed} = flow(entries.map(entry => ({entry, height: entry.panel.height, kept: !!entry.panel.kept, order: entry.order})), available, GAP);
      for (const {entry} of closed) entry.panel.close();
      // Where the next column's outer edge may be, as seen on the screen (metres at the HUD's distance).
      let bound = width / 2 - MARGIN;
      columns.forEach((column, index) => {
        let inner = bound, y = columnTop;
        for (const {entry} of column) {
          const panel = entry.panel, half = panel.width / 2;
          // The column at the edge is turned toward the viewer, a wide panel less; the ones beside it hardly.
          const turn = THREE.MathUtils.degToRad(index ? 2.5 : 7 * Math.min(1, 0.46 / panel.width)), near = half * Math.sin(turn) / HUD_DISTANCE;
          // A turned panel's outer edge is nearer the eye and so looks further out: the panel is put where
          // that edge is seen at the bound, and its inner edge (further away, so further in) bounds the next column.
          const centre = bound * (1 - near) - half * Math.cos(turn);
          entry.position.set(sign * centre, y - panel.height / 2, -HUD_DISTANCE);
          entry.quaternion.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, -sign * turn);
          inner = Math.min(inner, (centre - half * Math.cos(turn)) / (1 + near));
          y -= panel.height + GAP;
        }
        bound = inner - GAP * 1.5;
      });
    }
    let deckBase = bottom + (barHeight ? barHeight + GAP : 0);
    for (const entry of decks) {
      // A little nearer than the columns: a side panel that was open before the deck came must not cover it.
      if (!entry.free) { entry.position.set(0, deckBase + entry.panel.height / 2, -HUD_DISTANCE + 0.03); entry.quaternion.identity(); }
      deckBase += entry.panel.height + GAP;
    }
    for (const entry of live) {
      if (entry.free) continue;
      if (entry.slot === 'bar') { entry.position.set(0, bottom + entry.panel.height / 2, -HUD_DISTANCE); entry.quaternion.identity(); }
      if (entry.slot === 'head') { entry.position.set(0, top - entry.panel.height / 2, -HUD_DISTANCE); entry.quaternion.identity(); }
      if (entry.slot === 'keys') { entry.position.set(0, bottom + low + entry.panel.height / 2, -HUD_DISTANCE); entry.quaternion.identity(); }
    }
  }

  layoutRoom(live) {
    const {position: origin, yaw} = this.anchor, eye = origin.y;
    const place = (entry, azimuth, radius, y, pitch = 0) => {
      const a = yaw - THREE.MathUtils.degToRad(azimuth);
      entry.position.set(origin.x - Math.sin(a) * radius, y, origin.z - Math.cos(a) * radius);
      entry.quaternion.setFromEuler(new THREE.Euler(pitch, a, 0, 'YXZ'));
    };
    const columns = {};
    // Decks lie one behind the other up their own slope (0.75 rad back from upright).
    let edge = 0, first = null;
    for (const entry of live) {
      if (entry.slot === 'deck') {
        first ??= entry.panel.height / 2;
        const along = edge + entry.panel.height / 2 - first;
        if (!entry.free) place(entry, 0, 0.5 + along * Math.sin(0.75), eye - 0.455 + along * Math.cos(0.75), -0.75);
        edge += entry.panel.height + GAP;
        continue;
      }
      if (entry.free) continue;
      // The command bar lies along the near edge of the table (app.js puts the table 0.98 m out, 0.58 m below the eyes).
      if (entry.slot === 'bar') { place(entry, 0, 0.43, eye - 0.55, -0.9); continue; }
      if (entry.slot === 'head') { place(entry, 0, 1.25, eye + 0.34, 0.12); continue; }
      if (entry.slot === 'keys') { place(entry, 0, 0.52, eye - 0.36, -0.55); continue; }
      (columns[entry.slot] ||= []).push(entry);
    }
    for (const [slot, column] of Object.entries(columns)) {
      const arc = ARC[slot] || ARC.right;
      const total = column.reduce((sum, e) => sum + e.panel.height + GAP, -GAP);
      let y = eye - 0.02 + Math.min(total, 1.15) / 2;
      // A column taller than is comfortable to look at spills into the next arc position outward.
      let azimuth = arc.azimuth, used = 0;
      for (const entry of column) {
        if (used + entry.panel.height > 1.2 && used > 0) { azimuth += Math.sign(arc.azimuth) * 36; y = eye - 0.02 + Math.min(total - used, 1.15) / 2; used = 0; }
        place(entry, azimuth, arc.radius, y - entry.panel.height / 2);
        y -= entry.panel.height + GAP; used += entry.panel.height + GAP;
      }
    }
  }

  // The user moved it: keep it out of the automatic layout.
  release(panel) {
    const entry = this.entries.get(panel.id);
    if (!entry) return;
    if (!entry.free) { panel.free = true; panel.invalidate(); }
    entry.free = true; entry.position.copy(panel.group.position); entry.quaternion.copy(panel.group.quaternion);
  }

  update(now, dt) {
    const k = 1 - Math.exp(-dt * 12);
    for (const [id, entry] of this.entries) {
      const panel = entry.panel, group = panel.group;
      if (panel.closed) { panel.dispose(); this.entries.delete(id); this.layout(); this.dispatchEvent(new Event('change')); continue; }
      if (!entry.placed) { group.position.copy(entry.position); group.quaternion.copy(entry.quaternion); entry.placed = true; }
      else if (!entry.held) { group.position.lerp(entry.position, k); group.quaternion.slerp(entry.quaternion, k); }
      panel.update(now);
    }
  }
}
