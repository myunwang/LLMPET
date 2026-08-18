#!/usr/bin/env python3
"""Verify structural and declared-motion gates for a GIF retarget job."""

from __future__ import annotations

import argparse
from hashlib import sha256
import json
import math
from pathlib import Path
import sys

from PIL import Image


def repo_root(start: Path) -> Path:
    for candidate in (start, *start.parents):
        if (candidate / ".git").exists():
            return candidate
    raise ValueError("manifest is not inside a git checkout")


def read_gif(path: Path) -> tuple[list[Image.Image], list[int], int | None]:
    frames: list[Image.Image] = []
    durations: list[int] = []
    with Image.open(path) as image:
        loop = image.info.get("loop")
        for index in range(image.n_frames):
            image.seek(index)
            frames.append(image.convert("RGBA"))
            durations.append(int(image.info.get("duration", 0)))
    return frames, durations, loop


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest", type=Path)
    args = parser.parse_args()
    manifest_path = args.manifest.resolve()
    manifest = json.loads(manifest_path.read_text())
    root = repo_root(manifest_path.parent)

    source_path = root / manifest["inputs"]["action_gif"]
    output_path = root / manifest["output"]["selected_gif"]
    source_frames, source_durations, _ = read_gif(source_path)
    frames, durations, loop = read_gif(output_path)

    expected_count = int(manifest["output"]["frame_count"])
    scale = float(manifest["output"]["duration_scale"])
    expected_durations = [round(duration * scale) for duration in source_durations]
    expected_canvas = tuple(manifest["output"]["canvas"])
    max_bytes = int(manifest["output"].get("max_bytes", 500 * 1024))

    green_pixels = sum(
        1
        for frame in frames
        for red, green, blue, alpha in frame.get_flattened_data()
        if alpha > 32 and green >= 80 and green >= red + 25 and green >= blue + 12
    )
    checks: dict[str, bool] = {
        "schema gif-retarget.v1": manifest.get("schema_version") == "gif-retarget.v1",
        "frame count matches reference contract": len(source_frames) == len(frames) == expected_count,
        "all output frames distinct": len({sha256(frame.tobytes()).digest() for frame in frames}) == expected_count,
        "duration scale exact": durations == expected_durations,
        "canvas exact": all(frame.size == expected_canvas for frame in frames),
        "loop exact": loop == manifest["output"]["loop"],
        "transparent every frame": all(frame.getchannel("A").getextrema()[0] < 255 for frame in frames),
        "forbidden green absent": green_pixels == 0,
        "file size within limit": output_path.stat().st_size <= max_bytes,
    }

    for anchor in manifest.get("world_anchors", []):
        box = tuple(anchor["box"])
        unique = len({sha256(frame.crop(box).tobytes()).digest() for frame in frames})
        checks[f"world anchor {anchor['id']}"] = unique <= int(anchor["max_unique_hashes"])

    track_spec = manifest.get("motion_track") or {}
    if track_spec.get("path"):
        track_data = json.loads((root / track_spec["path"]).read_text())
        tracks = track_data["frames"]
        checks["motion track frame count"] = len(tracks) == expected_count
        if track_spec.get("opposite_hands"):
            checks["left/right hand displacement opposite"] = all(
                math.isclose(float(item["left_dx"]), -float(item["right_dx"]), abs_tol=0.01)
                and math.isclose(float(item["left_dy"]), -float(item["right_dy"]), abs_tol=0.01)
                for item in tracks
            )
        expected_phases = track_spec.get("left_phase_degrees")
        if expected_phases is not None:
            checks["left finger phases exact"] = [float(item["phase_degrees"]) for item in tracks] == expected_phases

    # Manual review is an explicit production gate, never inferred from tests.
    review = manifest["manual_review"]
    checks["manual semantic review recorded"] = bool(review["semantic_pass"])
    checks["manual animation review recorded"] = bool(review["animation_pass"])

    for label, passed in checks.items():
        print(f"{'PASS' if passed else 'FAIL'} {label}")
    print(f"green_pixels={green_pixels}")
    print(f"bytes={output_path.stat().st_size}")
    return 0 if all(checks.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
