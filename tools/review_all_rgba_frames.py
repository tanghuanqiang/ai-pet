#!/usr/bin/env python3
"""Render every RGBA motion frame at desktop size on three backgrounds.

This is visual evidence, never an automatic approval or an install step.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw


BACKGROUNDS = (
    ("warm", (244, 238, 224, 255)),
    ("blue", (185, 215, 238, 255)),
    ("dark", (37, 41, 48, 255)),
)
DISPLAY_SIZE = (190, 254)
FRAMES_PER_PAGE = 12


def frame_files(folder: Path) -> list[Path]:
    frames = sorted(folder.glob("*.png"))
    if not 2 <= len(frames) <= 120:
        raise ValueError("Expected 2–120 RGBA PNG frames")
    names = [path.name for path in frames]
    one_indexed = [f"{number:06d}.png" for number in range(1, len(frames) + 1)]
    zero_indexed_plain = [f"{number:06d}.png" for number in range(len(frames))]
    zero_indexed = [f"frame-{number:03d}.png" for number in range(len(frames))]
    if names not in (one_indexed, zero_indexed_plain, zero_indexed):
        raise ValueError("Frames must have contiguous numbered PNG names")
    return frames


def fit_sprite(sprite: Image.Image) -> Image.Image:
    fitted = sprite.copy()
    fitted.thumbnail(DISPLAY_SIZE, Image.Resampling.LANCZOS)
    return fitted


def render_panel(sprite: Image.Image, color: tuple[int, int, int, int]) -> Image.Image:
    panel = Image.new("RGBA", DISPLAY_SIZE, color)
    fitted = fit_sprite(sprite)
    panel.alpha_composite(fitted, ((DISPLAY_SIZE[0] - fitted.width) // 2,
                                    (DISPLAY_SIZE[1] - fitted.height) // 2))
    return panel.convert("RGB")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--frames", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--fps", type=int, default=25)
    parser.add_argument("--unordered", action="store_true", help="Unique-image evidence without a playback timeline")
    args = parser.parse_args()
    if not 1 <= args.fps <= 60:
        parser.error("--fps must be 1–60")
    files = frame_files(args.frames)
    args.output.mkdir(parents=True, exist_ok=True)
    sheet_width = 2 * (3 * DISPLAY_SIZE[0] + 18) + 18
    sheet_height = 6 * (DISPLAY_SIZE[1] + 29) + 18
    page = None
    source_size = None
    previous_mask = None
    previous_center = None
    frames_report = []
    pages = []
    for index, path in enumerate(files):
        with Image.open(path) as loaded:
            if loaded.mode != "RGBA":
                raise ValueError(f"Frame {path.name} is {loaded.mode}, not RGBA")
            if source_size is None:
                source_size = loaded.size
            elif loaded.size != source_size:
                raise ValueError(f"Frame {path.name} changed canvas size")
            sprite = loaded.copy()
        rgba = np.asarray(sprite)
        alpha = rgba[:, :, 3]
        visible = alpha > 0
        opaque = alpha >= 128
        if not visible.any():
            raise ValueError(f"Frame {path.name} is empty")
        ys, xs = np.where(visible)
        bounds = [int(xs.min()), int(ys.min()), int(xs.max() + 1), int(ys.max() + 1)]
        center = [float(xs.mean()), float(ys.mean())]
        border = {"top": int(np.count_nonzero(opaque[0, :])),
                  "bottom": int(np.count_nonzero(opaque[-1, :])),
                  "left": int(np.count_nonzero(opaque[:, 0])),
                  "right": int(np.count_nonzero(opaque[:, -1]))}
        intersection = np.count_nonzero(previous_mask & opaque) if previous_mask is not None else None
        union = np.count_nonzero(previous_mask | opaque) if previous_mask is not None else None
        frame_report = {
            "frame": index + 1,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "visiblePixels": int(np.count_nonzero(visible)),
            "opaquePixels": int(np.count_nonzero(opaque)),
            "alphaBounds": bounds,
            "opaqueOuterBorderPixels": border,
            "adjacentOpaqueMaskIoU": round(intersection / union, 6) if union and not args.unordered else None,
            "centerTravelPx": round(float(np.linalg.norm(np.subtract(center, previous_center))), 3)
                if previous_center is not None and not args.unordered else None,
        }
        frames_report.append(frame_report)
        previous_mask = opaque
        previous_center = center

        if index % FRAMES_PER_PAGE == 0:
            page = Image.new("RGB", (sheet_width, sheet_height), "#faf8f2")
        assert page is not None
        slot = index % FRAMES_PER_PAGE
        col, row = slot % 2, slot // 2
        base_x = 18 + col * (3 * DISPLAY_SIZE[0] + 18)
        base_y = 18 + row * (DISPLAY_SIZE[1] + 29)
        draw = ImageDraw.Draw(page)
        label = (f"Unique image {index + 1:03d}/{len(files):03d} (unordered)" if args.unordered
                 else f"Frame {index + 1:03d}/{len(files):03d}  {index / args.fps:.2f}s")
        draw.text((base_x, base_y), label, fill="#272a30")
        for background_index, (name, color) in enumerate(BACKGROUNDS):
            x = base_x + background_index * DISPLAY_SIZE[0]
            page.paste(render_panel(sprite, color), (x, base_y + 16))
            draw.text((x + 3, base_y + 16 + DISPLAY_SIZE[1] - 15), name,
                      fill="#ffffff" if name == "dark" else "#111111")
        if slot == FRAMES_PER_PAGE - 1 or index == len(files) - 1:
            page_path = args.output / f"page-{index // FRAMES_PER_PAGE + 1:02d}.png"
            used_rows = row + 1
            page.crop((0, 0, sheet_width, 18 + used_rows * (DISPLAY_SIZE[1] + 29))).save(page_path)
            pages.append(str(page_path.resolve()))

    report = {
        "framesDirectory": str(args.frames.resolve()),
        "frameCount": len(files), "fps": None if args.unordered else args.fps,
        "unorderedEvidence": args.unordered,
        "sourceCanvas": list(source_size), "previewPixelsPerBackground": list(DISPLAY_SIZE),
        "backgrounds": {name: list(color[:3]) for name, color in BACKGROUNDS},
        "pages": pages,
        "frames": frames_report,
        "outerBorderContactFrames": [item["frame"] for item in frames_report
                                     if any(item["opaqueOuterBorderPixels"].values())],
        "visualApproval": False,
        "installable": False,
        "note": "Per-frame structure and three-background render only; inspect anatomy, identity, motion and alpha by eye.",
    }
    report_path = args.output / "report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"frameCount": len(files), "pages": len(pages),
                      "outerBorderContactFrames": report["outerBorderContactFrames"],
                      "report": str(report_path.resolve())}))


if __name__ == "__main__":
    main()
