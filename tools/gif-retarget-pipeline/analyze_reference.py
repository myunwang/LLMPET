#!/usr/bin/env python3
"""Decode a reference GIF into evidence used by a retargeting job."""

from __future__ import annotations

import argparse
from hashlib import sha256
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def file_sha256(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def font(size: int) -> ImageFont.ImageFont:
    path = Path("/System/Library/Fonts/SFNS.ttf")
    return ImageFont.truetype(str(path), size) if path.exists() else ImageFont.load_default()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--gif", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    source = args.gif.resolve()
    output = args.output.resolve()
    frame_dir = output / "frames"
    frame_dir.mkdir(parents=True, exist_ok=True)

    frames: list[Image.Image] = []
    durations: list[int] = []
    disposals: list[int | None] = []
    with Image.open(source) as image:
        loop = image.info.get("loop")
        canvas = list(image.size)
        for index in range(image.n_frames):
            image.seek(index)
            frame = image.convert("RGBA")
            frame.save(frame_dir / f"frame_{index:03d}.png", optimize=True)
            frames.append(frame)
            durations.append(int(image.info.get("duration", 0)))
            disposals.append(getattr(image, "disposal_method", None))

    tile = 240
    columns = min(4, len(frames))
    rows = (len(frames) + columns - 1) // columns
    contact = Image.new("RGB", (columns * tile, rows * tile), (242, 244, 249))
    draw = ImageDraw.Draw(contact)
    label_font = font(22)
    for index, frame in enumerate(frames):
        row, column = divmod(index, columns)
        panel = Image.new("RGBA", (tile, tile), (242, 244, 249, 255))
        panel.alpha_composite(frame.resize((tile, tile), Image.Resampling.NEAREST))
        contact.paste(panel.convert("RGB"), (column * tile, row * tile))
        draw.rounded_rectangle(
            (column * tile + 5, row * tile + 5, column * tile + 54, row * tile + 38),
            radius=6,
            fill=(26, 40, 78),
        )
        draw.text((column * tile + 12, row * tile + 8), f"{index:02d}", font=label_font, fill=(255, 255, 255))
    contact.save(output / "contact-sheet.png", optimize=True)

    metadata = {
        "schema": "gif-reference-evidence.v1",
        "source": str(source),
        "sha256": file_sha256(source),
        "canvas": canvas,
        "frame_count": len(frames),
        "durations_ms": durations,
        "total_duration_ms": sum(durations),
        "loop": loop,
        "disposal": disposals,
        "decoded_frame_sha256": [sha256(frame.tobytes()).hexdigest() for frame in frames],
        "distinct_decoded_frames": len({sha256(frame.tobytes()).digest() for frame in frames}),
    }
    (output / "reference.json").write_text(json.dumps(metadata, indent=2) + "\n")
    print(json.dumps(metadata, indent=2))


if __name__ == "__main__":
    main()
