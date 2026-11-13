"""Answers the page's questions about a USD scene (the server is the only caller).

    describe   what the stage holds: its frame, shapes, cameras, files, and a stamp that changes when a file does
    ray        what a ray meets: the nearest visible shape and the nearest collision shape
    diff       where two revisions of a scene differ: which shapes changed, and the boxes around what changed

`describe` and `diff` read the USD with OpenUSD. `ray` asks the model that sim2's own loader compiles from
it (check.World), so the answer is about what a simulated camera would see and a body would touch; the
model is compiled on the first ray and kept.

Protocol: one JSON request per line on stdin. Each gets one JSON line on the original stdout,
`{"id", "ok", "bytes", ...}`, followed by `bytes` raw bytes. Whatever a library prints goes to stderr.
Nothing here writes anywhere.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import sys
from typing import Any

import numpy as np
from pxr import Usd, UsdGeom, UsdLux, UsdPhysics

from check import BODY, Scene, World, describe_shapes
from derive import geometry

VOXEL_M = 0.05  # how finely a change is located
BLOCK_M = 0.5  # one box is reported for each block of this size that holds a change
MAX_BOXES = 600


def stamp(stage: Usd.Stage) -> str:
    """A short name for the scene's content: it changes when any file of the scene does."""
    parts = []
    for layer in stage.GetUsedLayers():
        if layer.realPath and os.path.exists(layer.realPath):
            state = os.stat(layer.realPath)
            parts.append(f"{layer.realPath}:{state.st_mtime_ns}:{state.st_size}")
    return hashlib.sha1("\n".join(sorted(parts)).encode()).hexdigest()[:12]


def describe(path: str) -> dict[str, Any]:
    scene = Scene(Path(path), None)
    if not scene.stage:
        raise ValueError(f"OpenUSD cannot open it: {scene.error}")
    stage = scene.stage
    robots = [robot.GetPath() for robot in scene.robots()]
    transforms = UsdGeom.XformCache()
    cameras, lights, bodies = [], 0, 0
    for prim in stage.Traverse():
        if any(prim.GetPath().HasPrefix(robot) for robot in robots):
            continue
        if prim.IsA(UsdGeom.Camera):
            matrix = np.array(transforms.GetLocalToWorldTransform(prim))
            camera = UsdGeom.Camera(prim)
            aperture, focal = camera.GetVerticalApertureAttr().Get(), camera.GetFocalLengthAttr().Get()
            cameras.append({
                "name": prim.GetName(), "position": matrix[3, :3].round(4).tolist(),
                # A USD camera looks along its -z with y up.
                "forward": (-matrix[2, :3]).round(4).tolist(), "up": matrix[1, :3].round(4).tolist(),
                "fovy": round(float(np.degrees(2 * np.arctan(aperture / (2 * focal)))), 2) if aperture and focal else None,
            })
        elif prim.HasAPI(UsdLux.LightAPI):
            lights += 1
        if prim.HasAPI(UsdPhysics.RigidBodyAPI):
            bodies += 1
    # The layers only: naming every image a material reads takes seconds, and the check does that.
    layers = [layer.realPath for layer in stage.GetUsedLayers() if layer.realPath and os.path.exists(layer.realPath)]
    return {
        "usd": str(scene.path), "stamp": stamp(stage), "holds": describe_shapes(scene),
        "frame": {"metres_per_unit": UsdGeom.GetStageMetersPerUnit(stage), "up": str(UsdGeom.GetStageUpAxis(stage)),
                  "root": str(stage.GetDefaultPrim().GetPath()) if stage.GetDefaultPrim() else None},
        "robots": [str(path) for path in robots], "cameras": cameras, "lights": lights, "bodies": bodies,
        "layers": len(layers), "bytes": sum(os.path.getsize(layer) for layer in layers),
    }


class Worlds:
    """The compiled model of the scene asked about last. Compiling takes seconds, a ray microseconds."""

    def __init__(self) -> None:
        self.path = ""
        self.files: dict[str, tuple[int, int]] = {}
        self.world: World | None = None

    def get(self, path: str) -> World:
        # The same scene, with every one of its files as it was when it was compiled: nothing to do.
        if self.world is not None and path == self.path and all(os.path.exists(file) and (os.stat(file).st_mtime_ns, os.stat(file).st_size) == seen for file, seen in self.files.items()):
            return self.world
        scene = Scene(Path(path), None)
        if not scene.stage:
            raise ValueError(f"OpenUSD cannot open it: {scene.error}")
        files = [layer.realPath for layer in scene.stage.GetUsedLayers() if layer.realPath and os.path.exists(layer.realPath)]
        self.world, self.path = World(scene, BODY), path
        self.files = {file: (os.stat(file).st_mtime_ns, os.stat(file).st_size) for file in files}
        return self.world


