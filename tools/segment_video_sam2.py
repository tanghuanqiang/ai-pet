#!/usr/bin/env python3
"""Propagate point-guided SAM 2.1 masks across extracted frames for review."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
import time

from video_alpha import scores_to_alpha

ROOT = Path(__file__).resolve().parents[1]
SAM2_SOURCE = ROOT / "third_party" / "SAM2-src"
DEFAULT_CHECKPOINT = ROOT / "models" / "SAM2.1-hiera-small" / "sam2.1_hiera_small.pt"
DEFAULT_CONFIG = "configs/sam2.1/sam2.1_hiera_s.yaml"
sys.path.insert(0, str(SAM2_SOURCE))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--frames-dir", type=Path, required=True, help="directory of extracted PNG/JPEG frames")
    parser.add_argument("--points-json", type=Path, required=True, help="JSON with positive and negative [x,y] clicks on the first frame")
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--checkpoint", type=Path, default=DEFAULT_CHECKPOINT)
    parser.add_argument("--device", choices=("cuda", "cpu"), default="cuda")
    parser.add_argument("--fps", type=float, default=25, help="playback rate used for the 190px review GIF")
    parser.add_argument("--theme-package-output", type=Path, help="optionally package the RGBA sequence as a review-required .lotheme")
    parser.add_argument("--theme-name", default="SAM 2.1 video candidate")
    parser.add_argument("--negative-points-as-background-objects", action="store_true",
                        help="experimental: track each negative click as its own positive background object and subtract its logits")
    parser.add_argument("--overwrite", action="store_true", help="replace outputs created by this tool in the output directory")
    return parser.parse_args()


def numbered_frames(directory: Path) -> list[Path]:
    frames = [path for path in directory.iterdir() if path.suffix.lower() in {".png", ".jpg", ".jpeg"}]
    if not frames:
        raise FileNotFoundError(f"No PNG/JPEG frames found in {directory}")
    try:
        frames.sort(key=lambda path: int(path.stem))
    except ValueError:
        frames.sort(key=lambda path: path.name.casefold())
    return frames


def parse_points(path: Path, width: int, height: int):
    import numpy as np

    payload = json.loads(path.read_text(encoding="utf-8"))
    positive = payload.get("positive", [])
    negative = payload.get("negative", [])
    if not positive or not isinstance(positive, list) or not isinstance(negative, list):
        raise ValueError("points JSON must include a non-empty 'positive' list and an optional 'negative' list")
    points = positive + negative
    if any(not isinstance(point, list) or len(point) != 2 for point in points):
        raise ValueError("Each point must be an [x, y] pair")
    if any(not (0 <= float(x) < width and 0 <= float(y) < height) for x, y in points):
        raise ValueError(f"All clicks must be within the first frame ({width}x{height})")
    coords = np.asarray(points, dtype=np.float32)
    labels = np.asarray([1] * len(positive) + [0] * len(negative), dtype=np.int32)
    return coords, labels, positive, negative


def choose_review_frames(scores, maximum: int = 12) -> dict[str, object]:
    """Keep timeline coverage while forcing the worst mask changes into review."""
    import numpy as np

    count, height, width = scores.shape
    binary = scores > 0
    band = max(1, round(min(width, height) * 0.01))
    border = np.stack((binary[:, :band].mean(axis=(1, 2)),
                       binary[:, -band:].mean(axis=(1, 2)),
                       binary[:, :, :band].mean(axis=(1, 2)),
                       binary[:, :, -band:].mean(axis=(1, 2))), axis=1).max(axis=1)
    area = binary.mean(axis=(1, 2))
    area_delta = np.abs(np.diff(area, prepend=area[0]))
    overlap = np.ones(count, dtype=np.float64)
    intersection = np.count_nonzero(binary[1:] & binary[:-1], axis=(1, 2))
    union = np.count_nonzero(binary[1:] | binary[:-1], axis=(1, 2))
    overlap[1:] = intersection / np.maximum(union, 1)

    selected = {0, count - 1}
    for index in np.linspace(0, count - 1, min(8, count)).round().astype(int):
        selected.add(int(index))
    worst = {
        "maskJump": int(np.argmin(overlap[1:]) + 1) if count > 1 else 0,
        "borderContact": int(np.argmax(border)),
        "areaChange": int(np.argmax(area_delta)),
    }
    for index in worst.values():
        selected.add(index)
    if len(selected) > maximum:
        protected = {0, count - 1, *worst.values()}
        optional = sorted(selected - protected)
        positions = np.linspace(0, len(optional) - 1, maximum - len(protected)).round().astype(int)
        selected = protected | {optional[int(position)] for position in positions}
    while len(selected) < min(maximum, count):
        ordered = sorted(selected)
        left, right = max(zip(ordered[:-1], ordered[1:]), key=lambda pair: pair[1] - pair[0])
        if right - left <= 1:
            break
        selected.add((left + right) // 2)
    return {"frames": [index + 1 for index in sorted(selected)],
            "worstFrames": {reason: index + 1 for reason, index in worst.items()},
            "method": "timeline-plus-worst-mask-jump-border-contact-area-change"}


def render_contact_sheet(source_frames: list[Path], scores, destination: Path,
                         review_frames: list[int], worst_frames: dict[str, int]) -> None:
    from PIL import Image, ImageDraw

    indices = [frame - 1 for frame in review_frames]
    tile, label_h, gap = 190, 22, 12
    cell_w = tile * 2 + gap
    rows = (len(indices) + 2) // 3
    sheet = Image.new("RGB", (cell_w * 3, (tile + label_h) * rows), (40, 43, 49))
    draw = ImageDraw.Draw(sheet)
    backgrounds = ((244, 222, 179), (112, 163, 211))
    for position, frame_idx in enumerate(indices):
        source = Image.open(source_frames[frame_idx]).convert("RGB")
        alpha_mask = Image.fromarray(scores_to_alpha(scores[frame_idx]), "L")
        x = (position % 3) * cell_w
        y = (position // 3) * (tile + label_h)
        for col, background in enumerate(backgrounds):
            canvas = Image.new("RGB", source.size, background)
            canvas.paste(source, mask=alpha_mask)
            canvas.thumbnail((tile, tile), Image.Resampling.LANCZOS)
            panel = Image.new('RGB', (tile, tile), background)
            panel.paste(canvas, ((tile-canvas.width)//2, (tile-canvas.height)//2))
            sheet.paste(panel, (x + col * (tile + gap), y))
        short_labels = {"maskJump": "jump", "borderContact": "edge", "areaChange": "area"}
        reasons = [short_labels[reason] for reason, frame in worst_frames.items() if frame == frame_idx + 1]
        marker = " [" + ",".join(reasons) + "]" if reasons else ""
        draw.text((x, y + tile + 3), f"frame {frame_idx + 1:03d}{marker}  warm / blue", fill=(248, 246, 241))
    sheet.save(destination, quality=94, subsampling=0)


def render_review_gif(source_frames: list[Path], scores, destination: Path, fps: float) -> None:
    from PIL import Image

    frames = []
    background = (112, 163, 211)
    for frame_idx, frame_path in enumerate(source_frames):
        source = Image.open(frame_path).convert("RGB")
        canvas = Image.new("RGB", source.size, background)
        canvas.paste(source, mask=Image.fromarray(scores_to_alpha(scores[frame_idx]), "L"))
        canvas.thumbnail((190, 190), Image.Resampling.LANCZOS)
        panel = Image.new('RGB', (190, 190), background)
        panel.paste(canvas, ((190-canvas.width)//2, (190-canvas.height)//2))
        frames.append(panel.convert("P", palette=Image.Palette.ADAPTIVE, colors=256))
    frames[0].save(
        destination,
        save_all=True,
        append_images=frames[1:],
        duration=max(20, round(1000 / fps)),
        loop=0,
        optimize=True,
    )


def main() -> int:
    import numpy as np
    import torch
    from PIL import Image

    args = parse_args()
    source_dir = args.frames_dir.expanduser().resolve()
    point_file = args.points_json.expanduser().resolve()
    output = args.output_dir.expanduser().resolve()
    checkpoint = args.checkpoint.expanduser().resolve()
    theme_package_output = args.theme_package_output.expanduser().resolve() if args.theme_package_output else None
    if not source_dir.is_dir() or not point_file.is_file() or not checkpoint.is_file():
        raise FileNotFoundError("Frames directory, points JSON, and SAM 2.1 checkpoint must exist")
    if source_dir == output or source_dir in output.parents:
        raise ValueError("Output directory must not be inside the source frame directory")
    if output.exists() and any(output.iterdir()) and not args.overwrite:
        raise FileExistsError(f"Output directory is not empty; pass --overwrite or choose another path: {output}")
    if args.device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA was requested, but torch.cuda.is_available() is false")
    if not 1 <= args.fps <= 60:
        raise ValueError("--fps must be between 1 and 60")
    frames = numbered_frames(source_dir)
    first = Image.open(frames[0]).convert("RGB")
    width, height = first.size
    for frame in frames[1:]:
        with Image.open(frame) as current:
            if current.size != (width, height):
                raise ValueError(f"All frames must share one canvas size; {frame.name} is {current.size}, expected {(width, height)}")
    points, labels, positive, negative = parse_points(point_file, width, height)

    output.mkdir(parents=True, exist_ok=True)
    input_jpegs = output / "sam2-input-jpeg"
    rgba_dir = output / "rgba-frames"
    input_jpegs.mkdir(exist_ok=True)
    rgba_dir.mkdir(exist_ok=True)
    for stale in input_jpegs.glob("*.jpg"):
        stale.unlink()
    for stale in rgba_dir.glob("*.png"):
        stale.unlink()
    jpeg_paths = []
    for index, frame in enumerate(frames):
        jpeg = input_jpegs / f"{index:05d}.jpg"
        Image.open(frame).convert("RGB").save(jpeg, quality=96, subsampling=0)
        jpeg_paths.append(jpeg)

    os.chdir(SAM2_SOURCE)
    from sam2.build_sam import build_sam2_video_predictor

    load_started = time.perf_counter()
    model = build_sam2_video_predictor(
        DEFAULT_CONFIG,
        str(checkpoint),
        device=args.device,
        apply_postprocessing=False,
        vos_optimized=False,
    )
    load_seconds = time.perf_counter() - load_started
    if args.device == "cuda":
        torch.cuda.reset_peak_memory_stats()
    infer_started = time.perf_counter()
    autocast = torch.autocast("cuda", dtype=torch.bfloat16) if args.device == "cuda" else torch.autocast("cpu", enabled=False)
    with torch.inference_mode(), autocast:
        state = model.init_state(str(input_jpegs), offload_video_to_cpu=True, offload_state_to_cpu=True)
        if args.negative_points_as_background_objects and negative:
            # Some SAM 2.1 checkpoints return NO_OBJ_SCORE for a mixed positive /
            # negative initial prompt. In this experiment, track each user-marked
            # background region as a separate positive object, then subtract those
            # logits from the pet logits after propagation.
            model.add_new_points_or_box(
                state, frame_idx=0, obj_id=1, points=positive,
                labels=np.ones(len(positive), dtype=np.int32), normalize_coords=True,
            )
            for object_id, point in enumerate(negative, start=2):
                model.add_new_points_or_box(
                    state, frame_idx=0, obj_id=object_id, points=[point],
                    labels=np.ones(1, dtype=np.int32), normalize_coords=True,
                )
        else:
            model.add_new_points_or_box(
                state,
                frame_idx=0,
                obj_id=1,
                points=points,
                labels=labels,
                # UI/CLI clicks are expressed in the original frame's pixel space.
                # SAM2 normalizes them against video_width/video_height before its
                # internal image-size scaling.
                normalize_coords=True,
            )
        masks_by_frame = {}
        for frame_idx, _object_ids, masks in model.propagate_in_video(state):
            values = masks.float().cpu().numpy()[:, 0]
            if args.negative_points_as_background_objects and negative:
                id_to_index = {int(object_id): index for index, object_id in enumerate(_object_ids)}
                foreground = values[id_to_index[1]]
                background = np.maximum.reduce([values[id_to_index[index]] for index in range(2, len(negative) + 2)])
                masks_by_frame[int(frame_idx)] = np.minimum(foreground, -background)
            else:
                masks_by_frame[int(frame_idx)] = values[0]
    inference_seconds = time.perf_counter() - infer_started
    if len(masks_by_frame) != len(frames):
        raise RuntimeError(f"Expected {len(frames)} masks, received {len(masks_by_frame)}")
    scores = np.stack([masks_by_frame[index] for index in range(len(frames))])
    point_scores = [float(scores[0, int(y), int(x)]) for x, y in positive]
    missed_positive = [str(index) for index, score in enumerate(point_scores, start=1)
                       if not np.isfinite(score) or score <= 0]
    if missed_positive:
        print(json.dumps({
            "diagnostic": "first-frame-positive-prompt-missed",
            "scoreShape": list(scores.shape),
            "frameDimensions": [width, height],
            "positivePoints": positive,
            "positivePointScores": point_scores,
            "scoreRange": [float(np.nanmin(scores[0])), float(np.nanmax(scores[0]))],
        }, separators=(",", ":")), file=sys.stderr, flush=True)
        raise ValueError(f"first-frame-positive-prompt-missed: {','.join(missed_positive)}")
    binary_masks = scores > 0
    adjacent_ious = []
    for left, right in zip(binary_masks[:-1], binary_masks[1:]):
        adjacent_ious.append(float((left & right).sum() / max((left | right).sum(), 1)))
    display_scores = scores.copy()
    bootstrap_mask_frame = None
    opening_band = max(1, round(min(width, height) * 0.01))
    def opening_border_fractions(mask):
        return (float(mask[:opening_band].mean()), float(mask[-opening_band:].mean()),
                float(mask[:, :opening_band].mean()), float(mask[:, -opening_band:].mean()))
    first_border = opening_border_fractions(binary_masks[0])
    second_border = opening_border_fractions(binary_masks[1])
    opening_border_shift = max(abs(left - right) for left, right in zip(first_border, second_border))
    unstable_opening = adjacent_ious[0] < 0.9 or (adjacent_ious[0] < 0.97 and opening_border_shift >= 0.08)
    bootstrap_count = 0
    if unstable_opening:
        if len(frames) >= 4 and min(adjacent_ious[1:3]) >= 0.98:
            bootstrap_count = 2
        elif len(frames) >= 5 and min(adjacent_ious[2:4]) >= 0.98:
            bootstrap_count = 3
        else:
            raise ValueError("first-frame-mask-unstable: choose a quieter opening or more foreground points")
        fourth_rgb = np.asarray(Image.open(frames[3]).convert("RGB"), dtype=np.int16)
        for frame in frames[:bootstrap_count]:
            opening_rgb = np.asarray(Image.open(frame).convert("RGB"), dtype=np.int16)
            if float(np.abs(opening_rgb - fourth_rgb).mean()) > 8.0:
                raise ValueError("first-frame-mask-unstable: opening motion is too large for mask bootstrap")
        display_scores[:bootstrap_count] = scores[3]
        bootstrap_mask_frame = 4
    display_binary_masks = display_scores > 0
    display_adjacent_ious = [float((left & right).sum() / max((left | right).sum(), 1))
                             for left, right in zip(display_binary_masks[:-1], display_binary_masks[1:])]
    stats = []
    border_band_px = max(1, round(min(width, height) * 0.01))
    border_contact_frames = {side: 0 for side in ("top", "bottom", "left", "right")}
    for index, (frame, score) in enumerate(zip(frames, display_scores)):
        source = np.asarray(Image.open(frame).convert("RGB"))
        alpha_bytes = scores_to_alpha(score)
        # Fully transparent pixels must not retain recoverable source-frame colour.
        source = source.copy()
        source[alpha_bytes == 0] = 0
        rgba = np.dstack([source, alpha_bytes])
        Image.fromarray(rgba).save(rgba_dir / f"{index + 1:06d}.png")
        binary = alpha_bytes >= 128
        border_fractions = {
            "top": float(binary[:border_band_px].mean()),
            "bottom": float(binary[-border_band_px:].mean()),
            "left": float(binary[:, :border_band_px].mean()),
            "right": float(binary[:, -border_band_px:].mean()),
        }
        for side, fraction in border_fractions.items():
            if fraction >= 0.1:
                border_contact_frames[side] += 1
        stats.append({
            "frame": index + 1,
            "foregroundFraction": round(float(binary.mean()), 6),
            "softAlphaFraction": round(float(alpha_bytes.mean()) / 255, 6),
            "fullyTransparentPixels": int(np.count_nonzero(alpha_bytes == 0)),
            "edgeForegroundPixels": int(binary[0].sum() + binary[-1].sum() + binary[:, 0].sum() + binary[:, -1].sum()),
            "borderOpaqueFraction": {side: round(value, 6) for side, value in border_fractions.items()},
        })
    review_sampling = choose_review_frames(display_scores)
    render_contact_sheet(frames, display_scores, output / "review-190px-warm-blue.jpg",
                         review_sampling["frames"], review_sampling["worstFrames"])
    render_review_gif(frames, display_scores, output / "review-190px-loop.gif", args.fps)
    np.savez_compressed(output / "scores.npz", scores=scores)
    package_result = None
    if theme_package_output:
        if not args.fps.is_integer() or not 1 <= args.fps <= 30:
            raise ValueError("Packaging requires an integer --fps from 1 to 30")
        from theme_package import pack
        from argparse import Namespace

        package_args = Namespace(
            name=args.theme_name,
            slot="idle",
            fps=int(args.fps),
            once=False,
            output=theme_package_output,
            frames=[str(rgba_dir / f"{index + 1:06d}.png") for index in range(len(frames))],
        )
        package_result = pack(package_args)
    metrics = {
        "model": "SAM 2.1 Hiera Small",
        "checkpoint": str(checkpoint.relative_to(ROOT)) if checkpoint.is_relative_to(ROOT) else str(checkpoint),
        "config": DEFAULT_CONFIG,
        "sourceFrameCount": len(frames),
        "canvas": [width, height],
        "reviewPlaybackFps": args.fps,
        "device": args.device,
        "promptCoordinateSpace": "source-frame-pixels-normalized-to-video-dimensions",
        "promptFrameDimensions": [width, height],
        "positivePoints": positive,
        "negativePoints": negative,
        "negativePointMode": "separate-background-object-logit-subtraction" if args.negative_points_as_background_objects and negative else "sam2-negative-clicks",
        "maskThreshold": 0,
        "alphaMapping": "bounded smoothstep(mask score, half-width 0.25)",
        "firstFrameMaskIoU": round(adjacent_ious[0], 6),
        "firstFrameBorderShift": round(opening_border_shift, 6),
        "bootstrapMaskFrame": bootstrap_mask_frame,
        "bootstrapCount": bootstrap_count,
        "modelLoadSeconds": round(load_seconds, 3),
        "inferenceSeconds": round(inference_seconds, 3),
        "peakCudaMemoryGiB": round(torch.cuda.max_memory_allocated() / (1024 ** 3), 3) if args.device == "cuda" else None,
        "adjacentBinaryMaskIoU": {
            "min": round(min(display_adjacent_ious), 6),
            "mean": round(float(np.mean(display_adjacent_ious)), 6),
            "max": round(max(display_adjacent_ious), 6),
        },
        "rawAdjacentBinaryMaskIoU": {
            "min": round(min(adjacent_ious), 6),
            "mean": round(float(np.mean(adjacent_ious)), 6),
            "max": round(max(adjacent_ious), 6),
        },
        "borderContact": {
            "bandPx": border_band_px,
            "opaqueAlphaThreshold": 128,
            "minimumBandFraction": 0.1,
            "contactFrames": border_contact_frames,
        },
        "reviewSampling": review_sampling,
        "status": "review-required",
        "approvedForInstallation": False,
        "themePackage": package_result,
        "frameStats": stats,
    }
    (output / "metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")
    print(json.dumps({key: metrics[key] for key in ("sourceFrameCount", "canvas", "reviewPlaybackFps", "device", "modelLoadSeconds", "inferenceSeconds", "peakCudaMemoryGiB", "adjacentBinaryMaskIoU", "status", "approvedForInstallation", "themePackage")}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
