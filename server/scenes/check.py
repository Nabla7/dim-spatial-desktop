"""Checks a scene against the scene standard (docs/SCENES.md).

A scene is a USD stage: one frame and one list of objects. This program asks it a fixed list of
yes/no questions, level by level, and prints each answer with its reason. The questions about files
and structure are asked of the USD itself. The questions about floors and bodies are asked of the
model that sim2's own loader compiles from that USD, so the answer is about what a robot would meet.

Nothing here writes into the scene's folder, and nothing here steps a simulation.

    python check.py <scene.usda> [--manifest scene.json] [--level navigable]
                    [--body radius,height,step] [--out report.json] [--map walkable.png]
                    [--floor cells.bin] [--progress]

`--floor` writes the reached floor as float32 x, y, z per cell. `--progress` prints what it is doing as
JSON lines in place of the report (the page's server follows those and reads `--out`).

Run it with the Python of a dimos checkout that has OpenUSD and MuJoCo's USD importer.
"""

from __future__ import annotations

import argparse
from collections import Counter, deque
from dataclasses import asdict, dataclass, field
from importlib import import_module
import hashlib
import json
from pathlib import Path
import sys
import time
from typing import Any

import numpy as np
from pxr import Sdf, Usd, UsdGeom, UsdPhysics

STANDARD = "dimos.scene/0"
MANIFEST = "scene.json"
LEVELS = ("viewable", "navigable")

# Draft limits. Each one is a judgement, kept here so that it is one line to change.
EXTENT_M = (0.5, 2000.0)  # longest side of a scene; outside this the unit is probably not the metre
PLACE_HEIGHT_M = 0.05  # a place says where its floor is; the collision floor is this near
FLOOR_MATCH_M = 0.02  # the floor a camera sees against the floor a wheel touches
FLOOR_MATCH_SHARE = 0.99
RANGE_MATCH_M = 0.10  # the wall a lidar sees against the wall a body touches
RANGE_MATCH_SHARE = 0.95
RAY_REACH_M = 5.0
RAY_HEIGHTS_M = (0.15, 0.6, 1.2)
SAMPLES = 3000
CELL_M = 0.05
MAX_CELLS = 3_000_000
# The body a navigable scene must admit when its manifest names none: an upright cylinder that
# floats `step` above the floor, so it passes anything lower than that and nothing higher.
BODY = {"radius": 0.30, "height": 1.40, "step": 0.03}


def tell(note: str, done: int | None = None) -> None:
    """What the check is doing now, for whoever follows it. --progress replaces this with a printer."""


@dataclass
class Check:
    id: str
    level: str
    state: str  # pass | fail | not_run
    text: str
    data: dict[str, Any] = field(default_factory=dict)


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def some(items: list[str], limit: int = 3) -> str:
    shown = ", ".join(items[:limit])
    return shown + (f" and {len(items) - limit} more" if len(items) > limit else "")


# ---------------------------------------------------------------------------------------------
# The scene as files: the USD stage and the manifest beside it.


class Scene:
    def __init__(self, path: Path, manifest: Path | None) -> None:
        self.path = path.resolve()
        self.folder = self.path.parent
        self.error = ""
        self.stage: Usd.Stage | None = None
        try:
            self.stage = Usd.Stage.Open(str(self.path))
        except Exception as error:  # OpenUSD raises its own error types
            self.error = str(error).strip().splitlines()[-1]
        beside = self.folder / MANIFEST
        self.manifest_path = manifest.resolve() if manifest else (beside if beside.exists() else None)
        self.manifest_beside = self.manifest_path == beside
        self.manifest: dict[str, Any] = {}
        if self.manifest_path:
            self.manifest = json.loads(self.manifest_path.read_text())
        self._assets: list[dict[str, Any]] | None = None
        self._robots: list[Usd.Prim] | None = None

    @property
    def name(self) -> str:
        return str(self.manifest.get("name") or self.path.parent.name)

    def robots(self) -> list[Usd.Prim]:
        """Models that move themselves. A scene holds none: a robot is added when a run starts."""
        assert self.stage
        if self._robots is not None:
            return self._robots
        roots: dict[Sdf.Path, Usd.Prim] = {}
        for prim in self.stage.Traverse():
            driven = prim.HasAPI(UsdPhysics.ArticulationRootAPI) or any(
                name.startswith("PhysicsDriveAPI") for name in prim.GetAppliedSchemas()
            )
            if driven:
                root = self.model_of(prim) or prim
                roots[root.GetPath()] = root
        self._robots = list(roots.values())
        return self._robots

    def model_of(self, prim: Usd.Prim) -> Usd.Prim | None:
        """The object a prim belongs to: its nearest ancestor that USD calls a component."""
        while prim and prim.GetPath() != Sdf.Path.absoluteRootPath:
            if Usd.ModelAPI(prim).GetKind() == "component":
                return prim
            prim = prim.GetParent()
        return None

    def assets(self) -> list[dict[str, Any]]:
        """Every file the composed scene names: who names it, where it is, and its recorded hash."""
        if self._assets is not None:
            return self._assets
        assert self.stage
        found = []
        for layer in self.stage.GetUsedLayers():
            for name in layer.subLayerPaths:
                found.append({"path": name, "layer": layer, "prim": "", "version": ""})
        for prim in self.stage.Traverse():
            names: list[tuple[str, Sdf.Layer]] = []
            for spec in prim.GetPrimStack():
                lists = (spec.referenceList, spec.payloadList)
                for items in lists:
                    for item in list(items.explicitItems) + list(items.prependedItems) + list(items.appendedItems):
                        if item.assetPath:
                            names.append((item.assetPath, spec.layer))
                for attribute in spec.attributes:
                    if str(attribute.typeName) == "asset" and attribute.default is not None and str(attribute.default.path):
                        names.append((str(attribute.default.path), spec.layer))
            info = prim.GetAssetInfo() or {}
            identifier = info.get("identifier")
            if identifier is not None and str(identifier.path):
                names.append((str(identifier.path), prim.GetPrimStack()[0].layer))
            for name, layer in dict.fromkeys(names):
                found.append({"path": name, "layer": layer, "prim": str(prim.GetPath()), "version": str(info.get("version") or ""),
                              "identified": identifier is not None and str(identifier.path) == name})
        for asset in found:
            anchor = Path(asset["layer"].realPath).parent if asset["layer"].realPath else self.folder
            asset["absolute"] = Path(asset["path"]).is_absolute()
            asset["file"] = Path(asset["path"]) if asset["absolute"] else (anchor / asset["path"]).resolve()
        self._assets = found
        return found


