"""Local image-model adapters for the studio's candidate-generation service."""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections import deque
from pathlib import Path
from typing import Any

from PIL import Image

from run_birefnet import MODEL_REVISION, load_birefnet, render_preview, segment_photo

ROOT = Path(__file__).resolve().parents[1]
BIREFNET_MODEL_DIR = ROOT / "models" / "BiRefNet-e2bf8e4"
SAM2_MODEL_DIR = ROOT / "models" / "SAM2-hiera-small"
SAM2_MODEL_REVISION = "e080ada8afd19df5e165abe71b006edc7f4c3d4e"


def sam2_coverage_alpha(mask_logits) -> Image.Image:
    """Rasterize the segmentation boundary; model confidence is not opacity.

    Two-times supersampling estimates subpixel coverage only at the contour.
    Interiors remain opaque. This is an antialiased cutout, not hair matting.
    """
    import numpy as np
    logits = np.asarray(mask_logits, dtype=np.float32)
    if logits.ndim != 2 or not np.isfinite(logits).all():
        raise ValueError("invalid-sam2-mask-logits")
    height, width = logits.shape
    high = np.asarray(Image.fromarray(logits, mode="F").resize((width * 2, height * 2), Image.Resampling.BILINEAR))
    binary = Image.fromarray((high > 0).astype(np.uint8) * 255, mode="L")
    return binary.resize((width, height), Image.Resampling.LANCZOS)


def analyze_alpha_bounds(rgba: Image.Image) -> dict[str, Any]:
    """Flag likely image-edge clipping without claiming to detect occlusion or anatomy."""
    import numpy as np

    alpha = np.asarray(rgba.getchannel("A"), dtype=np.uint8)
    height, width = alpha.shape
    band = max(1, round(min(width, height) * 0.01))
    threshold = 240
    bands = {
        "left": alpha[:, :band],
        "right": alpha[:, width - band :],
        "top": alpha[:band, :],
        "bottom": alpha[height - band :, :],
    }
    edge_coverage = {side: round(float(np.mean(values >= threshold) * 100), 2) for side, values in bands.items()}
    possible_crop_sides = [side for side, percent in edge_coverage.items() if percent >= 2.0]
    return {
        "method": "opaque-alpha-coverage-on-outer-one-percent",
        "alphaThreshold": threshold,
        "bandWidthPixels": band,
        "opaqueCoveragePercentBySide": edge_coverage,
        "foregroundCoveragePercent": round(float(np.mean(alpha >= 128) * 100), 2),
        "foregroundCoverageAlphaThreshold": 128,
        "possibleCropSides": possible_crop_sides,
        "isHeuristic": True,
        "doesNotAssess": ["occlusion", "subject identity", "anatomy", "matte quality"],
    }


def analyze_foreground_regions(rgba: Image.Image) -> dict[str, Any]:
    """Find large disconnected alpha islands at review resolution, without naming subjects."""
    alpha = rgba.getchannel("A")
    scale = min(1.0, 256 / max(alpha.size))
    size = (max(1, round(alpha.width * scale)), max(1, round(alpha.height * scale)))
    samples = alpha.resize(size, Image.Resampling.NEAREST).tobytes()
    width, height = size
    opaque = bytearray(value >= 128 for value in samples)
    foreground_count = sum(opaque)
    seen = bytearray(width * height)
    regions: list[int] = []
    for start in range(width * height):
        if not opaque[start] or seen[start]:
            continue
        seen[start] = 1
        queue = deque([start])
        area = 0
        while queue:
            index = queue.popleft()
            area += 1
            x, y = index % width, index // width
            for ny in range(max(0, y - 1), min(height, y + 2)):
                for nx in range(max(0, x - 1), min(width, x + 2)):
                    neighbor = ny * width + nx
                    if opaque[neighbor] and not seen[neighbor]:
                        seen[neighbor] = 1
                        queue.append(neighbor)
        regions.append(area)
    significant = sorted((area for area in regions if area >= max(width * height * 0.005, foreground_count * 0.05)), reverse=True)
    return {
        "method": "eight-connected-alpha-regions-at-256px",
        "alphaThreshold": 128,
        "analysisSize": [width, height],
        "significantRegionCount": len(significant),
        "significantRegionPercentOfForeground": [round(area / foreground_count * 100, 2) for area in significant] if foreground_count else [],
        "possibleExtraForeground": len(significant) > 1,
        "isHeuristic": True,
        "doesNotAssess": ["subject identity", "species", "anatomy", "connected extra objects", "matte quality"],
    }
