// A gamepad the browser has (not a controller a headset tracks), held in the hands of someone in a headset
// that tracks only hands. It says nothing of where a hand is; it gives each hand a stick and two buttons,
// and these do what a tracked controller's thumbstick, trigger and grip do. The hand itself points.
//
// The W3C "standard" layout is read: axes 0,1 are the left stick and 2,3 the right; buttons 4,5 are the
// shoulder buttons and 6,7 the triggers. A named half belongs to that hand even when the browser pads
// its axes to four slots (WebKit does this). Only an unnamed full-size pad belongs to both hands.

const down = button => !!button && (button.pressed === true || button.value > 0.5);
const axis = value => Number.isFinite(value) ? value : 0;
const present = gamepads => [...(gamepads || [])].filter(pad => pad && pad.connected !== false);

// The hand that holds a pad with one stick, from its name: 'left', 'right' or null.
export function padSide(id) {
  const name = String(id || '');
  if (/\(L\s*[/+]\s*R\)|\bleft\b.*\bright\b/i.test(name)) return null;
  const left = /\(L\)|\bleft\b|Joy[- ]?Con\s+L\b/i.test(name), right = /\(R\)|\bright\b|Joy[- ]?Con\s+R\b/i.test(name);
  return left === right ? null : left ? 'left' : 'right';
}

// WebKit uses standard button/axis slots for its Cocoa Gamepad profiles even when a non-extended
// profile has an empty mapping string. Other unmapped devices need their own declared layout.
const standardLayout = pad => pad.mapping === 'standard' || /Joy[- ]?Con.*\bGamepad$/i.test(pad.id);
// Which hands a pad is read for: 'both', 'left', 'right' or null (a layout this file does not know).
const padHands = pad => pad.axes.length >= 2 ? padSide(pad.id) ?? (pad.axes.length >= 4 && standardLayout(pad) ? 'both' : null) : null;

// A separate half may use the first stick slots or its full-pad slots. The unused slots are zero.
const halfStick = pad => [0, 1].map(i => axis(pad.axes[i + 2]) || axis(pad.axes[i]));
const halfTrigger = pad => down(pad.buttons[6]) || down(pad.buttons[7]);
const halfShoulder = pad => down(pad.buttons[4]) || down(pad.buttons[5]);

// {left, right}: for each hand null (it holds nothing) or {stick: [x, y], select, squeeze}.
// x is to the right and y is back, as on a controller's thumbstick. The first pad found for a hand has it.
export function heldPads(gamepads) {
  const held = {left: null, right: null};
  for (const pad of present(gamepads)) {
    const {axes, buttons} = pad, hands = padHands(pad);
    if (hands === 'both') {
      held.left ??= {stick: [axis(axes[0]), axis(axes[1])], select: down(buttons[6]), squeeze: down(buttons[4])};
      held.right ??= {stick: [axis(axes[2]), axis(axes[3])], select: down(buttons[7]) || down(buttons[0]), squeeze: down(buttons[5])};
    } else if (hands) {
      held[hands] ??= {stick: halfStick(pad), select: halfTrigger(pad) || down(buttons[0]), squeeze: halfShoulder(pad)};
    }
  }
  return held;
}

// What the page shows of the pads it sees: a layout that is read wrongly can then be seen and told.
export function describePads(gamepads) {
  return present(gamepads).map(pad => ({
    id: String(pad.id || 'gamepad'), mapping: pad.mapping || 'none', axes: pad.axes.length, buttons: pad.buttons.length,
    hands: padHands(pad), pressed: [...pad.buttons].flatMap((button, i) => down(button) ? [i] : []),
  }));
}

// A backend gets a standard pad, either a complete pad or two named halves combined into one. Its
// four stick axes, and each button as 0 or 1; the backend knows what each is for. `mine` says, per hand,
// that the page itself uses that hand now (it points at a panel): its stick and trigger are then at rest
// for the backend, so a press on a panel is not also a command.
export function padSample(gamepads, mine = {}) {
  const pads = present(gamepads), pad = pads.find(pad => standardLayout(pad) && padHands(pad) === 'both' && pad.buttons.length >= 16);
  let axes, buttons;
  if (pad) {
    axes = [0, 1, 2, 3].map(i => axis(pad.axes[i]));
    buttons = [...pad.buttons].map(button => down(button) ? 1 : 0);
  } else {
    const left = pads.find(pad => standardLayout(pad) && padHands(pad) === 'left');
    const right = pads.find(pad => standardLayout(pad) && padHands(pad) === 'right');
    // A lone half is enough for desktop interaction, but must not impersonate two robot controllers.
    if (!left || !right) return null;
    axes = [...halfStick(left), ...halfStick(right)]; buttons = Array(18).fill(0);
    for (const i of [4, 6, 8, 10, 12, 13, 14, 15, 17]) buttons[i] = down(left.buttons[i]) ? 1 : 0;
    for (const i of [0, 1, 2, 3, 5, 7, 9, 11, 16]) buttons[i] = down(right.buttons[i]) ? 1 : 0;
    buttons[4] = +halfShoulder(left); buttons[5] = +halfShoulder(right);
    buttons[6] = +halfTrigger(left); buttons[7] = +halfTrigger(right);
  }
  axes = axes.map(value => Math.max(-1, Math.min(1, value)));
  if (mine.left) { axes[0] = axes[1] = 0; buttons[6] = 0; }
  if (mine.right) { axes[2] = axes[3] = 0; buttons[7] = buttons[0] = 0; }
  return {layout: 'standard', axes, buttons};
}

// A button used to click UI must be released before it can command the robot, even if its ray moves
// off the panel while held. Entering teleop also requires releasing buttons held in desktop mode.
export class PadTeleop {
  constructor() { this.blocked = new Set(); this.identity = ''; }
  identityOf(gamepads) { return JSON.stringify(present(gamepads).map(pad => [pad.id, pad.index, pad.mapping, pad.axes.length, pad.buttons.length])); }
  reset(gamepads) {
    this.identity = this.identityOf(gamepads);
    this.blocked = new Set((padSample(gamepads)?.buttons ?? []).flatMap((down, i) => down ? [i] : []));
  }
  sample(gamepads, mine = {}) {
    if (this.identityOf(gamepads) !== this.identity) this.reset(gamepads);
    const raw = padSample(gamepads), sample = padSample(gamepads, mine);
    if (!sample) { this.blocked.clear(); return null; }
    for (let i = 0; i < raw.buttons.length; i++) {
      if (!raw.buttons[i]) this.blocked.delete(i);
      else if (!sample.buttons[i]) this.blocked.add(i);
      if (this.blocked.has(i)) sample.buttons[i] = 0;
    }
    return sample;
  }
}

// One button of one hand, this frame: 'press' the hand's pointer, 'release' the pointer it holds, or null.
//   was, pressed: the button last frame and now. holding: the pointer this button holds down, or null.
//   pointer: what the hand points with now, or null (the hand is not tracked).
// A press is a new push with a pointer that nothing else holds down. A hold ends when the button comes up
// or the hand's pointer is lost; the button must then be pushed again.
export function padAction({was, pressed, holding, pointer}) {
  if (holding) return !pressed || holding !== pointer ? 'release' : null;
  return pressed && !was && pointer && !pointer.down ? 'press' : null;
}