def check_opens(scene: Scene) -> Check:
    if not scene.stage:
        return Check("opens", "viewable", "fail", f"OpenUSD cannot open it: {scene.error}")
    missing = sorted({a["path"] for a in scene.assets() if not a["file"].exists()})
    if missing:
        return Check("opens", "viewable", "fail", f"{len(missing)} named files are not there: {some(missing)}", {"missing": missing[:50]})
    files = {str(a["file"]) for a in scene.assets()}
    return Check("opens", "viewable", "pass", f"the stage opens and all {len(files)} files it names are there")


def check_frame(scene: Scene) -> Check:
    stage = scene.stage
    assert stage
    metres, up, root = UsdGeom.GetStageMetersPerUnit(stage), UsdGeom.GetStageUpAxis(stage), stage.GetDefaultPrim()
    wrong = []
    if abs(metres - 1.0) > 1e-9:
        wrong.append(f"one unit is {metres:g} m, not 1 m")
    if up != "Z":
        wrong.append(f"{up} is up, not Z")
    if not root:
        wrong.append("no default prim says where the scene starts")
    if wrong:
        return Check("frame", "viewable", "fail", "; ".join(wrong), {"metersPerUnit": metres, "upAxis": up})
    return Check("frame", "viewable", "pass", f"metres, Z up, the scene starts at {root.GetPath()}")


def scene_bounds(scene: Scene) -> tuple[np.ndarray, np.ndarray] | None:
    """The box around every shape of the scene, from the points themselves: a mesh's own extent is a
    box in its own frame, and a turned box is larger than what it holds."""
    stage = scene.stage
    assert stage
    robots = [r.GetPath() for r in scene.robots()]
    transforms = UsdGeom.XformCache()
    boxes = UsdGeom.BBoxCache(Usd.TimeCode.Default(), [UsdGeom.Tokens.default_, UsdGeom.Tokens.render])
    low, high = np.full(3, np.inf), np.full(3, -np.inf)
    for prim in stage.Traverse():
        if not prim.IsA(UsdGeom.Gprim) or any(prim.GetPath().HasPrefix(r) for r in robots):
            continue
        points = UsdGeom.Mesh(prim).GetPointsAttr().Get() if prim.IsA(UsdGeom.Mesh) else None
        if points:
            matrix = np.array(transforms.GetLocalToWorldTransform(prim))  # row vectors: p' = p @ M
            world = np.asarray(points, dtype=float) @ matrix[:3, :3] + matrix[3, :3]
            low, high = np.minimum(low, world.min(axis=0)), np.maximum(high, world.max(axis=0))
        else:
            box = boxes.ComputeWorldBound(prim).ComputeAlignedRange()
            if not box.IsEmpty():
                low, high = np.minimum(low, box.GetMin()), np.maximum(high, box.GetMax())
    return (low, high) if np.all(np.isfinite(low)) else None


def check_extent(scene: Scene) -> Check:
    bounds = scene_bounds(scene)
    if bounds is None:
        return Check("extent", "viewable", "fail", "the scene has no geometry")
    size = bounds[1] - bounds[0]
    text = f"{size[0]:.1f} x {size[1]:.1f} x {size[2]:.1f} m"
    data = {"min": bounds[0].round(3).tolist(), "max": bounds[1].round(3).tolist()}
    if not EXTENT_M[0] <= float(size.max()) <= EXTENT_M[1]:
        return Check("extent", "viewable", "fail", f"{text}: that is not the size of a place in metres", data)
    return Check("extent", "viewable", "pass", text, data)


