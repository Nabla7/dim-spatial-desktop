"""Reads recorded episodes for the page's replay.

An episode is a folder with `metadata.json` and an MCAP of `dimos.learning.frame.v1` messages (one JSON
frame per control step: joint state, action, camera images, timestamps). When the episode names a sim2
run record, the world it was made in is read too: the compiled MuJoCo model for the shapes, and the
saved world history for where every body was at every snapshot. That part runs in the Python of the
dimos checkout that wrote the episode, so the model loads with the MuJoCo that compiled it and the
history is restored by dimos's own sim2 reader.

Nothing here writes into a recording's folder, and nothing here steps a simulation (recover.py does).

Protocol (the server is the only caller): one JSON request per line on stdin. Each gets one JSON line
on the original stdout, `{"id", "ok", "bytes", ...}`, followed by `bytes` raw bytes. Whatever a library
prints goes to stderr instead.

    python worker.py                      serve requests
    python worker.py audit <dataset> <out.json>   check every episode of a dataset, with progress lines
    python worker.py describe <episode>   print one episode's description (for trying things by hand)
"""

from __future__ import annotations

import base64
from bisect import bisect_right
from collections import Counter, OrderedDict
import hashlib
import json
import math
import os
from pathlib import Path
import struct
import sys
import time
from typing import Any

from mcap.reader import make_reader
import numpy as np

