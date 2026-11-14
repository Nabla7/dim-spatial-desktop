# Spatial Desktop

A DimOS Desktop app: a page (three.js + WebXR, no build step) and a small Deno server. The page shows
the running blueprint as holograms, a heads-up cockpit on a screen and a room in a headset. The server
serves the page, runs the coding agents the page talks to (Claude Code, Codex), reads the Python
source behind an RPC, reads recorded episodes for the replay, and reads and checks USD scenes. Read
README.md for what it does and docs/SCENES.md for what a scene is.

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
- **An episode starts and ends on a press.** The episode control's `command` is called from START, SAVE,
  DISCARD or their keys, never by the page itself. Asking it where it stands (`get_status`) is reading.
- **On a screen the panels are in front.** They are drawn after the scene and hit before it (`App.renderFlat`,
  `Pointers.cast`). In a headset they stand in the room and the nearer thing is in front. A change to
  either must keep the two the same: what is drawn on top is what takes the press.
- **A recording is read, never written.** Replay computes nothing into a dataset's folders: a world made
  again and a dataset check go under this app's data folder. Re-simulation runs only on a press.
- **The page knows no recording format.** An episode reaches it as a clock with named cameras, signals,
  bands, checks and facts, and a world as shapes fixed to bodies with a pose table. What a file format or
  a robot needs is in the reader (`server/replay/`), found from the data (the simulation record), not named.
- **A scene is read, never written.** Derived views, checks, pins, pictures and the record of revisions go
  under this app's data folder. A change to a scene is a new USD file that an agent (or a person) writes
  and announces; the page shows it and the user keeps or rejects it. Nothing here edits a USD.
- **The page knows no scene format, and no scene.** It gets glTF derived from the USD, a check report,
  rays answered by the compiled model, and what the manifest says (places, forms, recorded views). What is
  particular to one scene belongs in its `scene.json`, not in code.