def check_portable(scene: Scene) -> Check:
    absolute = sorted({a["path"] for a in scene.assets() if a["absolute"]})
    outside = sorted({a["path"] for a in scene.assets() if not a["absolute"] and scene.folder not in a["file"].parents})
    if absolute or outside:
        parts = []
        if absolute:
            parts.append(f"{len(absolute)} absolute paths ({some(absolute, 1)})")
        if outside:
            parts.append(f"{len(outside)} paths leave the scene's folder ({some(outside, 1)})")
        return Check("portable", "viewable", "fail", "; ".join(parts), {"absolute": absolute[:50], "outside": outside[:50]})
    return Check("portable", "viewable", "pass", "every path is relative and stays inside the scene's folder")


def check_hashes(scene: Scene) -> Check:
    """dimos's own rule (require_asset_hashes): a prim that names a file records that file's hash."""
    assets = [a for a in scene.assets() if a["prim"]]
    unhashed = sorted({a["path"] for a in assets if not a["version"]})
    wrong, known = [], {}
    for asset in assets:
        if not (asset["identified"] and asset["version"].startswith("sha256:") and asset["file"].exists()):
            continue
        key = str(asset["file"])
        if key not in known:
            known[key] = digest(asset["file"])
        if known[key] != asset["version"].split(":", 1)[1]:
            wrong.append(asset["path"])
    wrong = sorted(set(wrong))
    data = {"unhashed": unhashed[:50], "changed": wrong[:50], "verified": len(known) - len(wrong)}
    if wrong:
        return Check("hashes", "viewable", "fail", f"{len(wrong)} files are not the files that were recorded: {some(wrong)}", data)
    if unhashed:
        return Check("hashes", "viewable", "fail", f"{len(unhashed)} files have no recorded hash ({some(unhashed, 2)}); {len(known)} files match theirs", data)
    if not known:
        return Check("hashes", "viewable", "pass", "the scene names no file that needs a hash", data)
    return Check("hashes", "viewable", "pass", f"all {len(known)} recorded hashes match the files", data)


def check_scene_only(scene: Scene) -> Check:
    robots = [str(r.GetPath()) for r in scene.robots()]
    if robots:
        return Check("scene only", "viewable", "fail", f"the scene file holds a robot: {some(robots)}", {"robots": robots})
    return Check("scene only", "viewable", "pass", "no robot is in the scene file")


def describe_shapes(scene: Scene) -> str:
    """What the scene is made of. Not a check: whether a static scene needs separate objects is
    decided by what it is for, and a level above navigable asks it."""
    stage = scene.stage
    assert stage
    robots = [r.GetPath() for r in scene.robots()]
    seen = touched = bodies = 0
    for prim in stage.Traverse():
        if any(prim.GetPath().HasPrefix(r) for r in robots):
            continue
        if prim.HasAPI(UsdPhysics.RigidBodyAPI):
            bodies += 1
        if not prim.IsA(UsdGeom.Gprim):
            continue
        if prim.HasAPI(UsdPhysics.CollisionAPI) and prim.GetAttribute("physics:collisionEnabled").Get() is not False:
            touched += 1
        elif UsdGeom.Imageable(prim).ComputeVisibility() != UsdGeom.Tokens.invisible:
            seen += 1
    moving = f"{bodies} bodies can move" if bodies else "nothing in it can move"
    return f"{seen} visible shapes and {touched} collision shapes; {moving}"


def check_described(scene: Scene) -> Check:
    if not scene.manifest_path:
        return Check("described", "viewable", "fail", f"no {MANIFEST} beside the scene says what it is and what it was made from")
    manifest = scene.manifest
    missing = [key for key in ("standard", "name", "source") if not manifest.get(key)]
    if not missing and not (manifest["source"].get("file") and manifest["source"].get("sha256")):
        missing.append("source.file and source.sha256")
    if missing:
        return Check("described", "viewable", "fail", f"the manifest lacks {some(missing, 5)}")
    if not scene.manifest_beside:
        return Check("described", "viewable", "fail", f"the manifest is not in the scene's folder (read from {scene.manifest_path})")
    return Check("described", "viewable", "pass", f"{manifest['name']}, made from {Path(manifest['source']['file']).name}")


