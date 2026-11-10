# Spatial Desktop

A DimOS Desktop app: a page (three.js + WebXR, no build step) and a small Deno server. The page shows
the running blueprint as holograms, a heads-up cockpit on a screen and a room in a headset. The server
serves the page, runs the coding agents the page talks to (Claude Code, Codex), and reads the Python
source behind an RPC. Read README.md for what it does.

## Rules

- **Nothing is written for a robot or a module.** Panels come from `data/blueprint.js` (the gateway's
  `active/modules`), holograms from message types in `scene/layers.js`. A change that names a robot,
  a module class or a topic of one blueprint is wrong; find the general rule.
- **No DOM for UI.** There is none in an immersive session. Every control is drawn on a panel canvas
  (`ui/holo.js`) and works from a mouse, a controller ray and a hand ray alike.
- **Colors and fonts come from Desktop's theme** (`theme.js` reads `../../theme.css` tokens). No literals.
- **Relative URLs, declared in `dimos.yaml`.** Run `dimos-desktop app check .` after touching `data/gateway.js`.
- **Never actuate without a press.** An RPC is called only from a button; nothing publishes a command at
  load or while idle. Every command stream is dead until the Control panel is ARMED, a drive publishes only
  while a pad, key or stick is held, and its first input stores a stop on the gateway (the deadman).
  Restart, Unload and Stop arm on the first press. Nothing may call an RPC to find out what it accepts.
- **Commands need the lease.** The zenoh gateway lets one client at a time publish on a command key.
  `data/controls.js` takes the lease on the first command and gives it back when the controls are made
  safe. A publish that skips `Controls.publish()` is dropped whenever another app (Controller) drove last.
- **An agent is the user's own program.** The server starts `claude` or `codex` with the login that program
  has and removes API keys from its environment. It adds no permissions: a prompt the agent would show in
  a terminal is shown in the panel, and the user answers it.
- **A layer subscribes only while shown.** Hidden streams must cost no bandwidth.

## Layout

```
dimos.yaml                  the contract: gateway calls (uses:) and the server's private routes (x-private)
flake.nix                   packages.<system>.dimosApp = bin/dimos-app-server (deno run server/main.ts)
dev.sh                      hot | restart | release against the Desktop on this machine
server/main.ts              reads DIMOS_APP, serves frontend/, routes api/agent/*, api/source, api/version
server/session.ts           AgentSession: the numbered event log every agent backend fills; shared helpers
server/claude.ts            Claude Code in headless stream-json (stdin turns, stdout events, permission requests)
server/codex.ts             `codex app-server` over JSON-RPC (threads, turns, approval requests)
server/source.ts            the Python source of one method of a module class, found by text, never imported
frontend/index.html         theme link, import map (vendor/three), boot note
frontend/src/update.js      reloads an open page when the server serves a newer build
frontend/src/main.js        entry; ?emulate installs the WebXR emulator
frontend/src/app.js         App: renderer, stage, dock, pointers, bus, blueprint, layers, ring, controls, XR
  theme.js                  Desktop's tokens as canvas colors and THREE.Colors
  util.js                   formatters; RPC parameters: kind from the annotation, typed text -> JSON, docstrings
  data/gateway.js           every HTTP call (dimos gateway, Desktop, Launcher, this app's server)
  data/bus.js               zenoh-gateway client + msgs.js; key and type helpers; files.File decoder
  data/blueprint.js         the live model: modules, RPCs, streams, topics, rates, process stats
  data/controls.js          what can be commanded, found from the blueprint; arming, the lease, the deadman
  data/agents.js, cbor.js   chat backends (a session agent per coding agent, the blueprint's own agent)
  ui/holo.js                HoloPanel + Ui: immediate-mode widgets on a canvas, hit regions
  ui/rect.js, icons.js      rect-cut layout, line icons
  ui/dock.js                where panels sit: HUD columns on a screen, arcs in a room
  ui/textinput.js           the hidden textarea every text box edits through
  input/pointers.js         mouse, controllers, hands -> panel events, picks, world grabs, drive sticks
  xr/session.js, hands.js   entering and leaving sessions; hand joints
  scene/stage.js            the table: robot frame -> scene, scale, clip planes, lid
  scene/layers.js           topics -> layers; tf feed; framing; follow; watchdog
  scene/layer.js            Layer base: visibility drives subscriptions; place() by tf
  scene/tf.js, feeds.js     transform tree; camera video textures shared per topic
  scene/viz/*.js            one file per kind of drawing
  scene/halo.js             the ring of module plates and topic arcs
  panels/*.js               one file per panel; each exports open<Name>(app)
```

## How the general rules are applied

- **Controls** (`data/controls.js`): a stream some module reads is a command it accepts, and its type picks
  the control (Twist: pad, keys, sticks; Float32/Int32: slider; Bool: switch; PoseStamped: point at the
  table; JointState with no writer: jog). An RPC `(name: str, position: float)` is a joint jog too. An RPC
  with no required parameter that is not a getter is an action; `status()` RPCs are read while the panel is open.
- **RPC forms** (`panels/module.js`, `util.js`): the editor comes from the annotation (`paramKind`), help
  from the docstring's `Args:`, values to pick from what runs (joint names and limits from the robot model,
  tf frames, topics, module ids). CODE shows `api/source`. EXPLAIN sends signature and source to a coding
  agent and keeps its answer per class and signature. A class-typed parameter is not sendable (the
  gateway passes JSON through): the form says so and offers the stream of the same type or the agent.
- **Agents** (`server/session.ts`): a backend turns its program's protocol into the events `init, user,
  thinking, delta, assistant, tool_result, permission, permission_answer, result, limits, note, exit`.
  The page long-polls them. To add an agent, write one more `AgentSession` and list it in `BACKENDS`.

## Adding things

- **A drawing for a message type**: a `Layer` subclass in `scene/viz/` (`start()` subscribes with
  `this.listen(...)`, `update()` places by `this.place(object, frameId)`, materials go through
  `this.stage.clip(...)`), then one line in `Layers.sync()` choosing it by type.
- **A panel**: `panels/<name>.js` exporting `open<Name>(app)` that builds `app.panel({id, title, draw(ui, content)})`
  and calls `app.dock.open(panel, 'left' | 'right')`; add it to the bar in `panels/shell.js`.
  State changes go through widget callbacks (they invalidate the panel); outside changes call `panel.invalidate()`.
  Listeners use `{signal: panel.signal}` so they end with the panel.
- **A gateway call**: add it to `data/gateway.js` as a string literal and to `dimos.yaml`.

## Trying a change

`./dev.sh hot` makes Desktop run the server and serve the page from this working tree. A saved file under
`frontend/` then reaches every open page by itself: `update.js` asks `api/version` and reloads (never
under a headset, never while the controls are armed or an agent works). After a change under `server/`
or to `dimos.yaml` run `./dev.sh restart`. Desktop reads `dimos.yaml` from its install folder, not from
here, so a new route is refused with HTTP 403 until `restart` copies the file. `./dev.sh release` goes
back to the committed build.

Check with `node --check` on each module, `deno check server/main.ts` and `dimos-desktop app check .`.
There are no unit tests yet; verify in the page against a running blueprint (`window.spatial` is the app)
and with `?emulate` for XR paths. A new file must be `git add`ed before `nix build .#dimosApp` sees it.
Vendored code lives in `frontend/vendor/` (three.js 0.180, IWER 2.8 for emulation only); do not edit it.