FORMAT = "dimos.learning.frame.v1"
PNG = b"\x89PNG\r\n\x1a\n"
# What the recorder itself refuses: an image older than this when the state was read.
MAX_IMAGE_AGE_S = 0.15
# MuJoCo's own viewer shows geom groups 0 to 2; higher groups are collision shapes.
VISIBLE_GROUPS = 3
GEOM_TYPES = {0: "plane", 2: "sphere", 3: "capsule", 4: "ellipsoid", 5: "cylinder", 6: "box", 7: "mesh"}


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def clean(value: Any) -> Any:
    """A value JSON can carry: no NaN or infinity, short floats."""
    if isinstance(value, float):
        return round(value, 6) if math.isfinite(value) else None
    if isinstance(value, np.generic):
        return clean(value.item())
    if isinstance(value, np.ndarray):
        return clean(value.tolist())
    if isinstance(value, dict):
        return {str(key): clean(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [clean(item) for item in value]
    return value


def ms(seconds: float) -> str:
    return f"{seconds * 1000:.1f} ms"


class Episode:
    """One recorded episode in memory: its frames without their images, and the images as PNG bytes."""

    def __init__(self, directory: Path) -> None:
        self.directory = directory
        self.meta: dict[str, Any] = json.loads((directory / "metadata.json").read_text())
        self.file = next(
            (directory / name for name in ("episode.mcap", "discarded.mcap") if (directory / name).exists()),
            None,
        )
        if self.file is None:
            raise FileNotFoundError(f"no MCAP file in {directory}")
        self.frames: list[dict[str, Any]] = []
        self.images: dict[str, list[bytes | None]] = {}
        self.other_messages = 0
        with self.file.open("rb") as stream:
            for schema, _, message in make_reader(stream).iter_messages():
                if schema is not None and schema.name != FORMAT:
                    self.other_messages += 1
                    continue
                frame = json.loads(message.data)
                views = frame.pop("images_png", None)
                if views is None and "image_png" in frame:
                    views = {"wrist": frame.pop("image_png")}
                index = len(self.frames)
                for name, encoded in (views or {}).items():
                    column = self.images.setdefault(name, [None] * index)
                    column.extend([None] * (index - len(column)))
                    column.append(base64.b64decode(encoded))
                self.frames.append(frame)
        for column in self.images.values():
            column.extend([None] * (len(self.frames) - len(column)))
        self._record: dict[str, Any] | None | bool = False

    # -- the simulation record this episode points at ------------------------------------------------
    @property
    def record(self) -> dict[str, Any] | None:
        if self._record is False:
            path = self.meta.get("sim2_run_record")
            try:
                self._record = json.loads(Path(path).read_text()) if path else None
            except (OSError, ValueError):
                self._record = None
        return self._record  # type: ignore[return-value]

    def joint_configs(self) -> dict[str, dict[str, Any]]:
        """Recorded joint name -> its entry in the simulation record, with the model's joint name.

        A world can hold several robots with the same joint names (a second arm that stands parked). The
        recorded one is the robot named like the episode's robot type, else the first that has every joint.
        """
        names = list(self.meta.get("joint_names") or [])
        robots = ((self.record or {}).get("resolved_world") or {}).get("robots") or {}
        candidates = {}
        for robot_id, robot in robots.items():
            joints = {joint["name"]: {**joint, "model_joint": f"{robot_id}/{joint['model_name']}"} for joint in (robot.get("config") or {}).get("joints") or []}
            if names and all(name in joints for name in names):
                candidates[robot_id] = joints
        if not candidates:
            return {}
        return candidates.get(str(self.meta.get("robot_type")), next(iter(candidates.values())))

    # -- columns --------------------------------------------------------------------------------------
    def column(self, key: str) -> list[Any]:
        return [frame.get(key) for frame in self.frames]

    def clock(self) -> tuple[str, np.ndarray]:
        """The time of each frame in seconds: the control clock when it runs, else the command stamps."""
        for key in ("control_ts", "command_ts", "state_ts"):
            values = self.column(key)
            if values and all(isinstance(v, (int, float)) for v in values):
                times = np.asarray(values, dtype=np.float64)
                if key != "control_ts":
                    times = times - times[0]
                if len(times) < 2 or np.all(np.diff(times) > 0):
                    return key, times
        fps = float(self.meta.get("fps") or 20)
        return "frame index", np.arange(len(self.frames)) / fps

    def kinds(self) -> dict[str, dict[str, list[Any]]]:
        """The frame fields sorted by what they hold: vectors, numbers, words, flags."""
        out: dict[str, dict[str, list[Any]]] = {"vectors": {}, "numbers": {}, "words": {}, "flags": {}}
        keys: dict[str, None] = {}
        for frame in self.frames:
            keys.update(dict.fromkeys(frame))
        for key in keys:
            values = self.column(key)
            present = [v for v in values if v is not None]
            if not present:
                continue
            if all(isinstance(v, bool) for v in present):
                out["flags"][key] = values
            elif all(isinstance(v, (int, float)) for v in present):
                out["numbers"][key] = values
            elif all(isinstance(v, str) for v in present):
                out["words"][key] = values
            elif (
                all(isinstance(v, list) and v and all(isinstance(x, (int, float)) for x in v) for v in present)
                and len({len(v) for v in present}) == 1
                and len(present) == len(values)
            ):
                out["vectors"][key] = values
        return out

    def camera_stamps(self, name: str) -> tuple[np.ndarray | None, np.ndarray | None]:
        """When each frame's image of this camera was taken and when it reached the controller."""
        stamps = self.column("camera_timestamps")
        if all(isinstance(entry, dict) and name in entry for entry in stamps) and stamps:
            return (
                np.asarray([entry[name]["acquisition"] for entry in stamps], dtype=np.float64),
                np.asarray([entry[name]["available"] for entry in stamps], dtype=np.float64),
            )
        if len(self.images) == 1 and all("image_ts" in frame for frame in self.frames) and self.frames:
            taken = np.asarray(self.column("image_ts"), dtype=np.float64)
            available = self.column("image_available_ts")
            return taken, (
                np.asarray(available, dtype=np.float64) if all(v is not None for v in available) else None
            )
        return None, None


def runs(values: list[Any]) -> list[dict[str, Any]]:
    """Consecutive equal values as {from, to, label}; `to` is one past the run's last frame."""
    out: list[dict[str, Any]] = []
    for index, value in enumerate(values):
        if out and out[-1]["label"] == value:
            out[-1]["to"] = index + 1
        else:
            out.append({"from": index, "to": index + 1, "label": value})
    return out


def png_size(data: bytes | None) -> tuple[int, int] | None:
    if not data or data[:8] != PNG or len(data) < 24:
        return None
    width, height = struct.unpack(">II", data[16:24])
    return int(width), int(height)


def check(checks: list[dict[str, Any]], key: str, label: str, level: str, detail: str) -> None:
    checks.append({"id": key, "label": label, "level": level, "detail": detail})


def inspect(episode: Episode) -> dict[str, Any]:
    """Everything the page shows about an episode except its images and its scene."""
    meta, frames, count = episode.meta, episode.frames, len(episode.frames)
    clock_name, times = episode.clock()
    kinds = episode.kinds()
    fps = float(meta.get("fps") or 0) or (1 / float(np.median(np.diff(times))) if count > 1 else 20.0)
    names = list(meta.get("joint_names") or [])
    checks: list[dict[str, Any]] = []
    flags: list[dict[str, Any]] = []

    def flag(index: int, level: str, text: str) -> None:
        if len(flags) < 400:
            flags.append({"index": int(index), "level": level, "text": text})

    # -- the file -------------------------------------------------------------------------------------
    recorded_hash = meta.get("mcap_sha256")
    if recorded_hash:
        same = digest(episode.file) == recorded_hash  # type: ignore[arg-type]
        check(checks, "file", "File is the one that was recorded", "ok" if same else "fail",
              "SHA-256 equals the one in metadata.json." if same else "The MCAP changed after the episode was closed: its SHA-256 differs from metadata.json.")
    else:
        check(checks, "file", "File is the one that was recorded", "info", "metadata.json holds no hash to compare with.")
    declared = meta.get("frames")
    if declared is not None:
        check(checks, "frames", "Frame count", "ok" if declared == count else "fail",
              f"{count} frames, as metadata.json says." if declared == count else f"{count} frames in the file, {declared} in metadata.json.")
    if episode.other_messages:
        check(checks, "other", "Other messages", "info", f"{episode.other_messages} messages of another schema were skipped.")

    # -- time -----------------------------------------------------------------------------------------
    steps = np.diff(times) if count > 1 else np.zeros(0)
    if len(steps):
        period = 1 / fps
        bad = np.flatnonzero((steps < 0.5 * period) | (steps > 1.5 * period))
        for index in bad[:50]:
            flag(index + 1, "warn", f"step of {ms(float(steps[index]))} (nominal {ms(period)})")
        check(checks, "clock", f"Steady control clock ({clock_name})", "ok" if not len(bad) else "warn",
              f"{len(steps)} steps, median {ms(float(np.median(steps)))}, min {ms(float(steps.min()))}, max {ms(float(steps.max()))}."
              + ("" if not len(bad) else f" {len(bad)} steps are outside 0.5 to 1.5 periods: a training export splits the episode there."))

    # -- commands -------------------------------------------------------------------------------------
    applied = kinds["flags"].get("applied")
    if applied is not None:
        missed = [index for index, value in enumerate(applied) if value is False]
        for index in missed[:50]:
            flag(index, "fail", "command not applied")
        check(checks, "applied", "Every command was applied", "ok" if not missed else "warn",
              "All frames carry an applied command." if not missed else f"{len(missed)} of {count} commands were not applied; a training export leaves those frames out.")
    authority = kinds["words"].get("authority")
    if authority is not None:
        counts = Counter(authority)
        check(checks, "authority", "Who commanded", "info", ", ".join(f"{name}: {number} frames" for name, number in counts.most_common()) + ".")

    vectors = {key: np.asarray(values, dtype=np.float64) for key, values in kinds["vectors"].items()}
    state, accepted, intended = vectors.get("state"), vectors.get("accepted_action"), vectors.get("intended_action")
    width = len(names)
    label_of = lambda array: names if array.shape[1] == width else [str(i) for i in range(array.shape[1])]  # noqa: E731
    for key, array in vectors.items():
        if not np.isfinite(array).all():
            check(checks, f"finite:{key}", f"{key} is finite", "fail", f"{int((~np.isfinite(array)).sum())} values are NaN or infinite.")
    configs = episode.joint_configs()
    if accepted is not None and intended is not None and accepted.shape == intended.shape:
        changed = np.flatnonzero(np.abs(accepted - intended).max(axis=1) > 1e-9)
        for index in changed[:50]:
            flag(index, "warn", "accepted action differs from the intended one")
        check(checks, "accepted", "Accepted action equals intended action", "ok" if not len(changed) else "info",
              "Identical in every frame." if not len(changed) else f"{len(changed)} frames differ (a limit or a rejection changed the command), by at most {float(np.abs(accepted - intended).max()):.4f}.")
    if accepted is not None and accepted.shape[1] == width and configs:
        outside: list[str] = []
        for index, name in enumerate(names):
            config = configs.get(name)
            if not config or config.get("lower") is None or config.get("upper") is None:
                continue
            low, high = float(config["lower"]), float(config["upper"])
            number = int(((accepted[:, index] < low - 1e-6) | (accepted[:, index] > high + 1e-6)).sum())
            if number:
                outside.append(f"{name}: {number} frames outside {low:.3f} to {high:.3f}")
        check(checks, "limits", "Actions are inside the joint limits", "ok" if not outside else "warn",
              "Every commanded value is inside the limits of the simulation record." if not outside else "; ".join(outside) + ".")
    extra_signals: list[dict[str, Any]] = []
    if state is not None and accepted is not None and state.shape == accepted.shape and count > 1:
        # What the arm did one step after a command, against that command.
        error = np.vstack([state[1:] - accepted[:-1], np.full((1, state.shape[1]), np.nan)])
        labels = label_of(state)
        worst = np.nanmax(np.abs(error), axis=0)
        rms = np.sqrt(np.nanmean(error**2, axis=0))
        order = np.argsort(-worst)[:3]
        check(checks, "following", "How closely the state follows the action", "info",
              "One step after each command, largest difference: " + ", ".join(f"{labels[i]} {worst[i]:.3f} (rms {rms[i]:.3f})" for i in order) + ".")
        extra_signals.append({"name": "following_error", "label": "state one step later − action", "group": "error", "labels": labels, "values": clean(error)})
        jumps = np.abs(np.diff(state, axis=0))
        limit = np.asarray([
            1.5 * float((configs.get(name) or {}).get("max_velocity") or 0) / fps if name in configs else 0.0 for name in labels
        ])
        if limit.any():
            # The gripper's recorded unit is its opening, not an angle: a speed limit in rad/s says nothing about it.
            comparable = np.asarray([limit[i] > 0 and float(configs[labels[i]].get("scale", 1)) == 1.0 for i in range(len(labels))])
            fast = np.flatnonzero((jumps > limit)[:, comparable].any(axis=1)) if comparable.any() else np.zeros(0, dtype=int)
            for index in fast[:50]:
                flag(index + 1, "warn", "state moved faster than the joint's speed limit allows")
            check(checks, "jumps", "No jumps in the joint state", "ok" if not len(fast) else "warn",
                  f"Largest change between frames: {float(jumps.max()):.3f}." + ("" if not len(fast) else f" {len(fast)} steps exceed 1.5 times the joint speed limit."))

    # -- cameras --------------------------------------------------------------------------------------
    cameras: list[dict[str, Any]] = []
    scalars: list[dict[str, Any]] = []
    state_ts = kinds["numbers"].get("state_ts")
    expected = meta.get("image_shape")
    declared_cameras = meta.get("camera_names")
    if declared_cameras and set(declared_cameras) != set(episode.images):
        check(checks, "cameras", "Cameras are the declared ones", "fail", f"metadata.json names {declared_cameras}; the frames carry {sorted(episode.images)}.")
    order = {name: index for index, name in enumerate(declared_cameras or [])}
    for name, column in sorted(episode.images.items(), key=lambda item: order.get(item[0], len(order))):
        sizes = Counter(png_size(data) for data in column)
        missing, broken = sizes.pop(None, 0), 0
        size = sizes.most_common(1)[0][0] if sizes else None
        cameras.append({"name": name, "width": size[0] if size else 0, "height": size[1] if size else 0})
        problems: list[str] = []
        if missing:
            none = sum(1 for data in column if data is None)
            broken = missing - none
            if none:
                problems.append(f"{none} frames have no image")
            if broken:
                problems.append(f"{broken} images are not PNG files")
        if len(sizes) > 1:
            problems.append(f"sizes vary: {dict(sizes)}")
        if size and expected and [size[1], size[0]] != list(expected[:2]):
            problems.append(f"images are {size[0]}×{size[1]}, metadata.json says {expected[1]}×{expected[0]}")
        check(checks, f"images:{name}", f"{name}: an image in every frame", "ok" if not problems else "fail",
              f"{count} PNG images of {size[0]}×{size[1]}." if not problems and size else "; ".join(problems) + ".")
        repeated_bytes = sum(1 for a, b in zip(column, column[1:], strict=False) if a is not None and a == b)
        taken, available = episode.camera_stamps(name)
        if taken is not None and state_ts is not None:
            age = np.asarray(state_ts, dtype=np.float64) - taken
            scalars.append({"name": f"age:{name}", "label": f"{name} image age", "group": "timing", "unit": "s", "values": clean(age)})
            wrong = np.flatnonzero((age < 0) | (age > MAX_IMAGE_AGE_S))
            for index in wrong[:50]:
                flag(index, "fail", f"{name} image is {ms(float(age[index]))} old")
            detail = f"Age when the state was read: median {ms(float(np.median(age)))}, {ms(float(age.min()))} to {ms(float(age.max()))}."
            if len(wrong):
                detail += f" {len(wrong)} frames are outside 0 to {ms(MAX_IMAGE_AGE_S)}."
            check(checks, f"age:{name}", f"{name}: image is recent and from the past", "ok" if not len(wrong) else "fail", detail)
            repeats = np.flatnonzero(np.diff(taken) <= 0) + 1
            for index in repeats[:50]:
                flag(index, "warn", f"{name} shows the same image as the frame before")
            check(checks, f"fresh:{name}", f"{name}: a new image in every frame", "ok" if not len(repeats) and not repeated_bytes else "warn",
                  "Every frame has a later image than the one before." if not len(repeats) and not repeated_bytes
                  else f"{len(repeats)} frames repeat the previous image's time stamp; {repeated_bytes} are byte for byte the same picture.")
            if available is not None:
                lead = np.asarray(state_ts, dtype=np.float64) - available
                scalars.append({"name": f"lead:{name}", "label": f"{name} delivered before the state", "group": "timing", "unit": "s", "values": clean(lead)})
                late = np.flatnonzero(lead < -1e-6)
                for index in late[:50]:
                    flag(index, "fail", f"{name} image arrived after the state was read")
                check(checks, f"causal:{name}", f"{name}: image had arrived when the action was chosen", "ok" if not len(late) else "fail",
                      f"Delivered {ms(float(lead.min()))} to {ms(float(lead.max()))} before the state was read." if not len(late)
                      else f"{len(late)} frames use an image that had not been delivered yet.")
        elif repeated_bytes:
            check(checks, f"fresh:{name}", f"{name}: a new image in every frame", "warn", f"{repeated_bytes} frames are byte for byte the same picture as the one before.")
    if len(steps):
        scalars.append({"name": "step", "label": f"step of {clock_name}", "group": "timing", "unit": "s", "values": clean(np.concatenate([[np.nan], steps]))})

    # -- outcome --------------------------------------------------------------------------------------
    validation = meta.get("task_validation") or {}
    outcome, kept = meta.get("outcome"), meta.get("kept")
    if outcome is not None:
        physical = validation.get("success")
        agrees = physical is None or (outcome == "success") == bool(physical)
        check(checks, "outcome", "Outcome", "ok" if agrees and outcome == "success" else "fail" if not agrees else "info",
              f"{outcome}{'' if kept is None else ', kept' if kept else ', discarded'}"
              + ("" if physical is None else f"; the physical check says {'success' if physical else 'failure'}")
              + f"; {meta.get('training_frames', 0)} frames count for training.")

    # -- signals --------------------------------------------------------------------------------------
    signals = [{"name": key, "label": key.replace("_", " "), "group": "joints", "labels": label_of(array), "values": clean(array)} for key, array in vectors.items()]
    signals += extra_signals
    for key, values in kinds["numbers"].items():
        array = np.asarray([np.nan if v is None else v for v in values], dtype=np.float64)
        stamp = key.endswith("_ts") or np.nanmax(np.abs(array)) > 1e8
        counter = len(array) > 1 and np.all(np.diff(array) > 0) and np.all(array == np.round(array))
        if stamp or counter or np.nanmax(array) == np.nanmin(array) or any(entry["name"].startswith("age:") for entry in scalars) and key == "image_age_s":
            continue
        scalars.append({"name": key, "label": key.replace("_", " "), "group": "other", "unit": "", "values": clean(array)})
    bands = [{"name": key, "runs": runs(values)} for key, values in kinds["words"].items() if len(set(values)) > 1]
    bands.sort(key=lambda band: band["name"] != "phase")
    constant = {key: values[0] for group in ("words", "numbers", "flags") for key, values in kinds[group].items()
                if len(set(map(str, values))) == 1 and not key.endswith("_ts")}

    return clean({
        "id": episode.directory.name, "file": episode.file.name,  # type: ignore[union-attr]
        "task": meta.get("task"), "outcome": outcome, "kept": kept,
        "count": count, "fps": fps, "clock": clock_name, "times": times,
        "duration": float(times[-1] - times[0]) if count else 0.0,
        "cameras": cameras, "signals": signals, "scalars": scalars, "bands": bands, "flags": flags,
        "checks": checks, "facts": facts(episode, constant),
        "world": world_summary(episode),
    })


def facts(episode: Episode, constant: dict[str, Any]) -> list[dict[str, Any]]:
    """metadata.json as groups of rows: its own values first, then each nested object as a group."""
    def show(value: Any) -> str:
        if isinstance(value, float):
            return f"{value:.6g}"
        if isinstance(value, (list, tuple)):
            return ", ".join(show(item) for item in value)
        if isinstance(value, dict):
            return ", ".join(f"{key} {show(item)}" for key, item in value.items())
        return str(value)

    meta = episode.meta
    groups = [{"title": "Episode", "rows": [[key, show(value)] for key, value in meta.items() if not isinstance(value, dict)]}]
    for key, value in meta.items():
        if isinstance(value, dict) and value:
            groups.append({"title": key.replace("_", " "), "rows": [[name, show(item)] for name, item in value.items()]})
    if constant:
        groups.append({"title": "The same in every frame", "rows": [[key, show(value)] for key, value in constant.items()]})
    record = episode.record
    if record:
        rows = [[key, show(value)] for key, value in record.items() if not isinstance(value, (dict, list))]
        for key in ("runtime_source", "compiled_model", "recorded_world_history"):
            entry = record.get(key)
            if isinstance(entry, dict) and entry.get("path"):
                rows.append([key.replace("_", " "), entry["path"]])
        world = record.get("resolved_world") or {}
        rows += [[key.replace("_", " "), show(world[key])] for key in ("timestep", "snapshot_hz") if key in world]
        for name, evidence in (world.get("calibration_evidence") or {}).items():
            rows.append([f"evidence for {name}", str(evidence).split("#")[0]])
        groups.append({"title": "Simulation record", "rows": rows})
    return groups


def world_summary(episode: Episode) -> dict[str, Any]:
    """What can be shown of the world this episode ran in, before anything heavy is read."""
    record = episode.record
    if not record:
        return {"model": False, "history": None, "recoverable": False, "note": "This episode names no simulation record, so there is no scene to show."}
    model = Path((record.get("compiled_model") or {}).get("path") or "")
    history = Path((record.get("recorded_world_history") or {}).get("path") or "")
    trajectory = Path(episode.meta.get("trajectory") or "")
    return {
        "model": model.is_file(),
        "history": str(history) if history.is_file() else None,
        "recoverable": bool(trajectory.is_file() and not history.is_file()),
        "runtime": (record.get("runtime_source") or {}).get("path"),
        "mujoco": record.get("mujoco_version"),
        "note": "" if model.is_file() else "The compiled model of this episode's world is no longer on disk.",
    }


# -- the world ----------------------------------------------------------------------------------------
class World:
    """The compiled MuJoCo model of an episode's world, read with this process's MuJoCo."""

    def __init__(self, episode: Episode) -> None:
        import mujoco

        self.mujoco = mujoco
        record = episode.record
        if not record:
            raise ValueError("this episode names no simulation record")
        path = Path((record.get("compiled_model") or {}).get("path") or "")
        if not path.is_file():
            raise FileNotFoundError("the compiled model of this episode's world is no longer on disk")
        wanted = record.get("mujoco_version")
        try:
            self.model = mujoco.MjModel.from_binary_path(str(path))
        except Exception as error:  # noqa: BLE001  A model from another MuJoCo raises a plain error.
            raise ValueError(f"MuJoCo {mujoco.__version__} here could not load a model compiled with MuJoCo {wanted}: {error}") from error
        self.data = mujoco.MjData(self.model)
        self.record = record
        self.spec = int((record.get("initial_state") or {}).get("spec") or mujoco.mjtState.mjSTATE_INTEGRATION)

    def names(self, kind: str, count: int) -> list[str]:
        return [getattr(self.model, kind)(index).name for index in range(count)]

    def shapes(self, have: str | None) -> tuple[dict[str, Any], bytes]:
        mujoco, model = self.mujoco, self.model
        geoms: list[dict[str, Any]] = []
        meshes: dict[int, int] = {}
        vertices: list[np.ndarray] = []
        faces: list[np.ndarray] = []
        table: list[dict[str, Any]] = []
        vertex_at = face_at = 0
        for index in range(model.ngeom):
            kind = GEOM_TYPES.get(int(model.geom_type[index]))
            material = int(model.geom_matid[index])
            rgba = model.mat_rgba[material] if material >= 0 else model.geom_rgba[index]
            if kind is None or int(model.geom_group[index]) >= VISIBLE_GROUPS or rgba[3] <= 0:
                continue
            geom: dict[str, Any] = {
                "name": model.geom(index).name, "body": int(model.geom_bodyid[index]), "type": kind,
                "size": model.geom_size[index].tolist(), "pos": model.geom_pos[index].tolist(),
                "quat": model.geom_quat[index].tolist(), "rgba": rgba.tolist(),
            }
            if kind == "mesh":
                mesh = int(model.geom_dataid[index])
                if mesh not in meshes:
                    start, number = int(model.mesh_vertadr[mesh]), int(model.mesh_vertnum[mesh])
                    first, triangles = int(model.mesh_faceadr[mesh]), int(model.mesh_facenum[mesh])
                    meshes[mesh] = len(table)
                    vertices.append(np.ascontiguousarray(model.mesh_vert[start : start + number], dtype="<f4"))
                    faces.append(np.ascontiguousarray(model.mesh_face[first : first + triangles], dtype="<u4"))
                    table.append({"vertices": [vertex_at, number * 3], "faces": [face_at, triangles * 3]})
                    vertex_at += number * 3
                    face_at += triangles * 3
                geom["mesh"] = meshes[mesh]
            geoms.append(geom)
        payload_vertices = b"".join(array.tobytes() for array in vertices)
        payload_faces = b"".join(array.tobytes() for array in faces)
        key = hashlib.sha1(payload_vertices + payload_faces).hexdigest()
        cameras = [
            {"name": model.camera(index).name, "body": int(model.cam_bodyid[index]), "pos": model.cam_pos[index].tolist(),
             "quat": model.cam_quat[index].tolist(), "fovy": float(model.cam_fovy[index])}
            for index in range(model.ncam)
        ]
        meta = {
            "key": key, "bodies": [{"name": name, "parent": int(model.body_parentid[index])} for index, name in enumerate(self.names("body", model.nbody))],
            "geoms": geoms, "meshes": table, "cameras": cameras, "faces_at": len(payload_vertices),
            "sent": have != key, "mujoco": mujoco.__version__,
        }
        return meta, (payload_vertices + payload_faces) if have != key else b""

    def poses(self) -> np.ndarray:
        return np.hstack([self.data.xpos, self.data.xquat]).astype("<f4")

    def joint_map(self, episode: Episode) -> list[tuple[int, int, float, float]]:
        """(index in the recorded joint vector, qpos address, scale, offset) for every joint the model has."""
        mujoco, model = self.mujoco, self.model
        out = []
        configs = episode.joint_configs()
        for index, name in enumerate(episode.meta.get("joint_names") or []):
            config = configs.get(name)
            joint = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT, config["model_joint"]) if config else -1
            if joint >= 0:
                out.append((index, int(model.jnt_qposadr[joint]), float(config.get("scale", 1)), float(config.get("offset", 0))))
        return out

    def set_joints(self, mapping: list[tuple[int, int, float, float]], values: Any) -> None:
        """Put recorded joint values into qpos, and move the joints an equality ties to them."""
        mujoco, model, data = self.mujoco, self.model, self.data
        moved = {}
        for index, address, scale, offset in mapping:
            data.qpos[address] = float(values[index]) * scale + offset
            moved[address] = True
        for index in range(model.neq):
            if int(model.eq_type[index]) != int(mujoco.mjtEq.mjEQ_JOINT) or int(model.eq_obj2id[index]) < 0:
                continue
            first, second = int(model.jnt_qposadr[model.eq_obj1id[index]]), int(model.jnt_qposadr[model.eq_obj2id[index]])
            zero_first, zero_second = model.qpos0[first], model.qpos0[second]
            c = model.eq_data[index][:5]
            if second in moved and first not in moved:
                delta = data.qpos[second] - zero_second
                data.qpos[first] = zero_first + sum(c[power] * delta**power for power in range(5))
            elif first in moved and second not in moved and abs(c[1]) > 1e-12 and not np.any(c[2:]):
                data.qpos[second] = zero_second + (data.qpos[first] - zero_first - c[0]) / c[1]

    def kinematics(self) -> None:
        self.mujoco.mj_kinematics(self.model, self.data)


def motion(episode: Episode, world: World, history: str | None) -> tuple[dict[str, Any], bytes]:
    """Where every body was. From a saved world history when there is one (dimos restores each snapshot),
    else from the recorded joint states alone, with everything that is not a recorded joint left where
    the episode started."""
    mujoco, model, data = world.mujoco, world.model, world.data
    frames = episode.frames
    _, frame_times = episode.clock()
    mapping = world.joint_map(episode)
    vectors = episode.kinds()["vectors"]
    state, action = vectors.get("state"), vectors.get("accepted_action")
    checks: list[dict[str, Any]] = []
    initial = np.asarray((world.record.get("initial_state") or {}).get("values") or [], dtype=np.float64)
    spec = world.spec

    if history:
        # dimos's own replay of a recorded world: the snapshots as a source, restored into a model reader.
        from dimos.imitation.loop.replay import RecordedSnapshots, WorldRecording
        from dimos.sim2.sensors.reader import WorldReader
        from dimos.sim2.world.runtime import STATE

        spec = int(STATE)

        recording = WorldRecording.load(Path(history))
        source = RecordedSnapshots(recording)
        reader = WorldReader(
            {"model": str((world.record.get("compiled_model") or {})["path"]), "snapshot": recording.descriptor.to_dict()},
            snapshots=source, kinematics_only=True,
        )
        try:
            ticks = [snapshot.metadata.physics_tick for snapshot in recording.snapshots]
            times = np.asarray([snapshot.metadata.sim_time for snapshot in recording.snapshots])
            poses = np.empty((len(ticks), model.nbody, 7), dtype="<f4")
            states = np.empty((len(ticks), len(recording.snapshots[0].values["state"])))
            for index, tick in enumerate(ticks):
                source.seek(tick)
                reader.update()
                poses[index] = np.hstack([reader.data.xpos, reader.data.xquat])
                states[index] = recording.snapshots[index].values["state"]
        finally:
            reader.close()
        tick_of = {control["command_sequence"]: control["physics_tick"] for control in recording.controls}
        dt = recording.descriptor.physics_dt
        at = [
            max(0, bisect_right(ticks, tick_of.get(frame.get("command_sequence"), round(float(frame_times[index]) / dt))) - 1)
            for index, frame in enumerate(frames)
        ]
        source_name = "history"
        if state is not None and mapping:
            # The joint state each frame recorded, against the physics state at the tick it was read. A frame
            # is read between two snapshots, so its value must lie between theirs.
            worst, where = 0.0, ""
            later = mujoco.MjData(model)
            names = episode.meta.get("joint_names") or []
            for index, frame in enumerate(frames):
                if frame.get("command_sequence") not in tick_of:
                    continue
                before = at[index]
                mujoco.mj_setState(model, data, states[before], spec)
                mujoco.mj_setState(model, later, states[min(before + 1, len(ticks) - 1)], spec)
                for joint, address, scale, offset in mapping:
                    low, high = sorted(((data.qpos[address] - offset) / scale, (later.qpos[address] - offset) / scale))
                    outside = max(low - state[index][joint], state[index][joint] - high, 0.0)
                    if outside > worst:
                        worst, where = outside, f" ({names[joint]}, frame {index})"
            check(checks, "scene:state", "Recorded joint state equals the physics state", "ok" if worst < 5e-3 else "warn",
                  f"Each frame's joint state lies between the two world snapshots around the tick it was read at; largest excursion {worst:.1e}{where}.")
    else:
        if len(initial) != mujoco.mj_stateSize(model, spec):
            raise ValueError("the simulation record holds no usable initial state")
        times = np.asarray(frame_times, dtype=np.float64)
        poses = np.empty((len(frames), model.nbody, 7), dtype="<f4")
        states = np.tile(initial, (len(frames), 1))
        for index in range(len(frames)):
            mujoco.mj_setState(model, data, initial, spec)
            if state is not None:
                world.set_joints(mapping, state[index])
            world.kinematics()
            poses[index] = world.poses()
        at = list(range(len(frames)))
        source_name = "joints"

    # The pose the command asked for, frame by frame: the same world with the commanded joints moved.
    ghost = np.empty((len(frames), model.nbody, 7), dtype="<f4")
    commanded: list[int] = []
    if action is not None and mapping:
        for index, snapshot in enumerate(at):
            mujoco.mj_setState(model, data, states[snapshot], spec)
            world.set_joints(mapping, action[index])
            world.kinematics()
            ghost[index] = world.poses()
        difference = np.abs(ghost - poses[at]).max(axis=(0, 2))
        commanded = [int(body) for body in np.flatnonzero(difference > 1e-5)]

    # Bodies on a free joint are the objects of the scene: their path is worth a plot and a trail.
    free = [int(model.jnt_bodyid[joint]) for joint in range(model.njnt) if int(model.jnt_type[joint]) == int(mujoco.mjtJoint.mjJNT_FREE)]
    travel = np.linalg.norm(poses[:, :, :3].max(axis=0) - poses[:, :, :3].min(axis=0), axis=1)
    moving = {int(body) for body in np.flatnonzero(travel > 0.05)}
    carries = {int(model.body_parentid[body]) for body in moving}
    signals = [
        {"name": f"position:{model.body(body).name}", "label": f"{model.body(body).name} position", "group": "scene",
         "labels": ["x", "y", "z"], "unit": "m", "values": clean(poses[at][:, body, :3])}
        for body in free
    ]
    meta = {
        "source": source_name, "count": int(len(poses)), "bodies": int(model.nbody), "times": clean(times),
        "frames": at, "commanded": commanded, "free": free,
        # A trail for each body that travelled and carries nothing that travels further out.
        "trails": sorted(body for body in moving if body in free or body not in carries),
        "ghost_at": int(poses.nbytes) if commanded else None, "signals": signals, "checks": checks,
    }
    return meta, poses.tobytes() + (ghost.tobytes() if commanded else b"")


# -- a whole dataset ----------------------------------------------------------------------------------
def audit(dataset: Path, out: Path, emit: Any) -> None:
    """Every episode's checks, and what the episodes have in common and in what they differ."""
    directories = sorted((path for path in dataset.iterdir() if (path / "metadata.json").is_file()), key=lambda path: path.stat().st_mtime)
    rows: list[dict[str, Any]] = []
    contracts: Counter[str] = Counter()
    variation: dict[str, list[Any]] = {}
    seeds: Counter[Any] = Counter()
    hashes: Counter[Any] = Counter()
    reports: dict[str, None] = {}
    bodies: set[str] | None = None
    started = time.time()
    for index, directory in enumerate(directories):
        emit({"done": index, "total": len(directories), "episode": directory.name})
        try:
            episode = Episode(directory)
            described = inspect(episode)
        except Exception as error:  # noqa: BLE001  One unreadable episode must not end the audit.
            rows.append({"id": directory.name, "error": f"{type(error).__name__}: {error}", "level": "fail", "problems": [{"label": "Could not be read", "level": "fail", "detail": str(error)}]})
            continue
        meta = episode.meta
        if bodies is None and episode.record:
            try:
                world = World(episode)
                bodies = set(world.names("body", world.model.nbody))
            except Exception:  # noqa: BLE001  Without the model there are no placements to draw, nothing more.
                bodies = set()
        levels = Counter(entry["level"] for entry in described["checks"])
        rows.append({
            "id": directory.name, "frames": described["count"], "duration": described["duration"], "outcome": meta.get("outcome"),
            "kept": meta.get("kept"), "split": meta.get("split"), "seed": (meta.get("variation") or {}).get("seed"),
            "level": "fail" if levels["fail"] else "warn" if levels["warn"] else "ok",
            "problems": [entry for entry in described["checks"] if entry["level"] in ("fail", "warn")],
        })
        contract = {key: meta.get(key) for key in ("joint_names", "fps", "image_shape", "robot_type", "action_semantics", "observation_profile", "camera_names")}
        contracts[json.dumps(contract, sort_keys=True)] += 1
        for key, value in (meta.get("variation") or {}).items():
            variation.setdefault(key, []).append(value)
        seeds[(meta.get("variation") or {}).get("seed")] += 1
        hashes[meta.get("mcap_sha256")] += 1
        record = meta.get("sim2_run_record")
        if record:
            reports[str(Path(record).parent.parent / "report.json")] = None

    charts: list[dict[str, Any]] = []
    # Placements: a sampled quantity named like a body of the world is where that body was put.
    points = {key: values for key, values in variation.items() if key in (bodies or ()) and len(values) > 1
              and all(isinstance(v, list) and len(v) >= 2 and all(isinstance(x, (int, float)) for x in v) for v in values)}
    if points:
        charts.append({"kind": "scatter", "title": "Placements in these episodes", "x": "x (m)", "y": "y (m)", "equal": True,
                       "series": [{"label": key, "points": clean([value[:2] for value in values])} for key, values in points.items()]})
    numbers = [key for key, values in variation.items()
               if all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in values) and len(set(values)) > 2 and key != "seed"]
    histograms = {key: {"kind": "histogram", "title": key.replace("_", " "), "values": clean(variation[key])} for key in numbers}
    charts.extend(histograms.values())
    durations = [row["duration"] for row in rows if "duration" in row]
    if len(durations) > 2:
        charts.append({"kind": "histogram", "title": "episode length (s)", "values": clean(durations)})

    # The generation report beside the episodes says what was tried, and why most attempts were not kept.
    funnel: list[dict[str, Any]] = []
    selection: list[dict[str, Any]] = []
    for path in reports:
        try:
            report = json.loads(Path(path).read_text())
        except (OSError, ValueError):
            continue
        attempts = report.get("attempts") or []
        reasons: Counter[str] = Counter()
        tried: dict[str, dict[str, list[Any]]] = {}
        sampled: dict[str, dict[bool, list[float]]] = {}
        for attempt in attempts:
            accepted = bool(attempt.get("accepted"))
            reason = "accepted" if accepted else str(attempt.get("reason") or "no reason recorded").split(":")[0]
            reasons[reason] += 1
            for key, value in (attempt.get("variation") or {}).items():
                if key in points:
                    tried.setdefault(key, {}).setdefault("kept" if accepted else "not kept", []).append(value[:2])
                    for axis, name in enumerate(("x", "y")):
                        sampled.setdefault(f"{key} {name}", {True: [], False: []})[accepted].append(value[axis])
                elif key in histograms:
                    sampled.setdefault(key, {True: [], False: []})[accepted].append(value)
        # Is what was kept a fair sample of what was tried? For each sampled quantity, the kept attempts
        # against the rest (two-sample Kolmogorov-Smirnov, 1 % level).
        skewed: list[str] = []
        for key, groups in sampled.items():
            kept_values, rest = np.sort(groups[True]), np.sort(groups[False])
            if len(kept_values) < 8 or len(rest) < 8:
                continue
            both = np.concatenate([kept_values, rest])
            distance = float(np.abs(np.searchsorted(kept_values, both, side="right") / len(kept_values) - np.searchsorted(rest, both, side="right") / len(rest)).max())
            if distance > 1.63 * math.sqrt((len(kept_values) + len(rest)) / (len(kept_values) * len(rest))):
                skewed.append(f"{key.replace('_', ' ')} (kept: median {np.median(kept_values):.3g}, {kept_values[0]:.3g} to {kept_values[-1]:.3g}; not kept: median {np.median(rest):.3g}, {rest[0]:.3g} to {rest[-1]:.3g})")
            if key in histograms:
                histograms[key]["values"], histograms[key]["reference"] = clean(groups[True]), clean(groups[False])
        if sampled:
            check(selection, "selection", "The kept episodes are a fair sample of what was tried", "ok" if not skewed else "warn",
                  "For every sampled quantity, the kept attempts are spread like the ones that were not kept." if not skewed
                  else "Not for: " + "; ".join(skewed) + ". The dataset shows little of the conditions that were mostly rejected, so a policy trained on it has seen little of them.")
        funnel.append({"path": path, "status": report.get("status"), "attempts": len(attempts), "requested": report.get("requested"), "completed": report.get("completed"), "elapsed_s": report.get("elapsed_s")})
        charts.insert(0, {"kind": "bars", "title": f"What became of {len(attempts)} attempts", "items": [{"label": label, "value": number, "tone": "ok" if label == "accepted" else "muted"} for label, number in reasons.most_common()]})
        for key, groups in tried.items():
            charts.insert(1, {"kind": "scatter", "title": f"{key}: every attempt, kept or not", "x": "x (m)", "y": "y (m)", "equal": True,
                              "series": [{"label": label, "tone": "ok" if label == "kept" else "muted", "points": clean(values)} for label, values in sorted(groups.items(), reverse=True)]})

    findings: list[dict[str, Any]] = []
    readable = [row for row in rows if "error" not in row]
    kept = [row for row in readable if row.get("kept")]
    check(findings, "count", "Episodes", "info",
          f"{len(rows)} episodes: {len(kept)} kept, {len(readable) - len(kept)} discarded, {len(rows) - len(readable)} unreadable. "
          f"{sum(row['frames'] for row in kept)} frames in the kept ones ({sum(row['duration'] for row in kept) / 60:.1f} minutes).")
    outcomes = Counter((row.get("split"), row.get("outcome")) for row in kept)
    check(findings, "outcomes", "Kept episodes by split and outcome", "info", ", ".join(f"{split or 'no split'} {outcome or 'ungraded'}: {number}" for (split, outcome), number in outcomes.most_common()) + ".")
    check(findings, "contract", "One data contract", "ok" if len(contracts) <= 1 else "fail",
          "Joint names, rate, image shape, cameras, action meaning and observation profile are the same in every episode." if len(contracts) <= 1
          else f"{len(contracts)} different contracts are mixed here; a training export refuses to combine them. " + "; ".join(f"{number} episodes: {contract}" for contract, number in contracts.most_common(3)))
    repeated = [seed for seed, number in seeds.items() if seed is not None and number > 1]
    check(findings, "seeds", "Every episode has its own seed", "ok" if not repeated else "warn", "No seed is used twice." if not repeated else f"Seeds used more than once: {repeated[:10]}.")
    copies = [value for value, number in hashes.items() if value is not None and number > 1]
    check(findings, "copies", "No episode is stored twice", "ok" if not copies else "warn", "Every file has its own hash." if not copies else f"{len(copies)} files appear more than once.")
    findings.extend(selection)
    bad = Counter(problem["label"] for row in rows for problem in row["problems"])
    failing, warned = sum(1 for row in rows if row["level"] == "fail"), sum(1 for row in rows if row["level"] == "warn")
    check(findings, "episodes", "Episode checks", "fail" if failing else "warn" if warned else "ok",
          f"{len(rows) - failing - warned} episodes pass every check, {warned} have warnings, {failing} have failures."
          + ("" if not bad else " Most common: " + "; ".join(f"{label} ({number})" for label, number in bad.most_common(4)) + "."))
    result = {"dataset": str(dataset), "at": time.time(), "seconds": time.time() - started, "episodes": rows, "findings": findings, "charts": charts, "generation": funnel}
    out.parent.mkdir(parents=True, exist_ok=True)
    temporary = out.with_suffix(".tmp")
    temporary.write_text(json.dumps(clean(result)))
    temporary.replace(out)
    emit({"done": len(directories), "total": len(directories), "finished": True})