def check_one_source(scene: Scene) -> Check:
    """Each other form of the scene (an Unreal level, a browser mesh) records the source it came from."""
    manifest = scene.manifest
    source = manifest.get("source") or {}
    if not source.get("sha256"):
        return Check("one source", "viewable", "not_run", "needs a manifest that records the source's hash")
    base = scene.manifest_path.parent if scene.manifest_path else scene.folder
    wrong, checked, unseen = [], [], []

    def verify(label: str, file: str | None, expected: str | None) -> None:
        if not (file and expected):
            return
        path = Path(file) if Path(file).is_absolute() else base / file
        if not path.is_file():
            unseen.append(label)
        elif digest(path) != expected:
            wrong.append(f"{label} is not the file that was recorded")
        else:
            checked.append(label)

    verify("the source", source.get("file"), source.get("sha256"))
    forms = dict(manifest.get("forms") or {})
    # A form is made from the source, or from another form that is: a chain is fine, a second source is not.
    known = {source["sha256"]} | {form["sha256"] for form in forms.values() if form.get("sha256")}
    for name, form in forms.items():
        made_from = form.get("source_sha256")
        if not made_from:
            wrong.append(f"{name} does not say what it was made from")
        elif made_from not in known or made_from == form.get("sha256"):
            wrong.append(f"{name} was made from another source ({made_from[:8]})")
        verify(name, form.get("file"), form.get("sha256"))
    data = {"verified": checked, "not_present": unseen, "forms": sorted(forms)}
    if wrong:
        return Check("one source", "viewable", "fail", "; ".join(wrong), data)
    note = f"; not on this disk: {some(unseen)}" if unseen else ""
    return Check("one source", "viewable", "pass",
                 f"{len(forms)} other forms ({some(sorted(forms), 4)}) record the same source {source['sha256'][:8]}; file hashes match for {some(checked, 4)}{note}", data)


# ---------------------------------------------------------------------------------------------
# The scene as a robot meets it: the model sim2 compiles, asked with rays and with a body.


class World:
    """The compiled scene plus one probe body. Rays and the probe meet scene geometry only."""

    def __init__(self, scene: Scene, body: dict[str, float]) -> None:
        import mujoco

        self.mujoco = mujoco
        self.body = body
        started = time.monotonic()
        self.half = (body["height"] - body["step"]) / 2

        def compiled(spec: Any) -> Any:
            probe = spec.worldbody.add_body(name="scene_check_probe")
            probe.add_freejoint()
            probe.add_geom(type=mujoco.mjtGeom.mjGEOM_CYLINDER, size=[body["radius"], self.half, 0], contype=1, conaffinity=1, group=5, mass=1.0)
            return spec.compile()

        # sim2's own loader first. When it cannot compile the scene, MuJoCo's importer is asked, so that
        # the scene can still be looked into: `sim2_error` then says why sim2 itself would not load it.
        self.sim2_error, model = "", None
        try:
            from dimos.robot.assets.model import UsdModel
            from dimos.sim2.geometry.mujoco import build_scene
        except ImportError:
            build_scene = None
        if build_scene:
            try:
                model, self.loader = compiled(build_scene(UsdModel.from_file(scene.path))), "dimos sim2 (build_scene)"
            except Exception as error:  # the importer and the compiler raise their own types
                self.sim2_error = (str(error).strip().splitlines() or [type(error).__name__])[0][:200]
        if model is None:
            import_module("mujoco._usd")
            model, self.loader = compiled(mujoco.MjSpec.from_file(str(scene.path))), "MuJoCo's USD importer, without dimos's loader"
        self.model = model
        self.seconds = time.monotonic() - started
        self.data = mujoco.MjData(model)
        probe_id = model.body("scene_check_probe").id
        self.probe_geom = int(np.flatnonzero(model.geom_bodyid == probe_id)[0])
        self.probe_qpos = int(model.jnt_qposadr[model.body_jntadr[probe_id]])
        # A robot is a body tree with an actuator. Everything else in the model is the scene.
        driven = {int(model.body_rootid[model.jnt_bodyid[j]]) for j in model.actuator_trnid[:, 0] if j >= 0}
        robots = tuple(str(r.GetPath()) + "/" for r in scene.robots())
        driven |= {int(model.body_rootid[model.geom_bodyid[g]]) for g in range(model.ngeom) if robots and model.geom(g).name.startswith(robots)} - {0}
        mine = np.array([int(model.body_rootid[b]) not in driven and b != probe_id for b in model.geom_bodyid])
        touches = (model.geom_contype > 0) | (model.geom_conaffinity > 0)
        alpha = np.where(model.geom_matid >= 0, model.mat_rgba[np.maximum(model.geom_matid, 0), 3], model.geom_rgba[:, 3])
        self.collision = mine & touches
        # What a camera or a lidar meets: MuJoCo's viewer shows groups 0 to 2, higher groups are hulls.
        self.surface = mine & (model.geom_group < 3) & ((alpha > 0) | ~touches)
        others = ~self.collision
        others[self.probe_geom] = False
        model.geom_contype[others] = 0
        model.geom_conaffinity[others] = 0
        # MuJoCo's rays skip a geom with zero alpha, and collision hulls are hidden that way.
        model.geom_matid[self.collision | self.surface] = -1
        model.geom_rgba[self.collision | self.surface, 3] = 1.0
        self._group = np.array([1, 0, 0, 0, 0, 0], dtype=np.uint8)
        self._hit = np.zeros(1, dtype=np.int32)
        self.select("collision")
        mujoco.mj_forward(model, self.data)

    def select(self, kind: str) -> None:
        chosen = self.collision if kind == "collision" else self.surface
        self.model.geom_group[:] = np.where(chosen, 0, 5)

    def ray(self, origin: Any, direction: Any) -> tuple[float, int]:
        """Distance to the first selected geom along a ray, and that geom; -1 when there is none."""
        distance = self.mujoco.mj_ray(self.model, self.data, np.asarray(origin, dtype=float), np.asarray(direction, dtype=float),
                                      self._group, 1, -1, self._hit)
        return float(distance), int(self._hit[0])

    def floor(self, x: float, y: float, top: float, reach: float) -> float | None:
        distance, _ = self.ray((x, y, top), (0, 0, -1))
        return None if distance < 0 or distance > reach else top - distance

    def fits(self, x: float, y: float, floor: float) -> bool:
        """Whether the body stands here: its cylinder, lifted one step above the floor, touches nothing."""
        data, start = self.data, self.probe_qpos
        data.qpos[start : start + 7] = (x, y, floor + self.body["step"] + self.half, 1, 0, 0, 0)
        self.mujoco.mj_kinematics(self.model, data)
        self.mujoco.mj_collision(self.model, data)
        for contact in data.contact[: data.ncon]:
            if contact.dist < 0 and self.probe_geom in (contact.geom1, contact.geom2):
                return False
        return True

    def geom_name(self, geom: int) -> str:
        return self.model.geom(geom).name if geom >= 0 else ""


