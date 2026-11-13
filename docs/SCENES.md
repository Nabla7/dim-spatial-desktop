# Scenes: what a scene is, and how one is checked

Draft 0, 2026-11-12. This is a proposal to argue with, not a rule yet. It exists so that a scene made by
any person or agent, in any tool, has one shape the rest of dimos can count on, and so that "is this scene
ready?" has an answer a program gives.

## What a scene is

A scene is **one frame and one list of things in it**. A USD stage holds that: metres, Z up, one default
prim. sim2 already loads a scene from USD and nothing else, so the USD is the scene.

Every other file is a **form** of the same scene, made for one consumer:

| form | who reads it |
|---|---|
| the USD | the physics engine (MuJoCo, dimsim) and whatever else asks for the scene |
| an Unreal level, a Filament scene, a splat | a renderer, for the cameras of a simulated robot |
| a GLB | a browser or a headset, for a person |
| a recording with calibrated cameras, a lidar cloud | whoever asks how near the scene is to the real place |
| a `.blend`, an Unreal project | the author, a person or an agent |

Two rules keep the forms one scene:

- **Physics owns where things are.** A renderer draws the same things at the poses physics gives, in the
  same frame. It does not have its own idea of where a chair is.
- **Every form says what it was made from.** A form records the hash of its source. Two forms that record
  different sources are two scenes.

The tool that made a scene is free. The USD and the checks below are the contract.

## The manifest

`scene.json` beside the USD holds what USD is not the place for:

```json
{
  "standard": "dimos.scene/0",
  "name": "sf555-office",
  "source": {"file": "models/office_v24.blend", "sha256": "18da9931…"},
  "forms": {
    "unreal":  {"project": "unreal/SF555Office", "level": "/Game/SF555/Maps/Office", "source_sha256": "18da9931…"},
    "browser": {"file": "office.glb", "sha256": "b109b492…", "source_sha256": "18da9931…"}
  },
  "places": [
    {"name": "hall", "position": [16.0, 1.0, 0.0]},
    {"name": "kitchen", "position": [2.57, 13.39, 4.91]}
  ],
  "body": {"radius": 0.3, "height": 1.4, "step": 0.03},
  "evidence": "evidence.json",
  "project": "/home/me/office-reconstruction"
}
```

- `source` is the file the scene was made from, with its hash.
- `forms` are the other forms. `source_sha256` is the hash of what a form was made from: the source, or
  another form (a chain is fine).
- `places` are points on the floor where a robot can stand. The first is where a run starts. The others
  are where a robot can be sent.
- `body` is the smallest promise the scene makes: a robot no larger than this gets to every place. It is
  an upright cylinder that floats `step` above the floor, so it passes what is lower and nothing higher.
- `evidence` names what the scene was reconstructed from, as recorded views (below). A scene that was
  designed and not reconstructed has none.
- `project` is the folder where the scene's author works (the Blender or Unreal project, the scripts, the
  author's own notes for agents). An agent that is asked to change the scene is started there. Without
  it, the manifest's own folder is that place.
- `scene` names the USD when it is not the only USD file beside the manifest.

### Recorded views

The recording a scene was made from is its evidence. A view is one picture of it with the pose of the
camera that took it, in the scene's frame:

```json
{
  "camera": {"width": 1280, "height": 720, "fx": 642.8, "fy": 641.8, "cx": 642.2, "cy": 363.1},
  "views": [
    {"name": "Kitchen island", "time": 580, "image": "views/0580.jpg", "thumbnail": "views/0580_thumb.jpg",
     "camera_to_scene": [[0.92, 0.22, -0.34, 2.57], [0.40, -0.47, 0.79, 13.39], [0.01, -0.85, -0.52, 6.44], [0, 0, 0, 1]]}
  ]
}
```

The pictures are undistorted and `camera` is their pinhole model (a view may carry its own). The camera's
frame is the optical one: x to the right of the picture, y down, z ahead. With these, anyone can stand
where the camera stood and lay the picture over the scene, which is the first test of a reconstruction.

## Levels

A level is a list of checks. A use states the level it needs. A scene is at a level when every check of
that level and of the levels before it passes.

| level | it promises | enough for |
|---|---|---|
| **viewable** | it opens anywhere, in metres, complete, and says what it is | looking at it, reviewing it, a deployment view |
| **navigable** | a robot can stand in it, get around it, and sense what it would hit | navigation and lidar simulation, navigation evals |
| manipulable | things in it are separate objects that move, with mass and friction | manipulation, data generation |
| camera-faithful | its pictures are near the real place's, by a stated measure | vision policies |
| calibrated | its physics is identified against the real place | sim to real claims |

Only the first two have checks so far.

### Viewable

