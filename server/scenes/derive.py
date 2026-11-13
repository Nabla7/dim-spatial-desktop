"""Makes what a browser draws from a USD scene.

    python derive.py <scene.usda> <out folder> [--texture 1024]

It writes, into the out folder:

    scene.glb       the visible shapes with their materials (glTF, so y is up there; metres)
    collision.glb   the collision shapes, as one mesh
    textures/       the images the materials use, none larger than --texture on a side
    view.json       what was made, and what of the scene a browser does not get

This is a form of the scene for people, derived from the USD and from nothing else, so what the page
shows is what the scene holds. Robots in the scene file are left out. Each line printed is progress, as
JSON. Nothing is written into the scene's folder.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import struct
import sys
import time
from typing import Any

import numpy as np
from pxr import Usd, UsdGeom, UsdPhysics, UsdShade

from check import Scene

SEGMENTS = 24  # around a sphere, a cylinder or a capsule


def say(**progress: Any) -> None:
    print(json.dumps(progress), flush=True)


# -- shapes ---------------------------------------------------------------------------------------------


def triangles_of(counts: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """For faces of any size: the corner numbers of each triangle (a fan per face), and its face."""
    if len(counts) and np.all(counts == 3):
        return np.arange(len(counts) * 3, dtype=np.int64).reshape(-1, 3), np.arange(len(counts))
    starts = np.concatenate(([0], np.cumsum(counts)[:-1]))
    corners, faces = [], []
    for size in np.unique(counts):
        if size < 3:
            continue
        which = np.flatnonzero(counts == size)
        base = starts[which][:, None]
        for step in range(1, size - 1):
            corners.append(np.hstack([base, base + step, base + step + 1]))
            faces.append(which)
    if not corners:
        return np.zeros((0, 3), dtype=np.int64), np.zeros(0, dtype=np.int64)
    return np.vstack(corners), np.concatenate(faces)


def primitive(prim: Usd.Prim) -> tuple[np.ndarray, np.ndarray] | None:
    """Points and triangles of a sphere, cube, cylinder or capsule, in its own frame."""
    around = np.linspace(0, 2 * np.pi, SEGMENTS, endpoint=False)
    if prim.IsA(UsdGeom.Cube):
        half = float(UsdGeom.Cube(prim).GetSizeAttr().Get() or 2.0) / 2
        points = np.array([[x, y, z] for x in (-half, half) for y in (-half, half) for z in (-half, half)])
        faces = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
        return points, np.array([tri for a, b, c, d in faces for tri in ((a, b, c), (a, c, d))])
    if prim.IsA(UsdGeom.Sphere):
        radius, rings = float(UsdGeom.Sphere(prim).GetRadiusAttr().Get() or 1.0), SEGMENTS // 2
        profile = [(np.sin(a) * radius, np.cos(a) * radius) for a in np.linspace(0, np.pi, rings + 1)]
        axis = "Z"
    elif prim.IsA(UsdGeom.Cylinder) or prim.IsA(UsdGeom.Capsule):
        shape = UsdGeom.Cylinder(prim) if prim.IsA(UsdGeom.Cylinder) else UsdGeom.Capsule(prim)
        radius, half = float(shape.GetRadiusAttr().Get() or 1.0), float(shape.GetHeightAttr().Get() or 2.0) / 2
        axis = str(shape.GetAxisAttr().Get() or "Z")
        if prim.IsA(UsdGeom.Cylinder):
            profile = [(0.0, half), (radius, half), (radius, -half), (0.0, -half)]
        else:
            cap = np.linspace(0, np.pi / 2, SEGMENTS // 4 + 1)
            profile = [(np.sin(a) * radius, half + np.cos(a) * radius) for a in cap] + [(np.cos(a) * radius, -half - np.sin(a) * radius) for a in cap]
    else:
        return None
    # A profile (distance from the axis, height) turned around the axis.
    rows = np.array([[r * np.cos(a), r * np.sin(a), h] for r, h in profile for a in around])
    faces = []
    for ring in range(len(profile) - 1):
        for step in range(SEGMENTS):
            a, b = ring * SEGMENTS + step, ring * SEGMENTS + (step + 1) % SEGMENTS
            faces += [(a, a + SEGMENTS, b + SEGMENTS), (a, b + SEGMENTS, b)]
    if axis == "X":
        rows = rows[:, [2, 0, 1]]
    elif axis == "Y":
        rows = rows[:, [1, 2, 0]]
    return rows, np.array(faces)


def weld(index: np.ndarray, normal: np.ndarray, uv: np.ndarray | None) -> tuple[np.ndarray, np.ndarray]:
    """Corners that share a point, a normal and a texture coordinate become one vertex.

    Returns one corner for each vertex, and for each corner the vertex it became.
    """
    packed = np.clip(np.rint(normal * 127), -127, 127).astype(np.int8).view(np.uint8).astype(np.uint64)
    first = index.astype(np.uint64) | (packed[:, 0] << np.uint64(32)) | (packed[:, 1] << np.uint64(40)) | (packed[:, 2] << np.uint64(48))
    bits = np.ascontiguousarray(uv, dtype=np.float32).view(np.uint32).astype(np.uint64) if uv is not None else np.zeros((len(index), 2), dtype=np.uint64)
    second = bits[:, 0] | (bits[:, 1] << np.uint64(32))
    order = np.lexsort((second, first))
    new = np.ones(len(order), dtype=bool)
    new[1:] = (first[order][1:] != first[order][:-1]) | (second[order][1:] != second[order][:-1])
    vertex = np.empty(len(order), dtype=np.uint32)
    vertex[order] = np.cumsum(new) - 1
    return order[new], vertex


def geometry(prim: Usd.Prim, transforms: UsdGeom.XformCache, textured: bool) -> dict[str, np.ndarray] | None:
    """A shape as triangles in the scene's frame: positions, normals, texture coordinates, indices."""
    if prim.IsA(UsdGeom.Mesh):
        mesh = UsdGeom.Mesh(prim)
        points = np.asarray(mesh.GetPointsAttr().Get() or [], dtype=np.float64)
        counts = np.asarray(mesh.GetFaceVertexCountsAttr().Get() or [], dtype=np.int64)
        corner_point = np.asarray(mesh.GetFaceVertexIndicesAttr().Get() or [], dtype=np.int64)
        if not len(points) or not len(counts):
            return None
        corners, faces = triangles_of(counts)
        if mesh.GetOrientationAttr().Get() == UsdGeom.Tokens.leftHanded:
            corners = corners[:, ::-1]
        at = corner_point[corners]  # the point of each triangle corner

        def spread(values: Any, interpolation: str) -> np.ndarray | None:
            if values is None or not len(values):
                return None
            values = np.asarray(values, dtype=np.float64)
            if interpolation == UsdGeom.Tokens.faceVarying and len(values) == len(corner_point):
                return values[corners]
            if interpolation in (UsdGeom.Tokens.vertex, UsdGeom.Tokens.varying) and len(values) == len(points):
                return values[at]
            if interpolation == UsdGeom.Tokens.uniform and len(values) == len(counts):
                return np.repeat(values[faces][:, None, :], 3, axis=1)
            return None

        normal = spread(mesh.GetNormalsAttr().Get(), mesh.GetNormalsInterpolation())
        st = UsdGeom.PrimvarsAPI(prim).GetPrimvar("st") if textured else None
        uv = spread(st.ComputeFlattened(), st.GetInterpolation()) if st and st.HasValue() else None
        position = points[at]
    else:
        made = primitive(prim)
        if made is None:
            return None
        points, triangles = made
        position, normal, uv = points[triangles], None, None
        at = triangles
    matrix = np.array(transforms.GetLocalToWorldTransform(prim))  # row vectors: p' = p @ M
    turn = matrix[:3, :3]
    position = position @ turn + matrix[3, :3]
    if normal is None:
        normal = np.cross(position[:, 1] - position[:, 0], position[:, 2] - position[:, 0])
        normal = np.repeat(normal[:, None, :], 3, axis=1)
    else:
        normal = normal @ np.linalg.inv(turn).T
    if np.linalg.det(turn) < 0:  # a mirrored shape: its triangles turn the other way
        position, normal, at = position[:, ::-1], normal[:, ::-1], at[:, ::-1]
        uv = None if uv is None else uv[:, ::-1]
    position, normal, at = position.reshape(-1, 3), normal.reshape(-1, 3), at.reshape(-1)
    length = np.linalg.norm(normal, axis=1, keepdims=True)
    normal = np.divide(normal, length, out=np.tile([0.0, 0.0, 1.0], (len(normal), 1)), where=length > 1e-12)
    uv = None if uv is None else uv.reshape(-1, 2).astype(np.float32)
    keep, vertex = weld(at, normal, uv)
    return {"position": position[keep].astype(np.float32), "normal": normal[keep].astype(np.float32),
            "uv": None if uv is None else uv[keep], "index": vertex.astype(np.uint32)}