def storeys(cells: np.ndarray) -> list[float]:
    """The heights that hold much of the reached floor. Stairs and ramps belong to the storey nearest to them."""
    values, counts = np.unique(np.rint(cells[:, 2] / 0.1).astype(int), return_counts=True)
    levels: list[float] = []
    for value in values[counts >= 0.03 * len(cells)]:
        if not levels or value * 0.1 - levels[-1] > 1.0:
            levels.append(round(float(value * 0.1), 2))
    return levels or [round(float(np.median(cells[:, 2])), 2)]


def walk(world: World, start: tuple[float, float, float], bounds: tuple[np.ndarray, np.ndarray]) -> dict[tuple[int, int], list[float]]:
    """Every grid cell the body reaches from `start` by steps no higher than its step, as cell -> floor heights."""
    step = world.body["step"]
    reached: dict[tuple[int, int], list[float]] = {(0, 0): [start[2]]}
    refused: dict[tuple[int, int], list[float]] = {}
    queue = deque([(0, 0, start[2])])
    count = 1
    while queue and count < MAX_CELLS:
        ix, iy, height = queue.popleft()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            cell = (ix + dx, iy + dy)
            if any(abs(height - other) < 0.5 for other in reached.get(cell, ())) or any(abs(height - other) < 0.01 for other in refused.get(cell, ())):
                continue
            x, y = start[0] + cell[0] * CELL_M, start[1] + cell[1] * CELL_M
            inside = bounds[0][0] <= x <= bounds[1][0] and bounds[0][1] <= y <= bounds[1][1]
            floor = world.floor(x, y, height + step + 0.01, 2 * step + 0.02) if inside else None
            if floor is None or not world.fits(x, y, floor):
                refused.setdefault(cell, []).append(height)
                continue
            reached.setdefault(cell, []).append(floor)
            queue.append((cell[0], cell[1], floor))
            count += 1
            if count % 5000 == 0:
                tell("walking the floor", count)
    return reached