# -- serving ------------------------------------------------------------------------------------------
class Cache:
    """The last few episodes read: scrubbing asks for one episode's images many times."""

    def __init__(self, limit: int = 2) -> None:
        self.limit, self.episodes, self.worlds = limit, OrderedDict(), OrderedDict()

    def episode(self, path: str) -> Episode:
        directory = Path(path)
        stamp = (directory / "metadata.json").stat().st_mtime
        held = self.episodes.get(path)
        if held is None or held[0] != stamp:
            self.episodes[path] = held = (stamp, Episode(directory))
            self.worlds.pop(path, None)
        self.episodes.move_to_end(path)
        while len(self.episodes) > self.limit:
            old, _ = self.episodes.popitem(last=False)
            self.worlds.pop(old, None)
        return held[1]

    def world(self, path: str) -> World:
        if path not in self.worlds:
            self.worlds[path] = World(self.episode(path))
        return self.worlds[path]


def handle(cache: Cache, request: dict[str, Any]) -> tuple[dict[str, Any], bytes]:
    op, path = request["op"], request.get("path", "")
    if op == "episode":
        return inspect(cache.episode(path)), b""
    if op == "images":
        column = cache.episode(path).images.get(request["camera"])
        if column is None:
            raise KeyError(f"no camera named {request['camera']}")
        first = max(0, int(request.get("start", 0)))
        chunk = [data or b"" for data in column[first : first + max(1, min(256, int(request.get("count", 32))))]]
        return {"start": first, "sizes": [len(data) for data in chunk], "type": "image/png"}, b"".join(chunk)
    if op == "scene":
        return cache.world(path).shapes(request.get("have"))
    if op == "motion":
        episode = cache.episode(path)
        return motion(episode, cache.world(path), request.get("history") or world_summary(episode)["history"])
    if op == "ping":
        return {"python": sys.executable, "pid": os.getpid()}, b""
    raise ValueError(f"unknown request: {op}")