def ray(world: World, origin: list[float], direction: list[float]) -> dict[str, Any]:
    start, aim = np.asarray(origin, dtype=float), np.asarray(direction, dtype=float)
    length = float(np.linalg.norm(aim))
    if not np.all(np.isfinite(start)) or not length > 0:
        raise ValueError("a ray needs a start and a direction")
    aim = aim / length
    found: dict[str, Any] = {}
    for kind, label in (("surface", "seen"), ("collision", "solid")):
        world.select(kind)
        distance, geom = world.ray(start, aim)
        found[label] = None if distance < 0 else {"distance": round(distance, 4), "point": (start + aim * distance).round(4).tolist(), "shape": world.geom_name(geom)}
    world.select("collision")
    return found


# -- where two revisions differ ---------------------------------------------------------------------------


def shapes_of(scene: Scene, solid: bool) -> dict[str, tuple[str, Usd.Prim]]:
    """Each visible (or each collision) shape of a scene by its path, with a hash of its points and its place."""
    stage = scene.stage
    assert stage
    robots = [robot.GetPath() for robot in scene.robots()]
    transforms = UsdGeom.XformCache()
    found = {}
    for prim in stage.Traverse():
        if not prim.IsA(UsdGeom.Gprim) or any(prim.GetPath().HasPrefix(robot) for robot in robots):
            continue
        collides = prim.HasAPI(UsdPhysics.CollisionAPI) and prim.GetAttribute("physics:collisionEnabled").Get() is not False
        group = prim.GetAttribute("mjc:group").Get()
        hidden = UsdGeom.Imageable(prim).ComputeVisibility() == UsdGeom.Tokens.invisible or (group is not None and group >= 3)
        if (solid and not collides) or (not solid and hidden):
            continue
        content = hashlib.sha1()
        content.update(np.array(transforms.GetLocalToWorldTransform(prim)).tobytes())
        if prim.IsA(UsdGeom.Mesh):
            mesh = UsdGeom.Mesh(prim)
            for attribute in (mesh.GetPointsAttr(), mesh.GetFaceVertexIndicesAttr()):
                content.update(np.asarray(attribute.Get() if attribute.Get() is not None else []).tobytes())
        else:
            for attribute in prim.GetAttributes():
                if attribute.GetName() in ("radius", "height", "size", "axis"):
                    content.update(str(attribute.Get()).encode())
        found[str(prim.GetPath())] = (content.hexdigest(), prim)
    return found


def voxels(prims: list[Usd.Prim]) -> np.ndarray:
    """The cells of a fine grid that the surfaces of these shapes pass through, each as one number."""
    transforms = UsdGeom.XformCache()
    keys = []
    for prim in prims:
        shape = geometry(prim, transforms, False)
        if shape is None:
            continue
        corners = shape["position"][shape["index"].reshape(-1, 3)].astype(np.float64)
        a, b, c = corners[:, 0], corners[:, 1], corners[:, 2]
        longest = np.maximum.reduce([np.linalg.norm(b - a, axis=1), np.linalg.norm(c - b, axis=1), np.linalg.norm(a - c, axis=1)])
        steps = np.clip(np.ceil(longest / VOXEL_M).astype(int), 1, 96)
        # Triangles are sampled on a grid fine enough that no cell they cross is missed, group by group.
        for count in np.unique(steps):
            mine = steps == count
            u, v = np.meshgrid(np.arange(count + 1), np.arange(count + 1), indexing="ij")
            inside = (u + v) <= count
            u, v = u[inside] / count, v[inside] / count
            points = a[mine][:, None, :] + (b[mine] - a[mine])[:, None, :] * u[None, :, None] + (c[mine] - a[mine])[:, None, :] * v[None, :, None]
            cells = np.floor(points.reshape(-1, 3) / VOXEL_M).astype(np.int64) + (1 << 20)
            keys.append(np.unique((cells[:, 0] << 42) | (cells[:, 1] << 21) | cells[:, 2]))
    return np.unique(np.concatenate(keys)) if keys else np.zeros(0, dtype=np.int64)