# -- materials ------------------------------------------------------------------------------------------


def source(shader: UsdShade.Shader, name: str) -> tuple[Any, dict[str, Any] | None]:
    """An input of a surface: its value, or the image it reads."""
    port = shader.GetInput(name)
    if not port:
        return None, None
    for attribute in port.GetValueProducingAttributes():
        node = UsdShade.Shader(attribute.GetPrim())
        if node and node.GetIdAttr().Get() == "UsdUVTexture":
            file = node.GetInput("file").Get() if node.GetInput("file") else None
            path = str(file.resolvedPath or file.path) if file else ""
            if path:
                wrap = tuple(str(node.GetInput(key).Get() or "repeat") if node.GetInput(key) else "repeat" for key in ("wrapS", "wrapT"))
                return None, {"file": path, "wrap": wrap, "channel": attribute.GetBaseName()}
        value = attribute.Get()
        if value is not None:
            return value, None
    return None, None


class Glb:
    """A glTF file being put together: its JSON and one buffer of bytes."""

    def __init__(self, out: Path, texture_size: int) -> None:
        self.out, self.texture_size = out, texture_size
        self.doc: dict[str, Any] = {"asset": {"version": "2.0", "generator": "dimos spatial desktop: scenes/derive.py"}, "scene": 0,
                                    "scenes": [{"nodes": []}], "nodes": [], "meshes": [], "materials": [], "accessors": [], "bufferViews": []}
        self.chunks: list[bytes] = []
        self.size = 0
        self.materials: dict[str, int] = {}
        self.images: dict[str, int] = {}
        self.textures: dict[tuple[int, tuple[str, str]], int] = {}
        self.limits: set[str] = set()

    def view(self, data: np.ndarray, target: int | None, stride: int | None = None) -> int:
        raw = data.tobytes()
        raw += b"\0" * (-len(raw) % 4)
        view: dict[str, Any] = {"buffer": 0, "byteOffset": self.size, "byteLength": len(raw)}
        if target:
            view["target"] = target
        if stride:
            view["byteStride"] = stride
        self.chunks.append(raw)
        self.size += len(raw)
        self.doc["bufferViews"].append(view)
        return len(self.doc["bufferViews"]) - 1

    def accessor(self, view: int, component: int, count: int, kind: str, **more: Any) -> int:
        self.doc["accessors"].append({"bufferView": view, "componentType": component, "count": count, "type": kind, **more})
        return len(self.doc["accessors"]) - 1

    def image(self, file: str, name: str | None = None) -> int | None:
        """Copy an image beside the GLB (smaller when it is larger than the limit) and name it there."""
        key = name or file
        if key in self.images:
            return self.images[key]
        from PIL import Image

        folder = self.out / "textures"
        folder.mkdir(parents=True, exist_ok=True)
        source_file = Path(file)
        if not source_file.is_file():
            self.limits.add(f"an image a material names is not there: {source_file.name}")
            return None
        target = folder / (name or f"{hashlib.sha1(file.encode()).hexdigest()[:8]}-{source_file.name}")
        with Image.open(source_file) as picture:
            if max(picture.size) > self.texture_size:
                picture.thumbnail((self.texture_size, self.texture_size), Image.LANCZOS)
                picture.save(target)
            else:
                shutil.copyfile(source_file, target)
        self.doc.setdefault("images", []).append({"uri": f"textures/{target.name}"})
        self.images[key] = len(self.doc["images"]) - 1
        return self.images[key]

    def texture(self, image: int | None, wrap: tuple[str, str]) -> dict[str, int] | None:
        if image is None:
            return None
        key = (image, wrap)
        if key not in self.textures:
            modes = {"repeat": 10497, "mirror": 33648, "clamp": 33071, "black": 33071}
            self.doc.setdefault("samplers", []).append({"magFilter": 9729, "minFilter": 9987, "wrapS": modes.get(wrap[0], 10497), "wrapT": modes.get(wrap[1], 10497)})
            self.doc.setdefault("textures", []).append({"source": image, "sampler": len(self.doc["samplers"]) - 1})
            self.textures[key] = len(self.doc["textures"]) - 1
        return {"index": self.textures[key]}

    def rough_metal(self, rough: dict[str, Any] | None, metal: dict[str, Any] | None) -> dict[str, int] | None:
        """glTF reads roughness and metalness from the green and blue of one image; USD has one image each."""
        from PIL import Image

        files = [entry["file"] if entry else "" for entry in (rough, metal)]
        name = f"{hashlib.sha1('|'.join(files).encode()).hexdigest()[:10]}-rough-metal.png"
        if name not in self.images:
            pictures = [Image.open(file).convert("L") if file and Path(file).is_file() else None for file in files]
            size = next(picture.size for picture in pictures if picture)
            white = Image.new("L", size, 255)
            bands = [white] + [picture.resize(size) if picture else white for picture in pictures]
            (self.out / "textures").mkdir(parents=True, exist_ok=True)
            packed = Image.merge("RGB", bands)
            packed.thumbnail((self.texture_size, self.texture_size), Image.LANCZOS)
            packed.save(self.out / "textures" / name)
            self.doc.setdefault("images", []).append({"uri": f"textures/{name}"})
            self.images[name] = len(self.doc["images"]) - 1
        return self.texture(self.images[name], (rough or metal or {}).get("wrap", ("repeat", "repeat")))

    def material(self, prim: Usd.Prim) -> tuple[int, bool]:
        """The glTF material of a shape, and whether it reads an image (so the shape needs texture coordinates)."""
        bound = UsdShade.MaterialBindingAPI(prim).ComputeBoundMaterial()[0]
        colour = prim.GetAttribute("primvars:displayColor").Get()
        key = str(bound.GetPath()) if bound else f"colour:{list(colour[0]) if colour else None}"
        if key in self.materials:
            return self.materials[key], self.doc["materials"][self.materials[key]]["extras"]["textured"]
        made: dict[str, Any] = {"name": Path(key).name, "doubleSided": True, "pbrMetallicRoughness": {"metallicFactor": 0.0, "roughnessFactor": 0.6}}
        pbr, textured = made["pbrMetallicRoughness"], False
        shader = bound.ComputeSurfaceSource()[0] if bound else None
        if shader and shader.GetIdAttr().Get() == "UsdPreviewSurface":
            value, image = source(shader, "diffuseColor")
            opacity, opacity_image = source(shader, "opacity")
            alpha = 1.0 if opacity is None else float(opacity)
            if image:
                tile = self.texture(self.image(image["file"]), image["wrap"])
                if tile:
                    pbr["baseColorTexture"], textured = tile, True
                pbr["baseColorFactor"] = [1.0, 1.0, 1.0, alpha]
            elif value is not None:
                pbr["baseColorFactor"] = [float(value[0]), float(value[1]), float(value[2]), alpha]
            if opacity_image and not image:
                self.limits.add("an opacity that comes from its own image is drawn as opaque")
            threshold, _ = source(shader, "opacityThreshold")
            if threshold:
                made["alphaMode"], made["alphaCutoff"] = "MASK", float(threshold)
            elif alpha < 1.0 or (opacity_image and image and opacity_image["file"] == image["file"]):
                made["alphaMode"] = "BLEND"
            rough, rough_image = source(shader, "roughness")
            metal, metal_image = source(shader, "metallic")
            if rough_image or metal_image:
                tile = self.rough_metal(rough_image, metal_image)
                if tile:
                    pbr["metallicRoughnessTexture"], textured = tile, True
                pbr["roughnessFactor"] = 1.0 if rough_image else float(rough if rough is not None else 0.6)
                pbr["metallicFactor"] = 1.0 if metal_image else float(metal or 0.0)
            else:
                pbr["roughnessFactor"] = float(rough if rough is not None else 0.6)
                pbr["metallicFactor"] = float(metal or 0.0)
            _, normal = source(shader, "normal")
            if normal:
                tile = self.texture(self.image(normal["file"]), normal["wrap"])
                if tile:
                    made["normalTexture"], textured = tile, True
            glow, glow_image = source(shader, "emissiveColor")
            if glow_image:
                tile = self.texture(self.image(glow_image["file"]), glow_image["wrap"])
                if tile:
                    made["emissiveTexture"], made["emissiveFactor"], textured = tile, [1.0, 1.0, 1.0], True
            elif glow is not None and max(glow) > 0:
                made["emissiveFactor"] = [float(v) for v in glow]
        elif colour:
            opacity = prim.GetAttribute("primvars:displayOpacity").Get()
            alpha = float(opacity[0]) if opacity else 1.0
            pbr["baseColorFactor"] = [float(colour[0][0]), float(colour[0][1]), float(colour[0][2]), alpha]
            if alpha < 1.0:
                made["alphaMode"] = "BLEND"
        elif bound:
            self.limits.add("a material that is not a UsdPreviewSurface is drawn grey")
        made["extras"] = {"textured": textured, "prim": key}
        self.doc["materials"].append(made)
        self.materials[key] = len(self.doc["materials"]) - 1
        return self.materials[key], textured

    def add(self, name: str, shape: dict[str, np.ndarray], material: int | None) -> None:
        # glTF has y up: the scene's (x, y, z) is written as (x, z, -y), and the page turns it back.
        position = shape["position"][:, [0, 2, 1]] * np.array([1, 1, -1], dtype=np.float32)
        attributes = {"POSITION": self.accessor(self.view(position, 34962), 5126, len(position), "VEC3",
                                                min=position.min(axis=0).tolist(), max=position.max(axis=0).tolist())}
        if shape.get("normal") is not None:
            normal = shape["normal"][:, [0, 2, 1]] * np.array([1, 1, -1], dtype=np.float32)
            packed = np.zeros((len(normal), 4), dtype=np.int8)
            packed[:, :3] = np.clip(np.rint(normal * 127), -127, 127)
            attributes["NORMAL"] = self.accessor(self.view(packed, 34962, 4), 5120, len(packed), "VEC3", normalized=True)
            self.doc["extensionsUsed"] = self.doc["extensionsRequired"] = ["KHR_mesh_quantization"]
        if shape.get("uv") is not None:
            uv = shape["uv"] * np.array([1, -1], dtype=np.float32) + np.array([0, 1], dtype=np.float32)
            attributes["TEXCOORD_0"] = self.accessor(self.view(uv, 34962), 5126, len(uv), "VEC2")
        part: dict[str, Any] = {"attributes": attributes, "indices": self.accessor(self.view(shape["index"], 34963), 5125, len(shape["index"]), "SCALAR")}
        if material is not None:
            part["material"] = material
        self.doc["meshes"].append({"primitives": [part]})
        self.doc["nodes"].append({"name": name, "mesh": len(self.doc["meshes"]) - 1})
        self.doc["scenes"][0]["nodes"].append(len(self.doc["nodes"]) - 1)

    def write(self, path: Path) -> int:
        self.doc["buffers"] = [{"byteLength": self.size}]
        text = json.dumps(self.doc, separators=(",", ":")).encode()
        text += b" " * (-len(text) % 4)
        with path.open("wb") as stream:
            stream.write(struct.pack("<4sII", b"glTF", 2, 12 + 8 + len(text) + 8 + self.size))
            stream.write(struct.pack("<I4s", len(text), b"JSON"))
            stream.write(text)
            stream.write(struct.pack("<I4s", self.size, b"BIN\0"))
            for chunk in self.chunks:
                stream.write(chunk)
        return path.stat().st_size


