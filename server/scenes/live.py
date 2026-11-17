"""Derive a live model's visible shapes in their TF body frames, using the scene converter.

The input and every referenced asset arrive through the model's file stream. They stay in the
app's cache; published asset names are never treated as paths on this machine.
"""

import hashlib
import json
from pathlib import Path
import sys

import numpy as np
from pxr import Sdf, Usd, UsdGeom, UsdPhysics, UsdUtils

from derive import Glb, geometry


def asset_key(name: str) -> str:
    return hashlib.sha256(name.encode()).hexdigest() + Path(name).suffix


def body_of(prim: Usd.Prim) -> Usd.Prim:
    while prim and not prim.HasAPI(UsdPhysics.RigidBodyAPI):
        prim = prim.GetParent()
    return prim


def is_collision(prim: Usd.Prim) -> bool:
    return prim.HasAPI(UsdPhysics.CollisionAPI) and prim.GetAttribute("physics:collisionEnabled").Get() is not False


def prepare(folder: Path) -> tuple[Usd.Stage | None, dict]:
    source = Sdf.Layer.FindOrOpen(str(folder / "source.usda"))
    if source is None:
        raise ValueError("the model is not a readable USD layer")
    layer = Sdf.Layer.CreateAnonymous()
    layer.TransferContent(source)
    assets = {}

    def local(name: str) -> str:
        if not name:
            return name
        key = asset_key(name)
        assets[name] = key
        return str(folder / "assets" / key)

    UsdUtils.ModifyAssetPaths(layer, local)
    missing = [{"name": name, "key": key} for name, key in assets.items()
               if not (folder / "assets" / key).is_file()]
    report = {"assets": missing, "ready": False}
    (folder / "assets.json").write_text(json.dumps(assets))
    if missing:
        return None, report
    return Usd.Stage.Open(layer), report


def derive_live(folder: Path) -> dict:
    stage, report = prepare(folder)
    if stage is None:
        return report
    if UsdGeom.GetStageUpAxis(stage) != UsdGeom.Tokens.z or not np.isclose(UsdGeom.GetStageMetersPerUnit(stage), 1):
        raise ValueError("live TF models must use metres and z up")
    transforms = UsdGeom.XformCache()
    glb = Glb(folder, 1024)
    frames = []
    # Match sim2's optical geometry: a body's visual shapes take precedence over its collision hulls.
    visual_bodies = {body.GetPath() for prim in stage.Traverse()
                     if prim.IsA(UsdGeom.Gprim) and not is_collision(prim) and (body := body_of(prim))}
    for prim in stage.Traverse():
        if not prim.IsA(UsdGeom.Gprim):
            continue
        view = UsdGeom.Imageable(prim)
        group = prim.GetAttribute("mjc:group").Get()
        opacity = UsdGeom.Gprim(prim).GetDisplayOpacityAttr().Get()
        body = body_of(prim)
        if (view.ComputeVisibility() == UsdGeom.Tokens.invisible
                or view.ComputePurpose() in (UsdGeom.Tokens.guide, UsdGeom.Tokens.proxy)
                or (opacity and max(opacity) == 0)
                or (body and body.GetPath() in visual_bodies and is_collision(prim))
                or (group is not None and group >= 3)):
            continue
        material, textured = glb.material(prim)
        if glb.doc["materials"][material]["pbrMetallicRoughness"].get("baseColorFactor", [1, 1, 1, 1])[3] == 0:
            continue
        shape = geometry(prim, transforms, textured)
        if shape is None:
            continue
        frame = (body.GetDisplayName() or body.GetName()) if body else ""
        if body:
            inverse = np.linalg.inv(np.array(transforms.GetLocalToWorldTransform(body)))
            shape["position"] = (shape["position"] @ inverse[:3, :3] + inverse[3, :3]).astype(np.float32)
            normal = shape["normal"] @ np.linalg.inv(inverse[:3, :3]).T
            shape["normal"] = (normal / np.maximum(np.linalg.norm(normal, axis=1, keepdims=True), 1e-12)).astype(np.float32)
            if frame not in frames:
                frames.append(frame)
        glb.add(str(prim.GetPath()), shape, material)
        glb.doc["nodes"][-1]["extras"] = {"frame": frame}
    if not glb.doc["meshes"]:
        raise ValueError("this USD model contains no visible shapes")
    glb.write(folder / "model.glb")
    report.update(ready=True, frames=frames, shapes=len(glb.doc["meshes"]), limits=sorted(glb.limits))
    return report


if __name__ == "__main__":
    folder = Path(sys.argv[1]).resolve()
    report = derive_live(folder)
    (folder / "model.json").write_text(json.dumps(report))