| check | the question | why |
|---|---|---|
| `opens` | Does OpenUSD open it, and is every file it names there? | a missing file is silent missing geometry |
| `frame` | Metres, Z up, a default prim? | Unreal works in centimetres and Blender exports any axis |
| `extent` | Is its longest side between 0.5 m and 2 km? | catches a scene that is 100 times too large or too small |
| `portable` | Is every path relative and inside the scene's folder? | a scene has to move to another machine |
| `hashes` | Does every prim that names a file record that file's sha256, and does the file match? | dimos's own rule (`require_asset_hashes`): a path alone cannot say whether the file is the file meant |
| `scene only` | Is there no robot in the scene file? | a robot is added when a run starts, so one scene serves every robot |
| `described` | Is there a manifest beside it with a name and a source? | nobody can repeat or correct a scene of unknown origin |
| `one source` | Does every form record the same source, and do the files still match their hashes? | this is what makes the browser, Unreal and the physics show the same place |

### Navigable

These are asked of the model that sim2's own loader compiles from the USD (`dimos.sim2.geometry.mujoco.build_scene`),
with rays and with the body as a collision probe. The engine answers them, not a second reading of the files.

| check | the question | why |
|---|---|---|
| `collision` | Are there collision shapes, each convex or a primitive? | the engine collides nothing else |
| `loads` | Does sim2's loader compile it? | a scene that does not load is not a scene for sim |
| `places` | Does the manifest name at least one place? | a run has to start somewhere, and an eval has to send the robot somewhere |
| `floor` | Under each place, is the collision floor within 5 cm of the stated height, and does the body stand there? | a robot that starts inside a table, or above a hole, fails before the test begins |
| `walkable` | From the first place, does the body reach every other place by steps no higher than its `step`? | a convex hull that closes a doorway is the usual way a good-looking scene is useless |
| `seen is solid` | From 3000 reached points, do rays to the visible shapes and to the collision shapes end at the same distance (within 10 cm, for 95 % of rays), and do the two floors agree (within 2 cm, at 99 % of points)? | a lidar and a camera see the visible shapes, a body touches the collision shapes; where they differ a robot stops at nothing or drives through a wall |

`walkable` also draws the reached floor as a map, one panel for each storey.

`loads` fails when sim2's loader cannot compile the scene. The questions after it are then asked of the
model MuJoCo's own USD importer compiles, when that one can, and the report says so: the scene can still
be looked into, but sim2 would not run it.

## Revisions

A change to a scene is a new revision: a new USD file, a whole scene in itself. The file that was there
is not edited. This is what lets a person see a change against what was there before, and take it or
leave it.

An agent that makes a revision announces it by writing one small JSON file into the scene's inbox (the
page that shows the scene says where that folder is):

```json
{"usd": "/full/path/to/the/new/scene.usda", "label": "the cart moved out of the doorway"}
```

A revision has to pass the same checks as the scene. One thing to know today: sim2's loader resolves the
relative paths of the root layer only. A root layer that only refers to the earlier revision's root layer
(a thin layer of changes over it) opens in OpenUSD and in MuJoCo's importer, and fails `loads`, because
the layer it refers to has relative paths of its own. A revision that sim2 runs is a root layer that
names its files itself, written beside them.

## Run it

```sh
<dimos checkout>/.venv/bin/python server/scenes/check.py <scene.usda> \
    [--manifest scene.json] [--level viewable|navigable] [--body radius,height,step] \
    [--out report.json] [--map walkable.png] [--floor cells.bin] [--progress]
```

The Python must have OpenUSD (`pxr`) and MuJoCo with its USD importer. The exit code is 0 when the scene is
at the level asked. The program writes nothing into the scene's folder. On the SF555 office (10,244 hulls,
3.2 million visible triangles) a navigable run takes about 80 s.

An agent that builds or changes a scene runs this and repeats until every line passes. That, and not a
document, is what makes the next scene fit.

In Spatial Desktop the same check runs from the SCENES panel (CHECK THE SCENE), which draws the reached
floor and the points of disagreement on the scene and hands the failures to an agent.

## Not decided

- **Where the manifest's facts live.** Beside the USD as here, or inside it as USD metadata. sim2's USD work
  already keeps asset hashes in `assetInfo`.
- **Scene against world.** `get_scene` serves the whole physical tree, robots included. This standard calls
  the part without robots the scene. A composed world file fails `scene only` by design.
- **Objects.** For a scene where nothing moves, no program can say whether its shapes are grouped into the
  right objects: one prim for the whole building passes any rule a chair-by-chair scene passes. The question
  becomes testable at the manipulable level, where an object has to be one body with its own visible and
  collision shapes. Until then the report states what a scene holds and does not judge it.
- **The body.** A floating cylinder is exact for a wheeled base and crude for legs. Stairs are at its limit.
- **The numbers.** 5 cm, 10 cm, 95 % are first guesses. They are constants at the top of `check.py`.
- **Revisions as layers.** USD's own way to state a change is a thin layer over the scene. sim2's loader
  does not load one today (see Revisions). Either the loader learns to, or a revision stays a whole file.
