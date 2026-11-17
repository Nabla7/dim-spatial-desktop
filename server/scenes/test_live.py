import json
import struct

import numpy as np
from pxr import Gf, Sdf, Usd, UsdGeom, UsdPhysics

from live import derive_live, prepare


def test_mesh_is_local_to_its_named_tf_body(tmp_path):
    stage = Usd.Stage.CreateNew(str(tmp_path / "source.usda"))
    UsdGeom.SetStageMetersPerUnit(stage, 1)
    UsdGeom.SetStageUpAxis(stage, UsdGeom.Tokens.z)
    body = UsdGeom.Xform.Define(stage, "/body")
    body.AddTranslateOp().Set((10, 20, 30))
    body.AddRotateZOp().Set(90)
    body.GetPrim().SetDisplayName("robot/arm")
    UsdPhysics.RigidBodyAPI.Apply(body.GetPrim())
    mesh = UsdGeom.Mesh.Define(stage, "/body/visual")
    mesh.CreatePointsAttr([(1, 0, 0), (1, 1, 0), (1, 0, 1)])
    mesh.CreateFaceVertexCountsAttr([3])
    mesh.CreateFaceVertexIndicesAttr([0, 1, 2])
    hidden = UsdGeom.Cube.Define(stage, "/body/hidden")
    hidden.CreateVisibilityAttr(UsdGeom.Tokens.invisible)
    transparent = UsdGeom.Cube.Define(stage, "/body/collider")
    transparent.CreateDisplayColorAttr([Gf.Vec3f(1, 1, 1)])
    transparent.CreateDisplayOpacityAttr([0])
    stage.GetRootLayer().Save()

    result = derive_live(tmp_path)

    assert result["frames"] == ["robot/arm"]
    assert result["shapes"] == 1
    raw = (tmp_path / "model.glb").read_bytes()
    length = struct.unpack_from("<I", raw, 12)[0]
    gltf = json.loads(raw[20:20 + length])
    assert gltf["nodes"][0]["extras"] == {"frame": "robot/arm"}
    accessor = gltf["accessors"][gltf["meshes"][0]["primitives"][0]["attributes"]["POSITION"]]
    offset = gltf["bufferViews"][accessor["bufferView"]]["byteOffset"]
    points = np.frombuffer(raw, dtype="<f4", count=9, offset=28 + length + offset).reshape(-1, 3)
    # The body pose was removed; glTF swaps z-up to y-up exactly once.
    np.testing.assert_allclose(points, [(1, 0, 0), (1, 0, -1), (1, 1, 0)], atol=1e-6)


def test_assets_are_requested_and_cached_without_mutating_the_source(tmp_path):
    stage = Usd.Stage.CreateNew(str(tmp_path / "source.usda"))
    UsdGeom.SetStageMetersPerUnit(stage, 1)
    UsdGeom.SetStageUpAxis(stage, UsdGeom.Tokens.z)
    cube = UsdGeom.Cube.Define(stage, "/cube")
    name = "/dimos/assets/abc/texture.png"  # dimos-yaml-check: ignore -- a model asset name, not an HTTP route
    cube.GetPrim().CreateAttribute("texture", Sdf.ValueTypeNames.Asset).Set(Sdf.AssetPath(name))
    stage.GetRootLayer().Save()
    original = (tmp_path / "source.usda").read_bytes()

    model, report = prepare(tmp_path)
    assert model is None
    assert [asset["name"] for asset in report["assets"]] == [name]
    (tmp_path / "assets").mkdir()
    (tmp_path / "assets" / report["assets"][0]["key"]).write_bytes(b"texture bytes")
    resolved, report = prepare(tmp_path)

    assert report["assets"] == []
    assert resolved.GetPrimAtPath("/cube").GetAttribute("texture").Get().path.startswith(str(tmp_path))
    assert (tmp_path / "source.usda").read_bytes() == original
    assert cube.GetPrim().GetAttribute("texture").Get().path == name