def analyze_prompt_consistency(
    rgba: Image.Image,
    foreground_points: list[list[int]],
    background_points: list[list[int]],
    radius: int = 4,
) -> dict[str, Any]:
    """Check a small neighborhood around user clicks against candidate alpha."""
    import numpy as np

    alpha = np.asarray(rgba.getchannel("A"), dtype=np.uint8)
    height, width = alpha.shape
    threshold = 128

    def point_hits(point: list[int]) -> bool:
        x, y = point
        left, right = max(0, x - radius), min(width, x + radius + 1)
        top, bottom = max(0, y - radius), min(height, y + radius + 1)
        return bool(np.any(alpha[top:bottom, left:right] >= threshold))

    foreground_hits = [index for index, point in enumerate(foreground_points, 1) if point_hits(point)]
    background_hits = [index for index, point in enumerate(background_points, 1) if point_hits(point)]
    return {
        "method": "alpha-prompt-neighborhood",
        "alphaThreshold": threshold,
        "neighborhoodRadiusPixels": radius,
        "foregroundPointCount": len(foreground_points),
        "foregroundPointHitIndices": foreground_hits,
        "foregroundPointMissedIndices": [index for index in range(1, len(foreground_points) + 1) if index not in foreground_hits],
        "backgroundPointCount": len(background_points),
        "backgroundPointForegroundIndices": background_hits,
        "isHeuristic": True,
    }


class ImageSegmentationAdapter(ABC):
    """Stable contract consumed by the loopback service, independent of model stack."""

    adapter_id: str
    task: str

    @abstractmethod
    def describe(self) -> dict[str, Any]:
        """Return user-visible capabilities, privacy, cost, limits, and runtime."""

    @abstractmethod
    def segment(self, photo: Image.Image, prompts: dict[str, list[list[int]]] | None = None) -> tuple[Image.Image, dict[str, Any]]:
        """Return one RGBA candidate and per-request inference metrics."""

    @abstractmethod
    def render_review(self, photo: Image.Image, rgba: Image.Image, output_dir: Path) -> None:
        """Write the adapter's standard review image into a temporary folder."""


