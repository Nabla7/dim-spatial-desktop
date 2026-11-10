// Desktop's theme tokens, resolved to values a canvas and a shader can use.
// The page links ../../theme.css; nothing here names a skin or hard-codes a color.
import * as THREE from 'three';

const TOKENS = {
  bg: '--bg', fg: '--fg', muted: '--muted-fg', primary: '--primary', alt: '--accent-alt',
  primaryFg: '--primary-fg', ok: '--ok', warn: '--warn', danger: '--danger', info: '--info',
  surface: '--surface', raised: '--raised', input: '--input-bg', border: '--border',
  borderStrong: '--border-strong', hair: '--hair', agent: '--violet',
  axisX: '--axis-x', axisY: '--axis-y', axisZ: '--axis-z',
  sceneBg: '--scene-bg', sceneGrid: '--scene-grid-major',
};
const FONTS = {sans: '--sans', mono: '--mono', display: '--display'};

// "rgb(1, 2, 3)", "rgba(1, 2, 3, 0.5)" or "color(srgb 0.1 0.2 0.3 / 0.5)" -> [r, g, b, a] in 0..1.
export function parseColor(text) {
  const numbers = (text.match(/-?[\d.]+(?:e-?\d+)?%?/g) || []).map(v => v.endsWith('%') ? parseFloat(v) / 100 : parseFloat(v));
  if (numbers.length < 3) return [1, 1, 1, 1];
  const scale = text.startsWith('color(') ? 1 : 1 / 255;
  return [numbers[0] * scale, numbers[1] * scale, numbers[2] * scale, numbers[3] ?? 1];
}

const css = ([r, g, b, a], alpha = 1) =>
  `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${+(a * alpha).toFixed(3)})`;

export class Theme extends EventTarget {
  constructor() {
    super();
    this.probe = document.createElement('i');
    this.probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none';
    document.body.append(this.probe);
    this.rgba = {}; this.font = {}; this.three = {};
    this.read();
    // A skin change is an attribute or inline-style change on <html> (dim-app's theme.js does the same).
    new MutationObserver(() => this.read(true)).observe(document.documentElement, {
      attributes: true, attributeFilter: ['class', 'style', 'data-skin', 'data-theme'],
    });
    document.fonts?.addEventListener?.('loadingdone', () => this.dispatchEvent(new Event('change')));
  }

  read(notify = false) {
    const style = getComputedStyle(document.documentElement);
    for (const [name, token] of Object.entries(TOKENS)) {
      // Through a probe: custom properties hold unresolved text (var(), color-mix()), a used color does not.
      this.probe.style.color = `var(${token})`;
      this.rgba[name] = parseColor(getComputedStyle(this.probe).color);
      this.three[name] = new THREE.Color().setRGB(...this.rgba[name].slice(0, 3), THREE.SRGBColorSpace);
    }
    for (const [name, token] of Object.entries(FONTS)) this.font[name] = style.getPropertyValue(token).trim() || 'sans-serif';
    this.labelCase = style.getPropertyValue('--label-case').trim() || 'none';
    if (notify) this.dispatchEvent(new Event('change'));
  }

  // A token as a CSS color, with its alpha scaled.
  c(name, alpha = 1) { return css(this.rgba[name], alpha); }

  // Two tokens mixed (t = 0 is a, 1 is b).
  mix(a, b, t, alpha = 1) {
    const x = this.rgba[a], y = this.rgba[b];
    return css([0, 1, 2].map(i => x[i] + (y[i] - x[i]) * t).concat(1), alpha);
  }

  label(text) { return this.labelCase === 'uppercase' ? String(text).toUpperCase() : String(text); }

  async fontsReady() {
    if (!document.fonts) return;
    const families = Object.values(this.font).map(stack => stack.split(',')[0].trim());
    await Promise.all(families.map(family => document.fonts.load(`16px ${family}`).catch(() => null)));
  }
}
