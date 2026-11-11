"""Runs an episode's physics again, to get back the world history that was not saved with it.

An episode made by dimos's planner teacher keeps the start state of its world and the list of commands
(`trajectory.npz`). Newer episodes also keep every world snapshot; older ones do not, and for those this
script repeats what the generator did: the same world, the same start, the same commands, through dimos's
own sim2 runtime and with no cameras. It then compares the joint states it gets with the ones the episode
recorded, because the runtime's code may have changed since, and writes both the history and that
comparison to `out`. It never writes into the episode's or the experiment's folders.

    python recover.py <episode folder> <out folder>
"""

from __future__ import annotations

from dataclasses import replace
import hashlib
import json
from pathlib import Path
import sys
import time
from uuid import uuid4

from mcap.reader import make_reader
import numpy as np


def main(episode: Path, out: Path) -> None:
    from dimos.imitation.loop.generation import HEIGHT, WIDTH, execute, initial_scene, varied_world
    from dimos.imitation.loop.replay import WorldRecording
    from dimos.imitation.loop.teacher import UnsolvedTaskError
    from dimos.imitation.loop.workcell import WorkbenchConfig
    from dimos.robot.manipulators.openyam.real2sim import prepare_scene
    from dimos.sim2.world.runtime import STATE, SimulationRuntime
    import mujoco

    out.mkdir(parents=True, exist_ok=True)
    started = time.time()
    meta = json.loads((episode / "metadata.json").read_text())
    record = json.loads(Path(meta["sim2_run_record"]).read_text())
    # The experiment folder holds the workcell the generator was given; the episode folder is two below it.
    config = WorkbenchConfig.load(episode.parent.parent / "workcell.json")
    simulation = config.simulation(out / "assets", width=WIDTH, height=HEIGHT)
    world = replace(simulation.world, scene=prepare_scene(config.package, out / "scene"))
    sample = meta["variation"]
    with np.load(meta["trajectory"], allow_pickle=False) as data:
        actions, phases = data["action"], [str(phase) for phase in data["phase"]]
    source = record.get("runtime_source") or {}
    current = hashlib.sha256(Path(source["path"]).read_bytes()).hexdigest() if source.get("path") and Path(source["path"]).is_file() else None
    result: dict = {
        "ok": False, "mujoco": {"recorded": record.get("mujoco_version"), "now": mujoco.__version__},
        "runtime": {"path": source.get("path"), "unchanged": current is not None and current == source.get("sha256")},
    }
    runtime = SimulationRuntime(varied_world(world, sample), f"replay-{uuid4().hex}")
    try:
        runtime.reset(initial_scene(sample))
        spec = int(record["initial_state"]["spec"])
        start = np.zeros(mujoco.mj_stateSize(runtime.model, spec))
        mujoco.mj_getState(runtime.model, runtime.data, start, spec)
        saved = np.asarray(record["initial_state"]["values"])
        result["start_difference"] = float(np.abs(start - saved).max()) if start.shape == saved.shape else None
        recording = WorldRecording(runtime.snapshot_descriptor)
        try:
            metrics = execute(runtime, actions, phases, recording=recording)
            result["validation"] = metrics
        except UnsolvedTaskError as error:
            # The repeat went another way than the recording did. What it did up to there is still kept.
            result["stopped"] = str(error)
        if not recording.snapshots:
            raise RuntimeError("the repeat produced no world snapshots")
        recording.save(out / "world-history.npz")
        result["snapshots"], result["controls"] = len(recording.snapshots), len(recording.controls)
    finally:
        runtime.close()

    # How far the repeat is from what was recorded: joint state frame by frame, and where things ended.
    file = next(episode / name for name in ("episode.mcap", "discarded.mcap") if (episode / name).exists())
    with file.open("rb") as stream:
        frames = [json.loads(message.data) for _, _, message in make_reader(stream).iter_messages()]
    by_sequence = {control["command_sequence"]: control for control in recording.controls}
    matched = [(frame, by_sequence[frame["command_sequence"]]) for frame in frames if frame.get("command_sequence") in by_sequence]
    if matched:
        states = np.abs(np.asarray([frame["state"] for frame, _ in matched]) - np.asarray([control["state"] for _, control in matched]))
        commands = np.abs(np.asarray([frame["accepted_action"] for frame, _ in matched]) - np.asarray([control["accepted_action"] for _, control in matched]))
        names = meta.get("joint_names") or [str(index) for index in range(states.shape[1])]
        result["frames"] = {"recorded": len(frames), "matched": len(matched)}
        result["state_difference"] = {"largest": float(states.max()), "at_frame": int(states.max(axis=1).argmax()), "by_joint": {name: float(value) for name, value in zip(names, states.max(axis=0), strict=False)}}
        result["action_difference"] = float(commands.max())
    recorded = meta.get("task_validation") or {}
    ends = {}
    for key, value in (result.get("validation") or {}).items():
        before = recorded.get(key)
        if isinstance(value, list) and isinstance(before, list) and len(value) == len(before) == 3:
            ends[key] = float(np.linalg.norm(np.subtract(value, before)))
    result["end_difference_m"] = ends
    result["ok"] = "stopped" not in result and bool(matched)
    result["seconds"] = time.time() - started
    (out / "recovery.json").write_text(json.dumps(result, indent=1))
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main(Path(sys.argv[1]), Path(sys.argv[2]))
    except Exception as error:  # noqa: BLE001  The server shows the reason; a traceback goes to its log.
        Path(sys.argv[2]).mkdir(parents=True, exist_ok=True)
        (Path(sys.argv[2]) / "recovery.json").write_text(json.dumps({"ok": False, "error": f"{type(error).__name__}: {error}"}))
        raise
