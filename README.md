# Spatial Desktop

DimOS Desktop in space. The running blueprint is drawn as holograms: on a flat screen it is a cockpit
around a table, in a headset (WebXR) it is a room you stand in. Nothing in it is written for a robot:
every panel and every hologram is built from what the dimos gateway says is running.

![The R1 Pro simulation on the table](docs/images/overview.png)

![The same run in an (emulated) headset](docs/images/headset.png)

## What it shows

- **Blueprint**: the catalog, launch, stop and restart (through Desktop's Launcher, so a launch gets your saved config).
- **Modules**: every module instance of the run, as a list and as a ring of plates around the table. An arc
  joins two modules that share a topic; pulses run from writer to reader at the topic's measured rate.
- **A module**: its docstring, process and CPU, its streams with live rates, and its RPCs. Each RPC opens
  into a form made from its signature (toggle for `bool`, choices for `Literal`/`Enum`, number and text
  boxes, JSON for the rest) with a CALL button and the result. Restart and Unload need a second press.
- **Layers**: the streams that have a drawing, placed by tf.

  | message | drawn as |
  |---|---|
  | `sensor_msgs.PointCloud2` | points coloured by height (a dense map as dots, a scan as light) |
  | depth `Image` + colour `Image` + `CameraInfo` | a textured surface where the camera sees it |
  | `sensor_msgs.Image` alone | a frustum with the picture on its far end |
  | URDF from `UrdfManager` (`/render_file_request`, `/file_info`) | the robot as a hologram or a solid; other models as scenery |
  | `nav_msgs.Odometry`, `PoseStamped` | a marker with a trail |
  | `nav_msgs.Path`, `nav_msgs.OccupancyGrid` | a line, a textured plane |
  | `tf2_msgs.TFMessage` | frame axes |

- **Agent**: a chat with the agent of an agentic blueprint (`/human_input`, `/agent`, `/agent_idle`), typed
  or dictated. Desktop's own agent and the `dimos agent` harness are not reachable from this page yet.
- **Logs**, **Load** (per-process CPU and memory, per-topic rate and bytes) and **View** (scale, floor, lid, life size).

Desktop is told what the app shows, so an agent that asks Desktop can know what you are looking at, and
`POST /gateways/desktop/views/<app>/highlight {"kind": "module", "id": "<module id>"}` flashes that module.

## Controls

| | screen | headset |
|---|---|---|
| point and press | mouse | controller ray + trigger, or hand ray + pinch |
| move a panel | drag its title | grip on the panel (stick reels it in and out) |
| orbit | left drag on empty space | walk |
| slide the world | right drag | press or grip in empty space and move the hand |
| scale and turn the world | pinch on a trackpad, ctrl + wheel | two hands; right stick |
| scroll | wheel | stick over a panel, or press and drag |
| type | keyboard | system keyboard where the browser has one, else the holographic keyboard |

A robot that drives stays in the middle of the table until you take hold of the world.

## Install

```sh
dimos-desktop install /absolute/path/to/this/repo --name dim-spatial-desktop --ref main
```

Then open **Spatial Desktop** in Desktop, or `http://127.0.0.1:5555/apps/dim-spatial-desktop/` in its own tab.
It is a static app: no build step, no server.

### In a headset

WebXR needs a secure context, and the headset must reach Desktop.

- **Quest over USB**: `adb reverse tcp:5555 tcp:5555`, then open `http://localhost:5555/apps/dim-spatial-desktop/`
  in the headset's browser.
- **Any headset on the network**: give Desktop a certificate (`config.yaml`: `desktop: {tls: {cert, key, port: 5443}}`),
  turn network access on (`dimos-desktop password`), and open `https://<this machine>:5443/apps/dim-spatial-desktop/`.

The VR and MIXED buttons appear in the command bar when the browser reports a headset.
This was developed against an emulated headset (see below). It has not been run on a physical device yet.

## Develop

```sh
./sync.sh                                 # copy the working tree into Desktop's install of the app
dimos-desktop app check .                 # every gateway call is declared in dimos.yaml
for f in $(find frontend/src -name '*.js'); do node --check "$f"; done
```

Append `?emulate` to the URL for an in-page WebXR runtime ([IWER](https://github.com/meta-quest/immersive-web-emulation-runtime)):
`window.xrDevice` then drives a virtual headset, controllers and hands, and `window.spatial` is the app.

## Limits

- One blueprint at a time, as the gateway.
- A `UrdfManager` given several models answers `*.urdf` with the first. The others are asked for by the
  names in the blueprint's config, which works when the gateway can read them.
- Mesh files are kept in the browser (IndexedDB) by path. A mesh changed in place under the same path
  stays stale until the site data is cleared.
- On a standalone headset meshes past 600 000 triangles in total are left out.