def physics_checks(scene: Scene, body: dict[str, float], map_path: Path | None, floor_path: Path | None = None) -> list[Check]:
    checks: list[Check] = []
    stage = scene.stage
    assert stage

    def waiting(*ids: str, why: str) -> None:
        checks.extend(Check(i, "navigable", "not_run", why) for i in ids)

    # collision: shapes exist, and each is one MuJoCo can collide (convex or a primitive)
    robots = [r.GetPath() for r in scene.robots()]
    shapes, concave = 0, []
    for prim in stage.Traverse():
        if not prim.HasAPI(UsdPhysics.CollisionAPI) or any(prim.GetPath().HasPrefix(r) for r in robots):
            continue
        if prim.GetAttribute("physics:collisionEnabled").Get() is False:
            continue
        shapes += 1
        approximation = prim.GetAttribute("physics:approximation").Get()
        if prim.IsA(UsdGeom.Mesh) and approximation not in ("convexHull", "convexDecomposition", "boundingCube", "boundingSphere"):
            concave.append(str(prim.GetPath()))
    if not shapes:
        checks.append(Check("collision", "navigable", "fail", "the scene has no collision shapes"))
    elif concave:
        checks.append(Check("collision", "navigable", "fail", f"{len(concave)} of {shapes} collision meshes are not declared convex: {some(concave, 2)}", {"concave": concave[:50]}))
    else:
        checks.append(Check("collision", "navigable", "pass", f"{shapes} collision shapes, each convex or a primitive", {"shapes": shapes}))

    # loads: sim2's own loader compiles it
    tell("compiling the scene with sim2's loader")
    try:
        world = World(scene, body)
    except Exception as error:  # the importer and the compiler raise their own types
        checks.append(Check("loads", "navigable", "fail", f"sim2's loader cannot compile it: {str(error).strip().splitlines()[-1][:200]}"))
        waiting("places", "floor", "walkable", "seen is solid", why="needs a scene that loads")
        return checks
    model = world.model
    counts = f"{int(world.collision.sum())} collision shapes, {int(world.surface.sum())} visible shapes"
    if world.sim2_error:
        checks.append(Check("loads", "navigable", "fail",
                            f"sim2's loader cannot compile it: {world.sim2_error}. MuJoCo's own importer can ({counts}), and the questions below were asked of that",
                            {"seconds": round(world.seconds, 1), "loader": world.loader, "sim2_error": world.sim2_error}))
    else:
        checks.append(Check("loads", "navigable", "pass", f"compiles in {world.seconds:.0f} s with {world.loader}: {counts}",
                            {"seconds": round(world.seconds, 1), "loader": world.loader}))
    if not world.collision.any():
        waiting("places", "floor", "walkable", "seen is solid", why="needs collision shapes")
        return checks

    # places: the manifest names where a robot can stand
    places = [p for p in scene.manifest.get("places") or [] if p.get("name") and len(p.get("position") or []) == 3]
    if not places:
        checks.append(Check("places", "navigable", "fail", "the manifest names no place where a robot can stand, so nothing can start or be sent anywhere"))
        waiting("floor", "walkable", "seen is solid", why="needs at least one place")
        return checks
    checks.append(Check("places", "navigable", "pass", f"{len(places)} places: {some([p['name'] for p in places], 8)}"))

    # floor: under each place there is a floor at the stated height, and the body stands on it
    stand: dict[str, tuple[float, float, float]] = {}
    wrong = []
    for place in places:
        x, y, z = (float(v) for v in place["position"])
        floor = world.floor(x, y, z + 0.5, 1.0)
        if floor is None:
            wrong.append(f"{place['name']}: no floor within 0.5 m")
        elif abs(floor - z) > PLACE_HEIGHT_M:
            wrong.append(f"{place['name']}: floor at {floor:.2f} m, stated {z:.2f} m")
        elif not world.fits(x, y, floor):
            wrong.append(f"{place['name']}: the body does not fit")
        else:
            stand[place["name"]] = (x, y, floor)
    shape = f"a body {body['radius'] * 2:.2f} m wide and {body['height']:.2f} m high that clears {body['step'] * 100:.0f} cm"
    if wrong:
        checks.append(Check("floor", "navigable", "fail", "; ".join(wrong), {"standing": sorted(stand)}))
    else:
        checks.append(Check("floor", "navigable", "pass", f"at all {len(places)} places the floor is where the manifest says and {shape} stands on it"))
    if not stand:
        waiting("walkable", "seen is solid", why="needs a place the body can stand on")
        return checks

    # walkable: from the first place, the body reaches every other place
    solid = np.flatnonzero(world.collision)
    reach = model.geom_rbound[solid, None]
    low, high = (world.data.geom_xpos[solid] - reach).min(axis=0), (world.data.geom_xpos[solid] + reach).max(axis=0)
    first = next(iter(stand))
    origin = stand[first]
    started = time.monotonic()
    tell("walking the floor", 0)
    reached = walk(world, origin, (low, high))
    cells = np.array([(origin[0] + ix * CELL_M, origin[1] + iy * CELL_M, z) for (ix, iy), heights in reached.items() for z in heights])
    area = len(cells) * CELL_M**2
    arrived, lost = [first], []
    for name, (x, y, z) in list(stand.items())[1:]:
        near = (np.hypot(cells[:, 0] - x, cells[:, 1] - y) < 4 * CELL_M) & (np.abs(cells[:, 2] - z) < 0.3)
        (arrived if near.any() else lost).append(name)
    levels = storeys(cells)
    nearest = np.abs(cells[:, 2][:, None] - np.array(levels)[None, :]).argmin(axis=1)
    data = {"area_m2": round(area, 1), "cells": len(cells), "cell_m": CELL_M, "from": first, "reached": arrived, "not_reached": lost,
            "seconds": round(time.monotonic() - started, 1), "body": body, "stand": {name: [round(v, 3) for v in at] for name, at in stand.items()},
            "storeys": [{"height": level, "area_m2": round(float((nearest == index).sum()) * CELL_M**2, 1)} for index, level in enumerate(levels)]}
    if floor_path:
        floor_path.parent.mkdir(parents=True, exist_ok=True)
        cells.astype("<f4").tofile(floor_path)
    if len(cells) >= MAX_CELLS:
        checks.append(Check("walkable", "navigable", "fail", f"the walk from {first} did not end after {MAX_CELLS} cells: the floor has no edge", data))
    elif lost:
        checks.append(Check("walkable", "navigable", "fail", f"from {first}, {shape} reaches {area:.0f} m2 but not {some(lost, 6)}", data))
    else:
        checks.append(Check("walkable", "navigable", "pass", f"from {first}, {shape} reaches {area:.0f} m2 and all {len(stand)} places", data))
    if map_path:
        draw_map(map_path, cells, stand, lost, scene.name, shape)

    # seen is solid: what a camera or lidar sees is what a body touches
    if not world.surface.any():
        checks.append(Check("seen is solid", "navigable", "fail", "the scene has no visible shapes to compare the collision shapes with"))
        return checks
    tell("comparing what is seen with what is solid")
    rng = np.random.default_rng(0)
    sample = cells[rng.choice(len(cells), size=min(SAMPLES, len(cells)), replace=False)]
    directions = [(np.cos(a), np.sin(a), 0.0) for a in np.arange(8) * np.pi / 4]
    measured: dict[str, list[tuple[float, int]]] = {}
    for kind in ("collision", "surface"):
        world.select(kind)
        rows = []
        for x, y, z in sample:
            rows.append(world.ray((x, y, z + 0.5), (0, 0, -1)))
            for h in RAY_HEIGHTS_M:
                rows.extend(world.ray((x, y, z + h), d) for d in directions)
        measured[kind] = rows
    world.select("collision")
    per = 1 + len(RAY_HEIGHTS_M) * len(directions)
    solid = np.array([d for d, _ in measured["collision"]]).reshape(-1, per)
    seen = np.array([d for d, _ in measured["surface"]]).reshape(-1, per)
    seen_geom = np.array([g for _, g in measured["surface"]]).reshape(-1, per)
    solid_geom = np.array([g for _, g in measured["collision"]]).reshape(-1, per)
    floor_gap = np.abs(np.where(seen[:, 0] < 0, np.inf, seen[:, 0]) - solid[:, 0])
    floor_share = float(np.mean(floor_gap <= FLOOR_MATCH_M))
    far = lambda values: np.where((values < 0) | (values > RAY_REACH_M), RAY_REACH_M, values)  # noqa: E731
    gap = far(solid[:, 1:]) - far(seen[:, 1:])
    unseen = gap < -RANGE_MATCH_M  # a body stops where nothing is visible
    hollow = gap > RANGE_MATCH_M  # something is visible and a body passes through it
    share = float(np.mean(~unseen & ~hollow))

    # Where each disagreeing ray ends, so that the shapes behind the numbers can be looked at.
    origins = np.array([(x, y, z + h) for x, y, z in sample for h in RAY_HEIGHTS_M for _ in directions]).reshape(len(sample), -1, 3)
    aims = np.array([d for _ in sample for _ in RAY_HEIGHTS_M for d in directions]).reshape(len(sample), -1, 3)

    def worst(mask: np.ndarray, geoms: np.ndarray, ranges: np.ndarray) -> list[dict[str, Any]]:
        ends = origins[mask] + aims[mask] * ranges[:, 1:][mask][:, None]
        names = np.array([world.geom_name(int(g)) for g in geoms[:, 1:][mask]])
        rows = []
        for name, count in Counter(names.tolist()).most_common(5):
            rows.append({"shape": name, "rays": count, "near": ends[names == name].mean(axis=0).round(2).tolist()})
        return rows

    marks = []
    for kind, mask, ranges in ((0, unseen, solid), (1, hollow, seen)):
        ends = (origins[mask] + aims[mask] * ranges[:, 1:][mask][:, None]).round(3)
        marks += [[*end, kind] for end in ends[:: max(1, len(ends) // 300)].tolist()]
    data = {"points": len(sample), "rays": int(gap.size), "floor_share": round(floor_share, 4), "marks": marks, "floor_gap_p99_m": round(float(np.percentile(floor_gap[np.isfinite(floor_gap)], 99)), 4),
            "agree_share": round(share, 4), "unseen_share": round(float(unseen.mean()), 4), "hollow_share": round(float(hollow.mean()), 4),
            "unseen_by": worst(unseen, solid_geom, solid), "hollow_at": worst(hollow, seen_geom, seen)}
    text = (f"{share * 100:.1f} % of {gap.size} rays agree within {RANGE_MATCH_M * 100:.0f} cm; "
            f"{unseen.mean() * 100:.1f} % stop at a shape that is not visible, {hollow.mean() * 100:.1f} % see a shape a body passes through; "
            f"the floors agree within {FLOOR_MATCH_M * 100:.0f} cm at {floor_share * 100:.1f} % of {len(sample)} points")
    ok = share >= RANGE_MATCH_SHARE and floor_share >= FLOOR_MATCH_SHARE
    checks.append(Check("seen is solid", "navigable", "pass" if ok else "fail", text, data))
    return checks


def draw_map(path: Path, cells: np.ndarray, stand: dict[str, tuple[float, float, float]], lost: list[str], name: str, shape: str) -> None:
    """The reached floor from above, one panel for each storey."""
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    levels = storeys(cells)
    storey = np.abs(cells[:, 2][:, None] - np.array(levels)[None, :]).argmin(axis=1)
    count = len(levels)
    figure, panels = plt.subplots(1, count, figsize=(9 * count, 8), dpi=130, squeeze=False)
    x0, y0 = cells[:, 0].min(), cells[:, 1].min()
    for index, axes in enumerate(panels[0]):
        mine = cells[storey == index]
        columns = np.rint((mine[:, 0] - x0) / CELL_M).astype(int)
        rows = np.rint((mine[:, 1] - y0) / CELL_M).astype(int)
        grid = np.full((rows.max() + 1, columns.max() + 1), np.nan)
        grid[rows, columns] = mine[:, 2]
        extent = (x0 - CELL_M / 2, x0 + (columns.max() + 0.5) * CELL_M, y0 - CELL_M / 2, y0 + (rows.max() + 0.5) * CELL_M)
        image = axes.imshow(grid, origin="lower", extent=extent, cmap="viridis", interpolation="nearest")
        figure.colorbar(image, ax=axes, shrink=0.7, label="floor height (m)")
        low, high = mine[:, 2].min() - 0.3, mine[:, 2].max() + 0.3
        for label, (x, y, z) in stand.items():
            missed = label in lost
            if not (low <= z <= high) and not (missed and index == 0):
                continue
            colour = "#d62728" if missed else "black"
            axes.plot(x, y, "x" if missed else "o", color=colour, markersize=7)
            axes.annotate(label + (f" (not reached, floor at {z:.1f} m)" if missed else ""), (x, y), textcoords="offset points", xytext=(7, 6),
                          fontsize=9, color=colour, bbox={"facecolor": "white", "edgecolor": "none", "alpha": 0.8, "pad": 1})
        axes.set_aspect("equal")
        axes.set_xlabel("x (m)")
        axes.set_ylabel("y (m)")
        axes.set_title(f"floor near {levels[index]:.1f} m: {len(mine) * CELL_M**2:.0f} m2", fontsize=10)
    figure.suptitle(f"{name}: floor reached by {shape}", fontsize=11)
    figure.tight_layout()
    path.parent.mkdir(parents=True, exist_ok=True)
    figure.savefig(path)
    plt.close(figure)


# ---------------------------------------------------------------------------------------------


def run(path: Path, manifest: Path | None, level: str, body: dict[str, float] | None, map_path: Path | None, floor_path: Path | None = None) -> dict[str, Any]:
    tell("reading the scene's files")
    scene = Scene(path, manifest)
    checks = [check_opens(scene)]
    if scene.stage:
        checks += [check_frame(scene), check_extent(scene), check_portable(scene), check_hashes(scene),
                   check_scene_only(scene), check_described(scene), check_one_source(scene)]
        chosen = body or {**BODY, **(scene.manifest.get("body") or {})}
        if level == "navigable":
            checks += physics_checks(scene, chosen, map_path, floor_path)
    else:
        chosen = body or BODY
    reached = None
    for name in LEVELS[: LEVELS.index(level) + 1]:
        if any(c.state != "pass" for c in checks if c.level == name):
            break
        reached = name
    return {"standard": STANDARD, "scene": str(scene.path), "name": scene.name, "manifest": str(scene.manifest_path or ""),
            "holds": describe_shapes(scene) if scene.stage else "", "body": chosen, "level": reached, "asked": level,
            "checks": [asdict(c) for c in checks]}


def show(report: dict[str, Any]) -> str:
    lines = [f"SCENE  {report['name']}   {report['scene']}"]
    if report["holds"]:
        lines.append(f"HOLDS  {report['holds']}")
    words = {"pass": "PASS    ", "fail": "FAIL    ", "not_run": "NOT RUN "}
    for level in LEVELS[: LEVELS.index(report["asked"]) + 1]:
        lines += ["", level.upper()]
        for check in report["checks"]:
            if check["level"] == level:
                lines.append(f"  {words[check['state']]} {check['id']:<14} {check['text']}")
    lines.append("")
    for level in LEVELS[: LEVELS.index(report["asked"]) + 1]:
        mine = [c for c in report["checks"] if c["level"] == level]
        lines.append(f"{level}: {sum(c['state'] == 'pass' for c in mine)} of {len(mine)} pass")
    lines.append(f"The scene is {report['level'] or 'at no level yet'}.")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("scene", type=Path)
    parser.add_argument("--manifest", type=Path, help=f"read this manifest instead of the {MANIFEST} beside the scene")
    parser.add_argument("--level", choices=LEVELS, default=LEVELS[-1])
    parser.add_argument("--body", help="radius,height,step in metres, instead of the manifest's body")
    parser.add_argument("--out", type=Path, help="also write the report as JSON")
    parser.add_argument("--map", type=Path, help="also draw the reached floor as a PNG")
    parser.add_argument("--floor", type=Path, help="also write the reached floor: float32 x, y, z for each cell")
    parser.add_argument("--progress", action="store_true", help="print what is being done as JSON lines, not the report")
    args = parser.parse_args()
    if args.progress:
        globals()["tell"] = lambda note, done=None: print(json.dumps({"note": note, "done": done}), flush=True)
    body = dict(zip(("radius", "height", "step"), (float(v) for v in args.body.split(",")), strict=True)) if args.body else None
    report = run(args.scene, args.manifest, args.level, body, args.map, args.floor)
    report["at"] = time.time()
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(report, indent=1))
    if not args.progress:
        print(show(report))
    return 0 if report["level"] == args.level else 1


if __name__ == "__main__":
    sys.exit(main())