def boxes(keys: np.ndarray) -> list[list[float]]:
    """Boxes around a set of fine cells: one for each group of cells that lie together.

    Cells are sorted into coarse blocks, blocks that touch are one group, and a group gets one box.
    """
    if not len(keys):
        return []
    mask = (1 << 21) - 1
    cells = np.stack([(keys >> 42) & mask, (keys >> 21) & mask, keys & mask], axis=1) - (1 << 20)
    block = np.floor(cells * VOXEL_M / BLOCK_M).astype(np.int64)
    order = np.lexsort((block[:, 2], block[:, 1], block[:, 0]))
    cells, block = cells[order], block[order]
    starts = np.flatnonzero(np.r_[True, np.any(block[1:] != block[:-1], axis=1)])
    ends = np.r_[starts[1:], len(cells)]
    where = {tuple(block[start]): index for index, start in enumerate(starts)}
    group = [-1] * len(starts)
    found = []
    for index in range(len(starts)):
        if group[index] >= 0:
            continue
        group[index] = len(found)
        members, queue = [], [tuple(block[starts[index]])]
        while queue:
            at = queue.pop()
            members.append(where[at])
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for dz in (-1, 0, 1):
                        other = where.get((at[0] + dx, at[1] + dy, at[2] + dz))
                        if other is not None and group[other] < 0:
                            group[other] = len(found)
                            queue.append((at[0] + dx, at[1] + dy, at[2] + dz))
        mine = np.vstack([cells[starts[member] : ends[member]] for member in members])
        low, high = mine.min(axis=0) * VOXEL_M, (mine.max(axis=0) + 1) * VOXEL_M
        found.append([*low.round(3).tolist(), *high.round(3).tolist(), len(mine)])
    found.sort(key=lambda box: -box[6])
    return found[:MAX_BOXES]


def diff(before: str, after: str) -> dict[str, Any]:
    old, new = Scene(Path(before), None), Scene(Path(after), None)
    for scene in (old, new):
        if not scene.stage:
            raise ValueError(f"OpenUSD cannot open it: {scene.error}")
    result: dict[str, Any] = {"before": str(old.path), "after": str(new.path)}
    for label, solid in (("seen", False), ("solid", True)):
        a, b = shapes_of(old, solid), shapes_of(new, solid)
        gone = sorted(path for path in a if path not in b)
        come = sorted(path for path in b if path not in a)
        changed = sorted(path for path in a if path in b and a[path][0] != b[path][0])
        was = voxels([a[path][1] for path in gone + changed])
        now = voxels([b[path][1] for path in come + changed])
        added, removed = np.setdiff1d(now, was, assume_unique=True), np.setdiff1d(was, now, assume_unique=True)
        result[label] = {
            "shapes": {"added": come[:200], "removed": gone[:200], "changed": changed[:200], "same": len(a) - len(gone) - len(changed)},
            "added": boxes(added), "removed": boxes(removed),
            "added_m2": round(len(added) * VOXEL_M**2, 2), "removed_m2": round(len(removed) * VOXEL_M**2, 2),
        }
    result["same"] = not any(result[label]["added"] or result[label]["removed"] for label in ("seen", "solid"))
    return result


# ---------------------------------------------------------------------------------------------------------


def serve() -> None:
    out = os.fdopen(os.dup(1), "wb")
    os.dup2(2, 1)
    worlds = Worlds()
    for line in sys.stdin:
        if not line.strip():
            continue
        request = json.loads(line)
        try:
            op = request.get("op")
            if op == "describe":
                meta = describe(request["path"])
            elif op == "ray":
                meta = ray(worlds.get(request["path"]), request["origin"], request["direction"])
            elif op == "warm":
                world = worlds.get(request["path"])
                meta = {"seconds": round(world.seconds, 1), "loader": world.loader}
            elif op == "diff":
                meta = diff(request["before"], request["after"])
            elif op == "ping":
                meta = {"python": sys.version.split()[0]}
            else:
                raise ValueError(f"unknown request: {op}")
            head = {"id": request.get("id"), "ok": True, "bytes": 0, "meta": meta}
        except Exception as error:  # every failure goes back to the page as a sentence
            head = {"id": request.get("id"), "ok": False, "bytes": 0, "error": str(error).strip().splitlines()[-1][:400] if str(error).strip() else type(error).__name__}
        out.write(json.dumps(head).encode() + b"\n")
        out.flush()


if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[1] == "describe":
        print(json.dumps(describe(sys.argv[2]), indent=1))
    elif len(sys.argv) > 3 and sys.argv[1] == "diff":
        print(json.dumps(diff(sys.argv[2], sys.argv[3]), indent=1))
    else:
        serve()