# -- the scene ------------------------------------------------------------------------------------------


def derive(usd: Path, out: Path, texture_size: int) -> dict[str, Any]:
    started = time.monotonic()
    scene = Scene(usd, None)
    if not scene.stage:
        raise SystemExit(f"OpenUSD cannot open it: {scene.error}")
    stage = scene.stage
    robots = [robot.GetPath() for robot in scene.robots()]
    seen, solid = [], []
    for prim in stage.Traverse():
        if not prim.IsA(UsdGeom.Gprim) or any(prim.GetPath().HasPrefix(robot) for robot in robots):
            continue
        view = UsdGeom.Imageable(prim)
        group = prim.GetAttribute("mjc:group").Get()
        # MuJoCo's viewer shows groups 0 to 2; a higher group is a hull, shown only on request.
        hidden = view.ComputeVisibility() == UsdGeom.Tokens.invisible or view.ComputePurpose() in (UsdGeom.Tokens.guide, UsdGeom.Tokens.proxy) or (group is not None and group >= 3)
        if prim.HasAPI(UsdPhysics.CollisionAPI) and prim.GetAttribute("physics:collisionEnabled").Get() is not False:
            solid.append(prim)
        if not hidden:
            seen.append(prim)
    out.mkdir(parents=True, exist_ok=True)
    transforms = UsdGeom.XformCache()
    total = len(seen) + len(solid)

    glb = Glb(out, texture_size)
    triangles = vertices = skipped = 0
    low, high = np.full(3, np.inf), np.full(3, -np.inf)
    for number, prim in enumerate(seen):
        material, textured = glb.material(prim)
        shape = geometry(prim, transforms, textured)
        if shape is None:
            skipped += 1
            continue
        glb.add(str(prim.GetPath()), shape, material)
        triangles += len(shape["index"]) // 3
        vertices += len(shape["position"])
        low, high = np.minimum(low, shape["position"].min(axis=0)), np.maximum(high, shape["position"].max(axis=0))
        if number % 8 == 0:
            say(done=number, total=total, note="visible shapes")
    if skipped:
        glb.limits.add(f"{skipped} visible shapes are of a kind this does not draw")
    seen_bytes = glb.write(out / "scene.glb") if glb.doc["meshes"] else 0

    # The collision shapes as one mesh: they are looked at together, as a layer over what is seen.
    hulls = Glb(out, texture_size)
    positions, indices, base = [], [], 0
    for number, prim in enumerate(solid):
        if prim.IsA(UsdGeom.Mesh):
            mesh = UsdGeom.Mesh(prim)
            points = np.asarray(mesh.GetPointsAttr().Get() or [], dtype=np.float64)
            corners, _ = triangles_of(np.asarray(mesh.GetFaceVertexCountsAttr().Get() or [], dtype=np.int64))
            faces = np.asarray(mesh.GetFaceVertexIndicesAttr().Get() or [], dtype=np.int64)[corners] if len(corners) else np.zeros((0, 3), dtype=np.int64)
        else:
            made = primitive(prim)
            if made is None:
                continue
            points, faces = made
        if not len(points) or not len(faces):
            continue
        matrix = np.array(transforms.GetLocalToWorldTransform(prim))
        positions.append((points @ matrix[:3, :3] + matrix[3, :3]).astype(np.float32))
        indices.append((faces + base).astype(np.uint32).reshape(-1))
        base += len(points)
        if number % 256 == 0:
            say(done=len(seen) + number, total=total, note="collision shapes")
    solid_bytes = solid_triangles = 0
    if positions:
        merged = {"position": np.vstack(positions), "normal": None, "uv": None, "index": np.concatenate(indices)}
        hulls.add("collision", merged, None)
        solid_triangles = len(merged["index"]) // 3
        solid_bytes = hulls.write(out / "collision.glb")

    report = {
        "scene": str(scene.path), "made": time.time(), "seconds": round(time.monotonic() - started, 1),
        "seen": {"shapes": len(glb.doc["meshes"]), "triangles": triangles, "vertices": vertices, "bytes": seen_bytes,
                 "materials": len(glb.doc["materials"]), "images": len(glb.doc.get("images", []))},
        "solid": {"shapes": len(positions), "triangles": solid_triangles, "bytes": solid_bytes},
        "bounds": None if not np.all(np.isfinite(low)) else {"min": low.round(3).tolist(), "max": high.round(3).tolist()},
        "robots_left_out": [str(path) for path in robots], "texture_size": texture_size, "limits": sorted(glb.limits),
    }
    (out / "view.json").write_text(json.dumps(report, indent=1))
    say(done=total, total=total, note="done")
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("scene", type=Path)
    parser.add_argument("out", type=Path)
    parser.add_argument("--texture", type=int, default=1024, help="the longest side an image may keep")
    args = parser.parse_args()
    if args.out.resolve().is_relative_to(args.scene.resolve().parent):
        raise SystemExit("the out folder must not be inside the scene's folder")
    derive(args.scene, args.out, args.texture)
    return 0


if __name__ == "__main__":
    sys.exit(main())
