#!/usr/bin/env python3
"""Run the pinned BiRefNet foreground model locally and write review artifacts."""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODEL_REVISION = "e2bf8e4460fc8fa32bba5ea4d94b3233d367b0e4"
DEFAULT_MODEL = ROOT / "models" / "BiRefNet-e2bf8e4"
DEFAULT_OUTPUT = ROOT / "generated" / "birefnet-reference"
MAX_IMAGE_BYTES = 16 * 1024 * 1024
MAX_IMAGE_PIXELS = 24_000_000
INPUT_SIZE = (1024, 1024)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", type=Path, default=ROOT / "reference-cat.jpg")
    parser.add_argument("--model-dir", type=Path, default=DEFAULT_MODEL)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--device", choices=("cuda", "cpu"), default="cuda")
    parser.add_argument("--size", type=int, default=1024, choices=(512, 768, 1024, 1536, 2048))
    return parser.parse_args()


def render_preview(photo, rgba, size: int, output: Path) -> None:
    from PIL import Image, ImageOps, ImageDraw

    panel_size = (190, 254)
    source_panel = ImageOps.contain(photo, panel_size, method=Image.Resampling.LANCZOS)
    rgba_panel = ImageOps.contain(rgba, panel_size, method=Image.Resampling.LANCZOS)
    surfaces = ((244, 238, 224), (185, 215, 238), (38, 42, 49))
    gap = 10
    sheet = Image.new("RGB", (panel_size[0] * 4 + gap * 3, panel_size[1] + 30), (250, 248, 242))
    draw = ImageDraw.Draw(sheet)
    for column, label in enumerate(("Source", "Warm BG", "Blue BG", "Dark BG")):
        x = column * (panel_size[0] + gap)
        draw.text((x + panel_size[0] // 2 - len(label) * 3, 5), label, fill=(90, 80, 66))
    source_x = (panel_size[0] - source_panel.width) // 2
    source_y = 25 + (panel_size[1] - source_panel.height) // 2
    sheet.paste(source_panel, (source_x, source_y))
    for column, color in enumerate(surfaces, start=1):
        x = column * (panel_size[0] + gap)
        surface = Image.new("RGBA", panel_size, (*color, 255))
        surface.alpha_composite(rgba_panel, ((panel_size[0] - rgba_panel.width) // 2,
                                            (panel_size[1] - rgba_panel.height) // 2))
        sheet.paste(surface.convert("RGB"), (x, 25))
    sheet.save(output / "review-190px.jpg", quality=94, subsampling=0)


def trim_transparent_canvas(rgba):
    """Remove transparent source margins without dropping any nonzero alpha pixel."""
    from PIL import Image

    alpha = rgba.getchannel("A")
    bounds = alpha.getbbox()
    if bounds is None:
        raise ValueError("foreground matte is completely transparent")
    left, top, right, bottom = bounds
    margin = max(4, round(max(right - left, bottom - top) * 0.04))
    cropped = rgba.crop(bounds)
    result = Image.new("RGBA", (cropped.width + 2 * margin,
                                 cropped.height + 2 * margin), (0, 0, 0, 0))
    result.paste(cropped, (margin, margin))
    return result, {
        "sourceAlphaBounds": [left, top, right, bottom],
        "sourceEdgeContact": [side for side, touched in (
            ("left", left == 0), ("top", top == 0),
            ("right", right == rgba.width), ("bottom", bottom == rgba.height)) if touched],
        "transparentMargin": margin,
        "trimmedCanvas": [result.width, result.height],
    }


def load_birefnet(model_dir: Path, device_name: str, module_cache: Path) -> dict[str, object]:
    """Load the reviewed local model once; also used by the persistent loopback service."""
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_PROGRESS_BARS"] = "1"
    os.environ["HF_MODULES_CACHE"] = str(module_cache.resolve())

    import torch
    import torchvision
    from transformers import AutoModelForImageSegmentation
    from transformers.utils import logging as transformers_logging

    transformers_logging.disable_progress_bar()
    if device_name == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA was requested but is unavailable; no silent CPU fallback was used.")
    device = torch.device(device_name)
    torch.set_grad_enabled(False)
    load_started = time.perf_counter()
    model = AutoModelForImageSegmentation.from_pretrained(
        str(model_dir), trust_remote_code=True, local_files_only=True, use_safetensors=True
    )
    model.to(device=device, dtype=torch.float16 if device.type == "cuda" else torch.float32)
    model.eval()
    if device.type == "cuda":
        torch.cuda.synchronize(device)
    return {
        "torch": torch,
        "torchvision": torchvision,
        "model": model,
        "device": device,
        "loadSeconds": time.perf_counter() - load_started,
    }


def segment_photo(photo, runtime: dict[str, object], size: int):
    """Return a soft alpha matte, transparent PNG image, and per-request metrics."""
    import numpy as np
    import torch
    from PIL import Image
    from torchvision import transforms

    device = runtime["device"]
    model = runtime["model"]
    if device.type == "cuda":
        torch.cuda.reset_peak_memory_stats(device)
    transform = transforms.Compose(
        [
            transforms.Resize((size, size)),
            transforms.ToTensor(),
            transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
        ]
    )
    batch = transform(photo).unsqueeze(0).to(device)
    if device.type == "cuda":
        batch = batch.half()
    inference_started = time.perf_counter()
    with torch.inference_mode():
        prediction = model(batch)[-1].sigmoid().float().cpu().squeeze()
    if device.type == "cuda":
        torch.cuda.synchronize(device)
    inference_seconds = time.perf_counter() - inference_started
    mask_array = (prediction.numpy().clip(0, 1) * 255).round().astype(np.uint8)
    mask = Image.fromarray(mask_array, mode="L").resize(photo.size, Image.Resampling.BILINEAR)
    rgba = photo.convert("RGBA")
    rgba.putalpha(mask)
    alpha = np.asarray(mask, dtype=np.uint8)
    metrics = {
        "model": "ZhengPeng7/BiRefNet",
        "modelRevision": MODEL_REVISION,
        "dimensions": f"{photo.width}x{photo.height}",
        "inferenceSize": f"{size}x{size}",
        "inferenceSeconds": round(inference_seconds, 3),
        "alphaTransparentPercent": round(float(np.mean(alpha == 0) * 100), 3),
        "alphaOpaquePercent": round(float(np.mean(alpha == 255) * 100), 3),
        "alphaSoftPercent": round(float(np.mean((alpha > 0) & (alpha < 255)) * 100), 3),
        "gpuPeakMemoryGiB": round(torch.cuda.max_memory_allocated(device) / (1024**3), 3) if device.type == "cuda" else None,
    }
    return mask, rgba, metrics


def main() -> int:
    args = parse_args()
    image_path = args.image.expanduser().resolve()
    model_dir = args.model_dir.expanduser().resolve()
    output_dir = args.output_dir.expanduser().resolve()

    if not image_path.is_file():
        raise FileNotFoundError(f"Input image not found: {image_path}")
    if image_path.stat().st_size > MAX_IMAGE_BYTES:
        raise ValueError(f"Input image exceeds {MAX_IMAGE_BYTES // (1024 * 1024)} MiB.")
    required_model_files = ("config.json", "BiRefNet_config.py", "birefnet.py", "model.safetensors")
    missing = [name for name in required_model_files if not (model_dir / name).is_file()]
    if missing:
        raise FileNotFoundError(f"Pinned model files are missing from {model_dir}: {', '.join(missing)}")

    output_dir.mkdir(parents=True, exist_ok=True)

    import numpy as np
    from PIL import Image

    with Image.open(image_path) as opened:
        opened.load()
        photo = opened.convert("RGB")
    if photo.width * photo.height > MAX_IMAGE_PIXELS:
        raise ValueError(f"Input image has too many pixels ({photo.width}x{photo.height}).")

    runtime = load_birefnet(model_dir, args.device, output_dir / ".hf_modules")
    mask, rgba, metrics = segment_photo(photo, runtime, args.size)
    mask_path = output_dir / "mask.png"
    rgba_path = output_dir / "foreground-candidate.png"
    trimmed_path = output_dir / "foreground-trimmed-candidate.png"
    mask.save(mask_path)
    rgba.save(rgba_path)
    trimmed, trim_review = trim_transparent_canvas(rgba)
    trimmed.save(trimmed_path)
    render_preview(photo, rgba, args.size, output_dir)
    trimmed_preview_dir = output_dir / "trimmed-review"
    trimmed_preview_dir.mkdir(exist_ok=True)
    render_preview(photo, trimmed, args.size, trimmed_preview_dir)

    report = {
        "status": "candidate-requires-human-review",
        "model": "ZhengPeng7/BiRefNet",
        "modelRevision": MODEL_REVISION,
        "weights": "model.safetensors",
        "licenseMetadata": "MIT",
        "device": runtime["torch"].cuda.get_device_name(runtime["device"]) if runtime["device"].type == "cuda" else "CPU",
        "torch": runtime["torch"].__version__,
        "torchvision": runtime["torchvision"].__version__,
        "transformers": __import__("transformers").__version__,
        "input": str(image_path),
        **metrics,
        "trimReview": trim_review,
        "loadSeconds": round(runtime["loadSeconds"], 3),
        "outputs": {
            "mask": str(mask_path),
            "foregroundCandidate": str(rgba_path),
            "trimmedForegroundCandidate": str(trimmed_path),
            "review190px": str(output_dir / "review-190px.jpg"),
            "trimmedReview190px": str(trimmed_preview_dir / "review-190px.jpg"),
        },
        "networkUsedForInference": False,
        "approvedForInstallation": False,
    }
    report_path = output_dir / "result.json"
    report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