class BiRefNetLocalAdapter(ImageSegmentationAdapter):
    adapter_id = "birefnet-local"
    task = "single-image-foreground-segmentation"

    def __init__(
        self,
        module_cache: Path,
        output_size: int,
        max_body_bytes: int,
        max_image_pixels: int,
    ) -> None:
        self.output_size = output_size
        self.max_body_bytes = max_body_bytes
        self.max_image_pixels = max_image_pixels
        self.runtime = load_birefnet(BIREFNET_MODEL_DIR, "cuda", module_cache)

    def describe(self) -> dict[str, Any]:
        torch = self.runtime["torch"]
        device = self.runtime["device"]
        return {
            "ready": True,
            "adapter": self.adapter_id,
            "task": self.task,
            "model": "ZhengPeng7/BiRefNet",
            "modelRevision": MODEL_REVISION,
            "licenseMetadata": "MIT",
            "licenseNote": "Repository/model-card metadata only; verify applicable code and weight terms before redistribution.",
            "capabilities": {
                "input": ["image/jpeg", "image/png", "image/webp", "application/octet-stream"],
                "output": ["image/png; RGBA"],
                "animationGeneration": False,
                "identityAnalysis": False,
                "requiresHumanReview": True,
            },
            "runtime": {
                "device": torch.cuda.get_device_name(device) if device.type == "cuda" else str(device),
                "torch": torch.__version__,
                "transformers": __import__("transformers").__version__,
                "inferenceSize": f"{self.output_size}x{self.output_size}",
            },
            "privacy": {
                "inferenceOnDevice": True,
                "remoteNetworkUsed": False,
                "loopbackTransfer": "Browser sends the selected image to 127.0.0.1 only when the user requests segmentation.",
                "inputPersisted": False,
                "temporaryOutputDeletedAfterResponse": True,
            },
            "cost": {
                "thirdPartyInferenceFee": 0,
                "localHardwareUse": "Uses this computer's GPU and electricity.",
            },
            "limits": {"maxRequestBytes": self.max_body_bytes, "maxImagePixels": self.max_image_pixels},
        }

    def segment(self, photo: Image.Image, prompts: dict[str, list[list[int]]] | None = None) -> tuple[Image.Image, dict[str, Any]]:
        _mask, rgba, metrics = segment_photo(photo, self.runtime, self.output_size)
        return rgba, metrics

    def render_review(self, photo: Image.Image, rgba: Image.Image, output_dir: Path) -> None:
        render_preview(photo, rgba, self.output_size, output_dir)