def main() -> None:
    # The pipe the server reads is kept for answers alone; a library that prints does so on stderr.
    answers = os.fdopen(os.dup(1), "wb")
    os.dup2(2, 1)
    sys.stdout = sys.stderr

    def emit(meta: dict[str, Any], payload: bytes = b"") -> None:
        answers.write(json.dumps({**meta, "bytes": len(payload)}).encode() + b"\n" + payload)
        answers.flush()

    if len(sys.argv) >= 4 and sys.argv[1] == "audit":
        audit(Path(sys.argv[2]), Path(sys.argv[3]), emit)
        return
    if len(sys.argv) >= 3 and sys.argv[1] == "describe":
        described = inspect(Episode(Path(sys.argv[2])))
        for key in ("signals", "scalars", "times"):
            described[key] = f"<{len(described[key])} entries>"
        print(json.dumps(described, indent=1))
        return
    cache = Cache()
    for line in sys.stdin:
        if not line.strip():
            continue
        request: dict[str, Any] = {}
        try:
            request = json.loads(line)
            meta, payload = handle(cache, request)
            emit({"id": request.get("id"), "ok": True, "meta": meta}, payload)
        except Exception as error:  # noqa: BLE001  Every failure is an answer; the worker keeps serving.
            emit({"id": request.get("id"), "ok": False, "error": f"{type(error).__name__}: {error}"})


if __name__ == "__main__":
    main()
