// Typing. Every panel text box edits through one hidden <textarea>: a desk keyboard types into it
// directly, a headset with a system keyboard (XRSession.isSystemKeyboardSupported) raises that keyboard
// when it takes focus, and the holographic keyboard writes to it for headsets that have neither.
export class TextBridge extends EventTarget {
  constructor() {
    super();
    this.element = document.createElement('textarea');
    this.element.setAttribute('aria-label', 'Panel text entry');
    this.element.autocapitalize = 'off'; this.element.spellcheck = false;
    // On screen and focusable, but not visible: a display:none element cannot hold focus.
    this.element.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0;border:0;padding:0;resize:none;pointer-events:none';
    document.body.append(this.element);
    this.target = null;
    this.element.addEventListener('input', () => this.emit());
    this.element.addEventListener('keydown', event => {
      event.stopPropagation();
      if (!this.target) return;
      if (event.key === 'Enter' && !(this.target.multiline && event.shiftKey)) { event.preventDefault(); this.submit(); }
      if (event.key === 'Escape') this.blur();
    });
    this.element.addEventListener('blur', () => { if (this.target && !this.holding) this.blur(); });
  }

  get active() { return this.target !== null; }
  get value() { return this.element.value; }

  // target: {panel, id, value, multiline, numeric, onInput, onSubmit}
  focus(target) {
    if (this.target && this.target.panel !== target.panel) { this.target.panel.focusId = null; this.target.panel.invalidate(); }
    this.target = target;
    this.element.value = target.value ?? '';
    this.element.inputMode = target.numeric ? 'decimal' : 'text';
    this.holding = true;
    this.element.focus({preventScroll: true});
    this.element.setSelectionRange(this.element.value.length, this.element.value.length);
    this.holding = false;
    this.dispatchEvent(new Event('focus'));
  }

  emit() {
    if (!this.target) return;
    this.target.onInput?.(this.element.value);
    this.target.panel.invalidate();
  }

  // The holographic keyboard's keys.
  type(text) { this.element.value += text; this.emit(); }
  backspace() { this.element.value = this.element.value.slice(0, -1); this.emit(); }
  set(text) { this.element.value = text; this.emit(); }

  submit() {
    const target = this.target;
    if (!target) return;
    const value = this.element.value;
    // onSubmit returning false keeps the box focused (a chat box that stays open for the next message).
    if (target.onSubmit?.(value) === false) { this.element.value = ''; target.onInput?.(''); target.panel.invalidate(); return; }
    this.blur();
  }

  blur() {
    const target = this.target;
    if (!target) return;
    this.target = null;
    target.panel.focusId = null; target.panel.invalidate();
    if (document.activeElement === this.element) this.element.blur();
    this.dispatchEvent(new Event('blur'));
  }
}
