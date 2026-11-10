# Spatial Desktop

A static DimOS Desktop app (three.js + WebXR, no build, no server): the running blueprint as holograms.
The same scene is a heads-up cockpit on a screen and a room in a headset. Read README.md for what it does.

## Rules

- **Nothing is written for a robot or a module.** Panels come from `data/blueprint.js` (the gateway's
  `active/modules`), holograms from message types in `scene/layers.js`. A change that names a robot,
  a module class or a topic of one blueprint is wrong; find the general rule.
- **No DOM for UI.** There is none in an immersive session. Every control is drawn on a panel canvas
  (`ui/holo.js`) and works from a mouse, a controller ray and a hand ray alike.
- **Colors and fonts come from Desktop's theme** (`theme.js` reads `../../theme.css` tokens). No literals.
- **Relative URLs, declared in `dimos.yaml`.** Run `dimos-desktop app check .` after touching `data/gateway.js`.
- **Never actuate without a press.** An RPC is called only from its CALL button; nothing publishes a
  command at load or while idle. Restart, Unload and Stop arm on the first press.
- **A layer subscribes only while shown.** Hidden streams must cost no bandwidth.

## Layout

```
frontend/index.html         theme link, import map (vendor/three), boot note
frontend/src/main.js        entry; ?emulate installs the WebXR emulator
frontend/src/app.js         App: renderer, stage, dock, pointers, bus, blueprint, layers, ring, XR
  theme.js                  Desktop's tokens as canvas colors and THREE.Colors
  data/gateway.js           every HTTP call (dimos gateway, Desktop, Launcher)
  data/bus.js               zenoh-gateway client + msgs.js; key and type helpers; files.File decoder
  data/blueprint.js         the live model: modules, RPCs, streams, topics, rates, process stats
  data/agents.js, cbor.js   chat backends; CBOR for streams of plain Python values
  ui/holo.js                HoloPanel + Ui: immediate-mode widgets on a canvas, hit regions
  ui/rect.js, icons.js      rect-cut layout, line icons
  ui/dock.js                where panels sit: HUD columns on a screen, arcs in a room
  ui/textinput.js           the hidden textarea every text box edits through
  input/pointers.js         mouse, controllers, hands -> panel events, picks, world grabs
  xr/session.js, hands.js   entering and leaving sessions; hand joints
  scene/stage.js            the table: robot frame -> scene, scale, clip planes, lid
  scene/layers.js           topics -> layers; tf feed; framing; follow; watchdog
  scene/layer.js            Layer base: visibility drives subscriptions; place() by tf
  scene/tf.js, feeds.js     transform tree; camera video textures shared per topic
  scene/viz/*.js            one file per kind of drawing
  scene/halo.js             the ring of module plates and topic arcs
  panels/*.js               one file per panel; each exports open<Name>(app)
```

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

`./sync.sh` copies the tree into `~/.dimos/apps/dim-spatial-desktop/` (Desktop serves it as is); reload the page.
After a `dimos.yaml` change also `curl -X POST localhost:5555/gateways/desktop/management/apps/dim-spatial-desktop/reload`.
Check with `node --check` on each module and `dimos-desktop app check .`. There are no unit tests yet;
verify in the page against a running blueprint (`window.spatial` is the app) and with `?emulate` for XR paths.
Vendored code lives in `frontend/vendor/` (three.js 0.180, IWER 2.8 for emulation only); do not edit it.
