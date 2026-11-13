// Line icons, drawn in a 24-unit box centred on the origin. The caller sets stroke, fill and scale.
const path = (ctx, draw, fill = false) => { ctx.beginPath(); draw(); fill ? ctx.fill() : ctx.stroke(); };
const poly = (ctx, points, close = false, fill = false) => path(ctx, () => {
  points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
  if (close) ctx.closePath();
}, fill);
const circle = (ctx, x, y, r, fill = false) => path(ctx, () => ctx.arc(x, y, r, 0, Math.PI * 2), fill);

export const icons = {
  dot: ctx => circle(ctx, 0, 0, 3, true),
  close: ctx => { poly(ctx, [[-7, -7], [7, 7]]); poly(ctx, [[7, -7], [-7, 7]]); },
  grid: ctx => { for (const x of [-7, 1]) for (const y of [-7, 1]) ctx.strokeRect(x, y, 6, 6); },
  play: ctx => poly(ctx, [[-5, -8], [8, 0], [-5, 8]], true, true),
  stop: ctx => ctx.fillRect(-7, -7, 14, 14),
  pause: ctx => { ctx.fillRect(-7, -8, 5, 16); ctx.fillRect(2, -8, 5, 16); },
  // One frame back or on: a bar and a triangle. A whole episode back or on: two triangles.
  stepBack: ctx => { ctx.fillRect(-8, -7, 3, 14); poly(ctx, [[7, -7], [-3, 0], [7, 7]], true, true); },
  stepOn: ctx => { ctx.fillRect(5, -7, 3, 14); poly(ctx, [[-7, -7], [3, 0], [-7, 7]], true, true); },
  skipBack: ctx => { poly(ctx, [[0, -7], [-9, 0], [0, 7]], true, true); poly(ctx, [[9, -7], [0, 0], [9, 7]], true, true); },
  skipOn: ctx => { poly(ctx, [[0, -7], [9, 0], [0, 7]], true, true); poly(ctx, [[-9, -7], [0, 0], [-9, 7]], true, true); },
  // A block seen from a corner: a scene.
  scene: ctx => { poly(ctx, [[0, -10], [9, -5], [9, 5], [0, 10], [-9, 5], [-9, -5]], true); poly(ctx, [[-9, -5], [0, 0], [9, -5]]); poly(ctx, [[0, 0], [0, 10]]); },
  // A strip of film: recorded data to play back.
  film: ctx => { ctx.strokeRect(-9, -7, 18, 14); for (const x of [-6, 0, 6]) { ctx.fillRect(x - 1, -6, 2, 2.5); ctx.fillRect(x - 1, 3.5, 2, 2.5); } poly(ctx, [[-2.5, -2.5], [3, 0], [-2.5, 2.5]], true, true); },
  refresh: ctx => { path(ctx, () => ctx.arc(0, 0, 8, -0.4, Math.PI * 1.45)); poly(ctx, [[4, -9], [8.5, -3.5], [2, -2.5]], true, true); },
  chevron: ctx => poly(ctx, [[-4, -7], [4, 0], [-4, 7]]),
  down: ctx => poly(ctx, [[-7, -4], [0, 4], [7, -4]]),
  up: ctx => poly(ctx, [[-7, 4], [0, -4], [7, 4]]),
  back: ctx => poly(ctx, [[4, -7], [-4, 0], [4, 7]]),
  plus: ctx => { poly(ctx, [[-7, 0], [7, 0]]); poly(ctx, [[0, -7], [0, 7]]); },
  minus: ctx => poly(ctx, [[-7, 0], [7, 0]]),
  send: ctx => { poly(ctx, [[-9, -8], [10, 0], [-9, 8], [-5, 0]], true); poly(ctx, [[-5, 0], [3, 0]]); },
  mic: ctx => {
    path(ctx, () => { ctx.moveTo(-3.5, -5); ctx.arc(0, -5, 3.5, Math.PI, 0); ctx.lineTo(3.5, 1); ctx.arc(0, 1, 3.5, 0, Math.PI); ctx.closePath(); });
    path(ctx, () => ctx.arc(0, 1, 7, 0.15, Math.PI - 0.15)); poly(ctx, [[0, 8], [0, 11]]);
  },
  // A module: a hexagon.
  module: ctx => poly(ctx, [0, 1, 2, 3, 4, 5].map(i => [9 * Math.cos(Math.PI / 6 + i * Math.PI / 3), 9 * Math.sin(Math.PI / 6 + i * Math.PI / 3)]), true),
  // An RPC: a call arrow into a bracket.
  rpc: ctx => { poly(ctx, [[2, -8], [8, -8], [8, 8], [2, 8]]); poly(ctx, [[-9, 0], [3, 0]]); poly(ctx, [[-1, -4], [3, 0], [-1, 4]]); },
  skill: ctx => poly(ctx, [[2, -10], [-6, 2], [0, 2], [-2, 10], [6, -2], [0, -2]], true, true),
  stream: ctx => { for (const y of [-6, 0, 6]) path(ctx, () => { ctx.moveTo(-9, y); ctx.bezierCurveTo(-4, y - 5, 4, y + 5, 9, y); }); },
  layers: ctx => { poly(ctx, [[0, -9], [9, -4], [0, 1], [-9, -4]], true); poly(ctx, [[-9, 1], [0, 6], [9, 1]]); poly(ctx, [[-9, 5], [0, 10], [9, 5]]); },
  camera: ctx => { ctx.strokeRect(-9, -5, 13, 11); poly(ctx, [[4, -1], [9, -5], [9, 6], [4, 2]], true); },
  cloud: ctx => { for (const [x, y] of [[-7, 3], [-3, -5], [0, 1], [4, -3], [7, 5], [-5, -1], [2, 7], [6, -8], [-8, -7]]) circle(ctx, x, y, 1.1, true); },
  eye: ctx => { path(ctx, () => { ctx.moveTo(-10, 0); ctx.quadraticCurveTo(0, -9, 10, 0); ctx.quadraticCurveTo(0, 9, -10, 0); }); circle(ctx, 0, 0, 2.6, true); },
  eyeOff: ctx => { path(ctx, () => { ctx.moveTo(-10, 0); ctx.quadraticCurveTo(0, -9, 10, 0); ctx.quadraticCurveTo(0, 9, -10, 0); }); poly(ctx, [[-8, 8], [8, -8]]); },
  agent: ctx => { poly(ctx, [[0, -10], [2.5, -2.5], [10, 0], [2.5, 2.5], [0, 10], [-2.5, 2.5], [-10, 0], [-2.5, -2.5]], true); },
  rocket: ctx => { poly(ctx, [[0, -10], [5, -2], [5, 5], [-5, 5], [-5, -2]], true); poly(ctx, [[-5, 2], [-9, 8]]); poly(ctx, [[5, 2], [9, 8]]); poly(ctx, [[0, 6], [0, 10]]); },
  log: ctx => { for (const [y, w] of [[-7, 16], [-2, 10], [3, 14], [8, 7]]) poly(ctx, [[-8, y], [-8 + w, y]]); },
  pulse: ctx => poly(ctx, [[-10, 2], [-5, 2], [-2, -7], [2, 8], [5, -2], [7, 2], [10, 2]]),
  scale: ctx => { ctx.strokeRect(-9, -1, 10, 10); poly(ctx, [[1, -1], [9, -9]]); poly(ctx, [[3, -9], [9, -9], [9, -3]]); },
  home: ctx => poly(ctx, [[-9, 0], [0, -9], [9, 0], [6, 0], [6, 9], [-6, 9], [-6, 0]], true),
  vr: ctx => { poly(ctx, [[-10, -5], [10, -5], [10, 6], [3, 6], [0, 2], [-3, 6], [-10, 6]], true); circle(ctx, -5, 0, 1.6, true); circle(ctx, 5, 0, 1.6, true); },
  robot: ctx => { ctx.strokeRect(-7, -5, 14, 11); circle(ctx, -3, 0, 1.4, true); circle(ctx, 3, 0, 1.4, true); poly(ctx, [[0, -5], [0, -9]]); circle(ctx, 0, -10, 1, true); },
  axes: ctx => { poly(ctx, [[0, 0], [0, -9]]); poly(ctx, [[0, 0], [8, 5]]); poly(ctx, [[0, 0], [-8, 5]]); },
  pin: ctx => { poly(ctx, [[-4, -9], [4, -9], [3, -2], [6, 2], [-6, 2], [-3, -2]], true); poly(ctx, [[0, 2], [0, 10]]); },
  warn: ctx => { poly(ctx, [[0, -9], [10, 8], [-10, 8]], true); poly(ctx, [[0, -3], [0, 3]]); circle(ctx, 0, 5.5, 0.6, true); },
  check: ctx => poly(ctx, [[-8, 0], [-3, 6], [8, -6]]),
  key: ctx => { ctx.strokeRect(-10, -6, 20, 12); for (const x of [-6, -2, 2, 6]) circle(ctx, x, -2, 0.7, true); poly(ctx, [[-5, 3], [5, 3]]); },
};