class SAM2LocalAdapter(ImageSegmentationAdapter):
    """Locally run SAM 2 with user-provided foreground/background point prompts."""

    adapter_id = "sam2-local"
    task = "single-image-foreground-segmentation"

    def __init__(self, module_cache: Path, output_size: int, max_body_bytes: int, max_image_pixels: int) -> None:
        import torch
        from transformers import Sam2Model, Sam2Processor

        if not (SAM2_MODEL_DIR / "model.safetensors").is_file():
            raise FileNotFoundError(f"SAM 2 local weights were not found: {SAM2_MODEL_DIR}")
        if not torch.cuda.is_available():
            raise RuntimeError("SAM 2 local adapter requires a CUDA GPU in this prototype.")
        self.torch = torch
        self.output_size = output_size
        self.max_body_bytes = max_body_bytes
        self.max_image_pixels = max_image_pixels
        self.device = torch.device("cuda")
        self.dtype = torch.bfloat16
        self.model = Sam2Model.from_pretrained(
            str(SAM2_MODEL_DIR), local_files_only=True, torch_dtype=self.dtype
        ).to(self.device).eval()
        self.processor = Sam2Processor.from_pretrained(str(SAM2_MODEL_DIR), local_files_only=True)

    def describe(self) -> dict[str, Any]:
        return {
            "ready": True,
            "adapter": self.adapter_id,
            "task": self.task,
            "model": "facebook/sam2-hiera-small",
            "modelRevision": SAM2_MODEL_REVISION,
            "licenseMetadata": "Apache-2.0",
            "licenseNote": "Verify the pinned model card and code terms before redistribution; local POC only.",
            "capabilities": {
                "input": ["image/jpeg", "image/png", "image/webp", "application/octet-stream"],
                "output": ["image/png; RGBA"],
                "promptTypes": ["foreground-point", "background-point"],
                "animationGeneration": False,
                "identityAnalysis": False,
                "requiresHumanReview": True,
            },
            "runtime": {
                "device": self.torch.cuda.get_device_name(self.device),
                "torch": self.torch.__version__,
                "transformers": __import__("transformers").__version__,
                "inferenceSize": "original-resolution prompts; model processor resize",
                "dtype": "bfloat16",
            },
            "privacy": {
                "inferenceOnDevice": True,
                "remoteNetworkUsed": False,
                "loopbackTransfer": "Selected image and click prompts are sent only to 127.0.0.1 after the user requests segmentation.",
                "inputPersisted": False,
                "temporaryOutputDeletedAfterResponse": True,
            },
            "cost": {"thirdPartyInferenceFee": 0, "localHardwareUse": "Uses this computer's GPU and electricity."},
            "limits": {"maxRequestBytes": self.max_body_bytes, "maxImagePixels": self.max_image_pixels, "maxPromptPoints": 32},
        }

    def segment(self, photo: Image.Image, prompts: dict[str, list[list[int]]] | None = None) -> tuple[Image.Image, dict[str, Any]]:
        import numpy as np

        prompts = prompts or {}
        foreground = prompts.get("foreground", [])
        background = prompts.get("background", [])
        if not foreground:
            raise ValueError("at-least-one-foreground-point-required")
        points = foreground + background
        labels = [1] * len(foreground) + [0] * len(background)
        self.torch.cuda.reset_peak_memory_stats()
        inputs = self.processor(
            images=photo,
            input_points=[[points]],
            input_labels=[[labels]],
            return_tensors="pt",
        ).to(self.device)
        started = __import__("time").perf_counter()
        with self.torch.inference_mode(), self.torch.autocast("cuda", dtype=self.dtype):
            outputs = self.model(**inputs, multimask_output=True)
        self.torch.cuda.synchronize()
        inference_seconds = __import__("time").perf_counter() - started
        original_sizes = inputs["original_sizes"].cpu()
        logits = self.processor.post_process_masks(
            outputs.pred_masks.float().cpu(), original_sizes, binarize=False
        )[0][0]
        scores = outputs.iou_scores[0, 0].float().cpu().numpy()
        best_index = int(np.argmax(scores))
        candidates = []
        for index, mask_logits in enumerate(logits):
            candidate = photo.convert("RGBA")
            candidate.putalpha(sam2_coverage_alpha(mask_logits.numpy()))
            candidates.append({"index": index, "score": round(float(scores[index]), 5), "image": candidate})
        rgba = candidates[best_index]["image"]
        return rgba, {
            "model": "facebook/sam2-hiera-small",
            "modelRevision": SAM2_MODEL_REVISION,
            "licenseMetadata": "Apache-2.0",
            "dimensions": f"{photo.width}x{photo.height}",
            "inferenceSize": "original-resolution prompts; model processor resize",
            "inferenceSeconds": round(inference_seconds, 3),
            "gpuPeakMemoryGiB": round(self.torch.cuda.max_memory_allocated() / (1024 ** 3), 3),
            "chosenMultimaskIndex": best_index,
            "modelPredictedIoUScore": round(float(scores[best_index]), 5),
            "positivePoints": foreground,
            "negativePoints": background,
            "modelScoreIsHumanQualityApproval": False,
            "alphaMethod": "threshold-zero-with-2x-contour-antialias; confidence-is-not-opacity; not-hair-matting",
            "multimaskCandidates": candidates,
        }

    def render_review(self, photo: Image.Image, rgba: Image.Image, output_dir: Path) -> None:
        render_preview(photo, rgba, self.output_size, output_dir)


ADAPTER_REGISTRY: dict[str, type[ImageSegmentationAdapter]] = {
    BiRefNetLocalAdapter.adapter_id: BiRefNetLocalAdapter,
    SAM2LocalAdapter.adapter_id: SAM2LocalAdapter,
}


def create_adapter(
    adapter_id: str,
    module_cache: Path,
    output_size: int,
    max_body_bytes: int,
    max_image_pixels: int,
) -> ImageSegmentationAdapter:
    """Load a registered local adapter, rejecting unknown IDs before service startup."""
    adapter_type = ADAPTER_REGISTRY.get(adapter_id)
    if adapter_type is None:
        supported = ", ".join(sorted(ADAPTER_REGISTRY))
        raise ValueError(f"Unknown image segmentation adapter {adapter_id!r}; registered adapters: {supported}")
    return adapter_type(module_cache, output_size, max_body_bytes, max_image_pixels)