- **What a scene is asked is asked of the engine.** A press, a floor, a body that fits: the answer comes
  from the model sim2's loader compiles (`check.World`), not from the triangles the page draws.

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
server/replay.ts            datasets on disk, the reader process per Python runtime, routes api/replay/*
server/replay/worker.py     reads an episode: frames, checks, images, the model's shapes, where each body was
server/replay/recover.py    runs an episode's physics again in sim2 and compares it with the recording
server/worker.ts            what the readers share: a long-lived Python process, a followed one, bytes in an answer
server/scenes.ts            scenes on disk, the Python that can read them, views, checks, rays, pins, revisions; MuJoCo scenes
                            taken in and a blueprint's robot put in a scene, both by Desktop's dimos; routes api/scenes/*
server/scenes/check.py      the check of a scene (docs/SCENES.md); Scene (the USD and its manifest), World (the compiled model)
server/scenes/derive.py     USD -> scene.glb (visible shapes, materials), collision.glb, textures, view.json
server/scenes/worker.py     describes a stage, answers rays with the compiled model, compares two revisions
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
  data/xr-controls.js       WebXR input protocol discovery, controller poses/buttons, explicit source handover and grip release gates
  data/episodes.js          episodes for training: the episode control and its recorders, found by the Spec; status, commands
  data/launch.js            what a launch has to be told: required fields with no value, a session's task and folder
  data/agents.js, cbor.js   chat backends (a session agent per coding agent, the blueprint's own agent)
  data/replay.js            the open episode: playhead, pictures around it, world, dataset check
  data/scenes.js            the open scene: its revision, view, check, floor, what was pointed at, pins, comparison
  ui/holo.js                HoloPanel + Ui: immediate-mode widgets on a canvas, hit regions
  ui/rect.js, icons.js      rect-cut layout, line icons
  ui/dock.js                where panels sit: HUD columns on a screen, arcs in a room; kept panels, decks
  ui/flow.js                which side panels stay and in which column each stands (no drawing; tested)
  ui/textinput.js           the hidden textarea every text box edits through
  input/pointers.js         mouse, controllers, hands -> panel events, picks, world grabs, drive sticks
  xr/session.js, hands.js   entering and leaving sessions; hand joints
  scene/stage.js            the table: robot frame -> scene, scale, clip planes, lid
  scene/layers.js           topics -> layers; tf feed; framing; follow; watchdog
  scene/layer.js            Layer base: visibility drives subscriptions; place() by tf
  scene/tf.js, feeds.js     transform tree; camera video textures shared per topic
  scene/scenes.js           a scene on the table: shapes, layers over them, pins, recorded views, walking
  scene/viz/*.js            one file per kind of drawing
  scene/halo.js             the ring of module plates and topic arcs
  scene/hologram.js         the hologram material the robot model and a replayed world share
  scene/replay.js           a replayed episode's world on the table: bodies, ghost, paths, camera frustums
  panels/*.js               one file per panel; each exports open<Name>(app)
  panels/screen.js          a camera as a screen: the video itself on a surface, four sizes, kept, brought back
  panels/record.js          the episode deck (state, time, START SAVE DISCARD) and the Record panel
tests/*.test.mjs            node --test: the panel flow, episodes, launch asks, shared speeds
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
- **Panels on a screen** (`ui/dock.js`, `ui/flow.js`): a side holds one tool; the next one opened takes its
  place, as before. A panel with its pin lit (`panel.kept`, remembered per panel id) is not given up: the
  next panel stands in a column beside it. A panel the user dragged is out of the columns and is never
  closed for another. Decks stand on one another above the bar. A camera's screen (`panels/screen.js`)
  starts kept, and the kept screens of a blueprint open again when it runs again.
- **Episodes** (`data/episodes.js`, `panels/record.js`): found as dimos's own operator interface finds
  them (`dimos/imitation/tui.py`): the module that answers `get_status()` and `command(event)` with an
  `EpisodeStatus` is the episode control (`EpisodeControlSpec`), whatever its class. The String stream it
  writes carries each change as JSON; a module that reads that stream and writes none is a recorder, and
  its other inputs are what an episode holds (one that reads it and writes too is the operator's headset).
  Nothing names a recorder class or a robot.
- **What a launch is told** (`data/launch.js`, `panels/launcher.js`): from the blueprint's config as the
  gateway gives it. A field that is required and has no value is asked for. For a blueprint with an
  episode control, the text that control is configured with (the task) and the path its recorder is
  configured with (the folder) are asked for too. Secrets and non-JSON fields stay with Desktop's Launcher.
- **Agents** (`server/session.ts`): a backend turns its program's protocol into the events `init, user,
  thinking, delta, assistant, tool_result, permission, permission_answer, result, limits, note, exit`.
  The page long-polls them. To add an agent, write one more `AgentSession` and list it in `BACKENDS`.
- **Replay** (`server/replay/worker.py`, `data/replay.js`): frame fields are sorted by what they hold
  (lists of numbers are signals, numbers are series, words are bands, booleans are flags); signals with the
  same labels share tracks; the recorded robot is the one named like `robot_type` among the record's robots
  that have every recorded joint; a sampled quantity named like a body of the model is that body's placement.
  The worker answers `episode`, `images`, `scene`, `motion`: bytes travel as `[uint32 n][JSON, n bytes][bytes]`.
  While an episode is open the live layers are hidden and not updated; `ReplayScene` owns the table.
- **Scenes** (`server/scenes.ts`, `data/scenes.js`, `scene/scenes.js`, `panels/scenes.js`): a scene, a
  replayed episode or the live blueprint has the table, one at a time. The view is glTF with y up, turned
  to the table's z up; the files a GLB names are served beside it. Labels and marks keep their size on the
  table (`sized`), and a label shows whole or not at all. WALK is life size with the camera held by
  `SceneView`: `app.frame` then skips OrbitControls.
  A press becomes a ray in the scene's frame, started where it enters what the table's planes show.
  Revisions: number 0 is the manifest's; later ones come from JSON files dropped in the scene's inbox,
  which the page polls. A comparison is always the later revision against the earlier one.

## Adding things

- **A robot in a scene** (`server/scenes.ts`, `data/launch.js`, `panels/launcher.js`): a scene holds no
  robot. A MuJoCo scene named in ADD is converted by Desktop's dimos (`dimos.sim2.scenes.mjcf`) into
  `scenes/imported/<name>` with a manifest. A blueprint that simulates (it has a `SimModule` and a
  `UsdManager` with a `model`) gets a scene row in its launch card; on LAUNCH the server asks dimos
  (`dimos.sim2.scenes.compose`) for the scene with that blueprint's robot at its first place, kept under
  `scenes/cache/composed`, and the launch names it as that module's `model`. No robot is named in this app.
- **A drawing for a message type**: a `Layer` subclass in `scene/viz/` (`start()` subscribes with
  `this.listen(...)`, `update()` places by `this.place(object, frameId)`, materials go through
  `this.stage.clip(...)`), then one line in `Layers.sync()` choosing it by type.
- **A panel**: `panels/<name>.js` exporting `open<Name>(app)` that builds `app.panel({id, title, draw(ui, content)})`
  and calls `app.dock.open(panel, 'left' | 'right')`; add it to the bar in `panels/shell.js`. Give it
  `kept: true` only when the user opens it to watch it (a camera); `tools` puts small buttons in its title bar.
  State changes go through widget callbacks (they invalidate the panel); outside changes call `panel.invalidate()`.
  Listeners use `{signal: panel.signal}` so they end with the panel.
- **A gateway call**: add it to `data/gateway.js` as a string literal and to `dimos.yaml`.
- **A check of an episode**: one `check(...)` in `inspect()` of `server/replay/worker.py`, with `flag(...)`
  for the frames it fails on. It then shows in CHECKS, on the timeline and in the dataset check.
- **Another recording format**: a reader in `server/replay/` that answers the same four requests; the
  page needs no change.
- **A check of a scene**: a function in `server/scenes/check.py` that returns a `Check`, added to `run()`
  (a question about the files) or to `physics_checks()` (a question for the compiled model), and a row in
  docs/SCENES.md. Points to show on the scene go into the check's `data`.
- **Something drawn over a scene**: a `draw...()` in `scene/scenes.js` that fills one of its layer groups
  (materials through `track()`), a switch in `LAYERS` of `panels/scenes.js`.

## Trying a change

`./dev.sh hot` makes Desktop run the server and serve the page from this working tree. A saved file under
`frontend/` then reaches every open page by itself: `update.js` asks `api/version` and reloads (never
under a headset, never while the controls are armed or an agent works). After a change under `server/`
or to `dimos.yaml` run `./dev.sh restart`. Desktop reads `dimos.yaml` from its install folder, not from
here, so a new route is refused with HTTP 403 until `restart` copies the file. `./dev.sh release` goes
back to the committed build.

Check with `node --check` on each module, `deno check server/main.ts` and `dimos-desktop app check .`.
The replay reader runs by hand: `<dimos checkout>/.venv/bin/python server/replay/worker.py describe <episode folder>`.
The scene programs too, with a Python that has OpenUSD and MuJoCo's USD importer: `server/scenes/check.py <scene.usda>`,
`server/scenes/derive.py <scene.usda> <out folder>`, `server/scenes/worker.py describe <scene.usda>` and
`server/scenes/worker.py diff <before.usda> <after.usda>`.
`node --test tests/*.test.mjs` runs the unit tests: logic that needs no page (which panels stay, episodes,
what a launch is told). Everything else is verified in the page against a running blueprint
(`window.spatial` is the app) and with `?emulate` for XR paths. A new file must be `git add`ed before `nix build .#dimosApp` sees it.
Vendored code lives in `frontend/vendor/` (three.js 0.180, IWER 2.8 for emulation only); do not edit it.
