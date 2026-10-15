#!/usr/bin/env python3
"""Loopback-only HTTP bridge for registered local image-segmentation adapters."""

from __future__ import annotations

import argparse
import base64
import json
import tempfile
import time
from urllib.parse import urlsplit
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from model_adapters import ADAPTER_REGISTRY, ROOT, ImageSegmentationAdapter, analyze_alpha_bounds, analyze_foreground_regions, analyze_prompt_consistency, create_adapter

MAX_BODY = 16 * 1024 * 1024
MAX_PIXELS = 24_000_000
ALLOWED_ORIGINS = {"http://localhost:4173", "http://127.0.0.1:4173"}
SERVICE_PORT = 4174


def handler_type(adapter: ImageSegmentationAdapter, service_port: int) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "AIPetLocalSegmentation/1.0"

        def _origin_ok(self) -> bool:
            origin = self.headers.get("Origin", "")
            host = self.headers.get("Host", "")
            return origin in ALLOWED_ORIGINS and host in {f"127.0.0.1:{service_port}", f"localhost:{service_port}"}

        def _send(self, status: int, body: bytes, content_type: str) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            if self.headers.get("Origin") in ALLOWED_ORIGINS:
                self.send_header("Access-Control-Allow-Origin", self.headers["Origin"])
                self.send_header("Vary", "Origin")
            self.end_headers()
            self.wfile.write(body)

        def _json(self, status: int, data: dict[str, object]) -> None:
            self._send(status, json.dumps(data, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

        def do_OPTIONS(self) -> None:
            if not self._origin_ok() or urlsplit(self.path).path not in {"/api/segment", "/api/package-still"}:
                self._json(403, {"error": "origin-not-allowed"})
                return
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", self.headers["Origin"])
            self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Segment-Prompts")
            self.send_header("Access-Control-Max-Age", "600")
            self.send_header("Vary", "Origin")
            self.end_headers()

        def do_GET(self) -> None:
            path = urlsplit(self.path).path
            if not self._origin_ok():
                self._json(403, {"error": "origin-not-allowed"})
                return
            if path == "/api/health":
                description = adapter.describe()
                self._json(200, {"ready": description["ready"], "adapter": description["adapter"], "device": description["runtime"]["device"]})
            elif path == "/api/capabilities":
                self._json(200, adapter.describe())
            else:
                self._json(404, {"error": "not-found"})

        def do_POST(self) -> None:
            path = urlsplit(self.path).path
            request_started = time.perf_counter()
            if not self._origin_ok():
                self._json(403, {"error": "origin-not-allowed"})
                return
            if path not in {"/api/segment", "/api/package-still"}:
                self._json(404, {"error": "not-found"})
                return
            packaging_still = path == "/api/package-still"
            expected_types = {"image/png"} if packaging_still else {"image/jpeg", "image/png", "image/webp", "application/octet-stream"}
            if self.headers.get_content_type() not in expected_types:
                self._json(415, {"error": "unsupported-image-type"})
                return
            try:
                length = int(self.headers.get("Content-Length", "-1"))
            except ValueError:
                length = -1
            if length <= 0 or length > MAX_BODY:
                self._json(413, {"error": "image-size-out-of-range"})
                return
            data = self.rfile.read(length)
            if len(data) != length:
                self._json(400, {"error": "incomplete-request"})
                return

            if packaging_still:
                try:
                    import numpy as np
                    from PIL import Image, UnidentifiedImageError
                    from types import SimpleNamespace
                    from theme_package import pack

                    with Image.open(__import__("io").BytesIO(data)) as opened:
                        if opened.format != "PNG" or opened.mode != "RGBA":
                            raise ValueError("rgba-png-required")
                        if opened.width * opened.height > MAX_PIXELS:
                            raise ValueError("image-pixel-limit-exceeded")
                        rgba = np.asarray(opened, dtype=np.uint8).copy()
                    alpha = rgba[:, :, 3]
                    if not np.any(alpha == 0) or not np.any(alpha > 0):
                        raise ValueError("transparent-subject-required")
                    if analyze_foreground_regions(Image.fromarray(rgba, mode="RGBA"))["possibleExtraForeground"]:
                        raise ValueError("multiple-large-foreground-regions")
                    edge_review = analyze_alpha_bounds(Image.fromarray(rgba, mode="RGBA"))
                    if any(percent >= 20.0 for percent in edge_review["opaqueCoveragePercentBySide"].values()):
                        raise ValueError("strong-canvas-edge-contact")
                    rgba[alpha == 0, :3] = 0
                    with tempfile.TemporaryDirectory(prefix="pet-static-theme-") as temp_name:
                        temp_dir = Path(temp_name)
                        frame_path = temp_dir / "frame.png"
                        package_path = temp_dir / "candidate.lotheme"
                        Image.fromarray(rgba, mode="RGBA").save(frame_path)
                        pack(SimpleNamespace(
                            name="静态透明桌宠候选 · 需人工审核",
                            slot="idle",
                            fps=1,
                            once=False,
                            output=package_path,
                            frames=[str(frame_path)],
                        ))
                        package_bytes = package_path.read_bytes()
                    self._send(200, package_bytes, "application/zip")
                except (UnidentifiedImageError, OSError, ValueError) as error:
                    detail = str(error) if str(error) in {"rgba-png-required", "image-pixel-limit-exceeded", "transparent-subject-required", "multiple-large-foreground-regions", "strong-canvas-edge-contact"} else "invalid-rgba-png"
                    self._json(400, {"error": detail})
                except Exception as error:
                    self._json(503, {"error": "theme-package-failed", "detail": type(error).__name__})
                return

            try:
                from PIL import Image, UnidentifiedImageError

                with Image.open(__import__("io").BytesIO(data)) as opened:
                    opened.seek(0)
                    if opened.width * opened.height > MAX_PIXELS:
                        self._json(413, {"error": "image-pixel-limit-exceeded"})
                        return
                    photo = opened.convert("RGB")
            except (UnidentifiedImageError, OSError, ValueError):
                self._json(400, {"error": "invalid-image"})
                return

            raw_prompts = self.headers.get("X-Segment-Prompts")
            prompts = None
            if raw_prompts:
                if adapter.adapter_id != "sam2-local":
                    self._json(400, {"error": "prompts-require-sam2-adapter"})
                    return
                try:
                    prompts = json.loads(raw_prompts)
                    if not isinstance(prompts, dict) or set(prompts) - {"foreground", "background"}:
                        raise ValueError
                    if not isinstance(prompts.get("foreground"), list) or not isinstance(prompts.get("background", []), list):
                        raise ValueError
                    if not 1 <= len(prompts["foreground"]) or len(prompts["foreground"]) + len(prompts.get("background", [])) > 32:
                        raise ValueError
                    for group in (prompts["foreground"], prompts.get("background", [])):
                        for point in group:
                            if (not isinstance(point, list) or len(point) != 2 or
                                    any(type(value) is not int for value in point) or
                                    not 0 <= point[0] < photo.width or not 0 <= point[1] < photo.height):
                                raise ValueError
                except (json.JSONDecodeError, ValueError, TypeError):
                    self._json(400, {"error": "invalid-segmentation-prompts"})
                    return
            elif adapter.adapter_id == "sam2-local":
                self._json(400, {"error": "sam2-prompts-required"})
                return

            try:
                rgba, metrics = adapter.segment(photo, prompts)
                metrics["alphaEdgeReview"] = analyze_alpha_bounds(rgba)
                metrics["foregroundRegionReview"] = analyze_foreground_regions(rgba)
                if prompts is not None:
                    metrics["promptReview"] = analyze_prompt_consistency(rgba, prompts["foreground"], prompts["background"])
                multimask_candidates = metrics.pop("multimaskCandidates", [])
                # Keep only a temporary copy while encoding the browser response.
                with tempfile.TemporaryDirectory(prefix="birefnet-request-") as temp_name:
                    output_dir = Path(temp_name)
                    rgba.save(output_dir / "foreground-candidate.png")
                    adapter.render_review(photo, rgba, output_dir)
                    candidate = (output_dir / "foreground-candidate.png").read_bytes()
                    review = (output_dir / "review-190px.jpg").read_bytes()
                    alternatives = []
                    for variant in multimask_candidates:
                        variant_prompt_review = analyze_prompt_consistency(
                            variant["image"], prompts["foreground"], prompts["background"]
                        ) if prompts is not None else None
                        variant_path = output_dir / f"foreground-variant-{variant['index']}.png"
                        variant["image"].save(variant_path)
                        alternative = {
                            "index": variant["index"],
                            "score": variant["score"],
                            "alphaEdgeReview": analyze_alpha_bounds(variant["image"]),
                            "foregroundRegionReview": analyze_foreground_regions(variant["image"]),
                            "pngBase64": base64.b64encode(variant_path.read_bytes()).decode("ascii"),
                        }
                        if variant_prompt_review is not None:
                            alternative["promptReview"] = variant_prompt_review
                        alternatives.append(alternative)
            except Exception as error:
                self._json(503, {"error": "segmentation-failed", "detail": type(error).__name__})
                return

            response = {
                "status": "candidate-requires-human-review",
                **metrics,
                "requestSeconds": round(time.perf_counter() - request_started, 3),
                "networkUsedForInference": False,
                "foregroundPngBase64": base64.b64encode(candidate).decode("ascii"),
                "reviewJpgBase64": base64.b64encode(review).decode("ascii"),
                "multimaskCandidates": alternatives,
            }
            self._json(200, response)

        def log_message(self, fmt: str, *args: object) -> None:
            # Do not log request content or image-specific paths.
            return

    return Handler


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1", choices=("127.0.0.1",))
    parser.add_argument("--size", type=int, default=1024, choices=(512, 768, 1024, 1536, 2048))
    parser.add_argument("--adapter", default="birefnet-local", choices=sorted(ADAPTER_REGISTRY))
    parser.add_argument("--studio-origin", action="append", default=[], help="Additional exact loopback studio origin, such as http://localhost:3424")
    args = parser.parse_args()
    for origin in args.studio_origin:
        try:
            parsed=urlsplit(origin)
            if (parsed.scheme!='http' or parsed.hostname not in ('localhost','127.0.0.1') or
                parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment or
                parsed.port is None or not 1024<=parsed.port<=65535 or
                origin!=f'http://{parsed.hostname}:{parsed.port}'):
                raise ValueError
        except ValueError:parser.error('--studio-origin must be an exact http loopback origin with a user port')
        ALLOWED_ORIGINS.add(origin)
    print(f"Loading {args.adapter} weights into local GPU memory…", flush=True)
    adapter = create_adapter(
        args.adapter,
        ROOT / "generated" / ".birefnet-modules",
        args.size,
        MAX_BODY,
        MAX_PIXELS,
    )
    server = HTTPServer((args.host, SERVICE_PORT), handler_type(adapter, SERVICE_PORT))
    print(f"{adapter.adapter_id} ready at http://{args.host}:{SERVICE_PORT}; model remains loaded until service exit.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
