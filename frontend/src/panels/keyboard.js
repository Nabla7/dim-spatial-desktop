// A keyboard of light, for a headset whose browser gives an immersive page no system keyboard.
// Its keys write to the same hidden text box a desk keyboard types into (ui/textinput.js).
import {SIZE} from '../ui/holo.js';
import {Rect} from '../ui/rect.js';

const ROWS = {
  lower: ['1234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'],
  upper: ['!@#$%^&*()', 'QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'],
  marks: ['1234567890', '-_=+[]{}\\|', ';:\'",.<>/?', '`~()*&^'],
};

export function openKeyboard(app, force = false) {
  const id = 'keyboard';
  if (app.dock.has(id)) { if (!force) app.dock.close(id); return; }
  const state = {layout: 'lower'};
  const text = app.text;
  const panel = app.panel({
    id, bare: true, width: 0.62, height: 0.25,
    draw(ui, content) {
      const rows = ROWS[state.layout], keyHeight = (content.h - 8 * 4) / 5;
      const preview = content.cutTop(keyHeight * 0.62, 8);
      ui.text(text.value || ' ', preview.x + 8, preview.cy, {size: SIZE.md, family: 'mono', color: ui.tone('fg'), max: preview.w - 16});
      ui.hair(preview.x, preview.b, preview.r, preview.b, ui.tone('primary', 0.4));
      const height = (content.h - 8 * 4) / 5, unit = (content.w - 9 * 6) / 10;
      rows.forEach((row, index) => {
        const line = content.cutTop(height, 8), inset = (10 - row.length) * (unit + 6) / 2;
        let x = line.x + (index === 3 ? unit * 1.5 + 6 : inset);
        if (index === 3) ui.button(new Rect(line.x, line.y, unit * 1.5, line.h), state.layout === 'upper' ? 'abc' : 'ABC', () => { state.layout = state.layout === 'upper' ? 'lower' : 'upper'; }, {id: 'shift', size: SIZE.sm, on: state.layout === 'upper'});
        for (const key of row) { ui.button(new Rect(x, line.y, unit, line.h), key, () => text.type(key), {id: `k:${key}`, size: SIZE.lg}); x += unit + 6; }
        if (index === 3) ui.button(new Rect(x, line.y, line.r - x, line.h), '⌫', () => text.backspace(), {id: 'back', size: SIZE.lg, tone: 'warn'});
      });
      const last = content.cutTop(height, 0);
      ui.button(last.cutLeft(unit * 1.5, 6), state.layout === 'marks' ? 'abc' : '#+=', () => { state.layout = state.layout === 'marks' ? 'lower' : 'marks'; }, {id: 'marks', size: SIZE.sm});
      ui.button(last.cutRight(unit * 2, 6), 'ENTER', () => text.submit(), {id: 'enter', size: SIZE.sm, on: true});
      ui.button(last.cutRight(unit, 6), '.', () => text.type('.'), {id: 'k:dot', size: SIZE.lg});
      ui.button(last, 'space', () => text.type(' '), {id: 'space', size: SIZE.sm, tone: 'muted'});
    },
  });
  text.addEventListener('focus', () => panel.invalidate(), {signal: panel.signal});
  const timer = setInterval(() => panel.invalidate(), 250);
  panel.onDispose = () => clearInterval(timer);
  return app.dock.open(panel, 'keys');
}
