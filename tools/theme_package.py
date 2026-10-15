"""Build and inspect deterministic, review-pending Little Orbit theme packages.

The package contract validates structure only. It cannot approve identity,
anatomy, action quality, or alpha-edge quality; every generated package remains
non-installable until a separate human review and runtime approval flow exists.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import re
import stat
import sys
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any

from PIL import Image, ImageDraw, ImageOps


KIND = "little-orbit.theme"
VERSION = 1
ALLOWED_SLOTS = {
    "idle", "ambient", "recent-activity", "needs-user", "stop-unknown",
    "interrupt", "hover", "click",
}
MAX_FRAMES = 120
MAX_FRAME_BYTES = 8 * 1024 * 1024
MAX_FRAME_EDGE = 4096
MAX_FRAME_PIXELS = 16 * 1024 * 1024
MAX_PACKAGE_BYTES = 120 * 1024 * 1024
FRAME_RE = re.compile(r"^frames/([a-z][a-z0-9-]{0,31})/(\d{4})\.png$")


class PackageError(ValueError):
    pass


def _object_without_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise PackageError(f"duplicate JSON field: {key}")
        result[key] = value
    return result


def _load_json(data: bytes) -> dict[str, Any]:
    try:
        value = json.loads(data.decode("utf-8", errors="strict"), object_pairs_hook=_object_without_duplicates)
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as error:
        raise PackageError(f"invalid UTF-8 JSON: {error}") from error
    if not isinstance(value, dict):
        raise PackageError("manifest root must be an object")
    return value


def _has_exact_keys(value: dict[str, Any], expected: set[str], label: str) -> None:
    actual = set(value)
    if actual != expected:
        missing = sorted(expected - actual)
        unknown = sorted(actual - expected)
        raise PackageError(f"{label} fields are invalid (missing={missing}, unknown={unknown})")


def _validate_manifest(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    _has_exact_keys(manifest, {"actions", "format", "name", "review", "version"}, "manifest")
    if manifest["format"] != KIND or manifest["version"] != VERSION:
        raise PackageError("unsupported theme format or version")
    name = manifest["name"]
    if not isinstance(name, str) or not (1 <= len(name.strip()) <= 48):
        raise PackageError("theme name must contain 1 to 48 characters")
    if manifest["review"] != "required":
        raise PackageError("packages must remain marked for human review")
    actions = manifest["actions"]
    if not isinstance(actions, list) or not (1 <= len(actions) <= len(ALLOWED_SLOTS)):
        raise PackageError("actions must contain 1 to 8 supported slots")
    seen: set[str] = set()
    for action in actions:
        if not isinstance(action, dict):
            raise PackageError("each action must be an object")
        _has_exact_keys(action, {"fps", "frames", "loop", "slot"}, "action")
        slot = action["slot"]
        if not isinstance(slot, str) or slot not in ALLOWED_SLOTS or slot in seen:
            raise PackageError(f"unsupported or duplicate action slot: {slot!r}")
        seen.add(slot)
        fps = action["fps"]
        if isinstance(fps, bool) or not isinstance(fps, int) or not 1 <= fps <= 30:
            raise PackageError(f"{slot} fps must be an integer from 1 to 30")
        if not isinstance(action["loop"], bool):
            raise PackageError(f"{slot} loop must be boolean")
        frames = action["frames"]
        if not isinstance(frames, list) or not (1 <= len(frames) <= MAX_FRAMES):
            raise PackageError(f"{slot} must have 1 to {MAX_FRAMES} frames")
        for index, path in enumerate(frames, 1):
            expected = f"frames/{slot}/{index:04d}.png"
            if not isinstance(path, str) or path != expected:
                raise PackageError(f"frame path must be the package-local fixed path {expected}")
    return actions


def _validate_png(data: bytes, label: str) -> tuple[int, int]:
    if not data or len(data) > MAX_FRAME_BYTES:
        raise PackageError(f"{label} is empty or larger than 8 MiB")
    try:
        with Image.open(io.BytesIO(data)) as image:
            if image.format != "PNG":
                raise PackageError(f"{label} is not a PNG")
            image.load()
            if image.mode != "RGBA":
                raise PackageError(f"{label} must use RGBA pixel data")
            width, height = image.size
            if not (1 <= width <= MAX_FRAME_EDGE and 1 <= height <= MAX_FRAME_EDGE):
                raise PackageError(f"{label} dimensions exceed 4096 pixels per side")
            if width * height > MAX_FRAME_PIXELS:
                raise PackageError(f"{label} exceeds 16 megapixels")
            if image.getchannel("A").getextrema() == (255, 255):
                raise PackageError(f"{label} is fully opaque; alpha transparency is required")
            if image.getchannel("A").getextrema() == (0, 0):
                raise PackageError(f"{label} is fully transparent and has no visible pixels")
            return width, height
    except PackageError:
        raise
    except Exception as error:
        raise PackageError(f"{label} cannot be decoded as PNG: {error}") from error


def _zip_info(name: str) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    info.create_system = 3
    info.external_attr = (stat.S_IFREG | 0o644) << 16
    return info


def pack(args: argparse.Namespace) -> dict[str, Any]:
    if args.slot not in ALLOWED_SLOTS:
        raise PackageError(f"unsupported action slot: {args.slot}")
    if not 1 <= args.fps <= 30:
        raise PackageError("fps must be an integer from 1 to 30")
    if not (1 <= len(args.frames) <= MAX_FRAMES):
        raise PackageError(f"provide 1 to {MAX_FRAMES} PNG frames")
    paths = [Path(path).resolve(strict=True) for path in args.frames]
    if len({path.name.casefold() for path in paths}) != len(paths):
        raise PackageError("frame filenames must be unique")
    if any(path.is_symlink() or not path.is_file() or path.suffix.casefold() != ".png" for path in paths):
        raise PackageError("input frames must be regular PNG files, not links")
    ordered = sorted(paths, key=lambda path: path.name.casefold())
    frames: list[tuple[str, bytes, tuple[int, int]]] = []
    for index, path in enumerate(ordered, 1):
        data = path.read_bytes()
        dimensions = _validate_png(data, path.name)
        frames.append((f"frames/{args.slot}/{index:04d}.png", data, dimensions))
    if len({frame[2] for frame in frames}) != 1:
        raise PackageError("all frames in an action must use the same canvas dimensions")

    manifest = {
        "actions": [{
            "fps": args.fps,
            "frames": [frame[0] for frame in frames],
            "loop": not args.once,
            "slot": args.slot,
        }],
        "format": KIND,
        "name": args.name,
        "review": "required",
        "version": VERSION,
    }
    _validate_manifest(manifest)
    manifest_bytes = (json.dumps(manifest, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
    if sum(len(frame[1]) for frame in frames) + len(manifest_bytes) > MAX_PACKAGE_BYTES:
        raise PackageError("theme package exceeds 120 MiB")
    target = Path(args.output)
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        raise PackageError(f"refusing to overwrite existing package: {target}")
    temporary = target.with_name(target.name + ".tmp")
    try:
        with zipfile.ZipFile(temporary, "w", allowZip64=False, compresslevel=9) as archive:
            archive.writestr(_zip_info("manifest.json"), manifest_bytes)
            for name, data, _dimensions in frames:
                archive.writestr(_zip_info(name), data)
        inspect_package(temporary)
        os.replace(temporary, target)
    finally:
        if temporary.exists():
            temporary.unlink()
    return inspect_package(target)


def pack_multi(args: argparse.Namespace) -> dict[str, Any]:
    spec_path = Path(args.spec).resolve(strict=True)
    if not spec_path.is_file() or spec_path.stat().st_size > 64 * 1024:
        raise PackageError("multi-action spec must be a JSON file below 64 KiB")
    spec = _load_json(spec_path.read_bytes())
    _has_exact_keys(spec, {"name", "actions"}, "multi-action spec")
    entries = spec["actions"]
    if not isinstance(entries, list) or not 1 <= len(entries) <= len(ALLOWED_SLOTS):
        raise PackageError("multi-action spec must contain 1 to 7 actions")
    seen: set[str] = set()
    actions: list[dict[str, Any]] = []
    frames: list[tuple[str, bytes]] = []
    all_dimensions: set[tuple[int, int]] = set()
    for entry in entries:
        if not isinstance(entry, dict):
            raise PackageError("multi-action entry must be an object")
        _has_exact_keys(entry, {"slot", "fps", "loop", "directory"}, "multi-action entry")
        slot = entry["slot"]
        fps = entry["fps"]
        loop = entry["loop"]
        directory_name = entry["directory"]
        if not isinstance(slot, str) or slot not in ALLOWED_SLOTS or slot in seen:
            raise PackageError("unsupported or duplicate multi-action slot")
        if type(fps) is not int or not 1 <= fps <= 30 or type(loop) is not bool:
            raise PackageError("multi-action fps or loop is invalid")
        if not isinstance(directory_name, str) or not re.fullmatch(r"[a-z][a-z0-9-]{0,31}", directory_name):
            raise PackageError("multi-action directory must be a simple local folder name")
        directory = spec_path.parent / directory_name
        if not directory.is_dir() or directory.is_symlink():
            raise PackageError("multi-action frame directory is missing or a link")
        paths = sorted(directory.iterdir(), key=lambda path: path.name)
        if not 1 <= len(paths) <= MAX_FRAMES or any(
            path.name != f"frame-{index:03d}.png" or path.is_symlink() or not path.is_file()
            for index, path in enumerate(paths)
        ):
            raise PackageError("multi-action frames must be sequential regular frame-000.png files")
        dimensions: set[tuple[int, int]] = set()
        package_paths = []
        for index, path in enumerate(paths, 1):
            data = path.read_bytes()
            dimensions.add(_validate_png(data, path.name))
            package_path = f"frames/{slot}/{index:04d}.png"
            frames.append((package_path, data))
            package_paths.append(package_path)
        if len(dimensions) != 1:
            raise PackageError(f"{slot} frames do not share a stable canvas")
        all_dimensions.update(dimensions)
        actions.append({"slot": slot, "fps": fps, "loop": loop, "frames": package_paths})
        seen.add(slot)
    if "idle" not in seen:
        raise PackageError("multi-action theme requires an idle action")
    if len(all_dimensions) != 1:
        raise PackageError("all multi-action slots must share one stable canvas")
    manifest = {"actions": actions, "format": KIND, "name": spec["name"],
                "review": "required", "version": VERSION}
    _validate_manifest(manifest)
    manifest_bytes = (json.dumps(manifest, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
    if len(manifest_bytes) + sum(len(data) for _, data in frames) > MAX_PACKAGE_BYTES:
        raise PackageError("theme package exceeds 120 MiB")
    target = Path(args.output)
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        raise PackageError(f"refusing to overwrite existing package: {target}")
    temporary = target.with_name(target.name + ".tmp")
    try:
        with zipfile.ZipFile(temporary, "w", allowZip64=False, compresslevel=9) as archive:
            archive.writestr(_zip_info("manifest.json"), manifest_bytes)
            for name, data in frames:
                archive.writestr(_zip_info(name), data)
        inspect_package(temporary)
        os.replace(temporary, target)
    finally:
        if temporary.exists():
            temporary.unlink()
    return inspect_package(target)


def inspect_package(package: Path) -> dict[str, Any]:
    try:
        with zipfile.ZipFile(package, "r") as archive:
            infos = archive.infolist()
            if len(infos) > MAX_FRAMES * len(ALLOWED_SLOTS) + 1:
                raise PackageError("theme contains too many entries")
            if sum(info.file_size for info in infos) > MAX_PACKAGE_BYTES:
                raise PackageError("theme expands beyond 120 MiB")
            if len({info.filename for info in infos}) != len(infos):
                raise PackageError("theme contains duplicate ZIP entries")
            by_name: dict[str, zipfile.ZipInfo] = {}
            for info in infos:
                path = PurePosixPath(info.filename)
                if path.is_absolute() or ".." in path.parts or "\\" in info.filename or "\x00" in info.filename:
                    raise PackageError(f"unsafe package path: {info.filename!r}")
                if info.is_dir() or (info.external_attr >> 16) & 0o170000 == stat.S_IFLNK:
                    raise PackageError(f"directories and links are not allowed: {info.filename!r}")
                if info.flag_bits & 0x1:
                    raise PackageError("encrypted ZIP entries are not allowed")
                by_name[info.filename] = info
            if "manifest.json" not in by_name:
                raise PackageError("theme is missing manifest.json")
            if by_name["manifest.json"].file_size > 64 * 1024:
                raise PackageError("manifest exceeds 64 KiB")
            manifest = _load_json(archive.read("manifest.json"))
            actions = _validate_manifest(manifest)
            expected_files = {"manifest.json"}
            canvas: dict[str, list[int]] = {}
            total_transparent_pixels = 0
            for action in actions:
                dims: set[tuple[int, int]] = set()
                for path in action["frames"]:
                    if path not in by_name:
                        raise PackageError(f"manifest references missing frame: {path}")
                    info = by_name[path]
                    if info.file_size > MAX_FRAME_BYTES or info.file_size == 0:
                        raise PackageError(f"{path} has an invalid compressed size")
                    if info.compress_size and info.file_size / info.compress_size > 300:
                        raise PackageError(f"{path} has a suspicious compression ratio")
                    data = archive.read(path)
                    dims.add(_validate_png(data, path))
                    with Image.open(io.BytesIO(data)) as image:
                        alpha = image.getchannel("A")
                        total_transparent_pixels += image.width * image.height - alpha.histogram()[255]
                    expected_files.add(path)
                if len(dims) != 1:
                    raise PackageError(f"{action['slot']} frames do not share a stable canvas")
                width, height = next(iter(dims))
                canvas[action["slot"]] = [width, height]
            if set(by_name) != expected_files:
                raise PackageError(f"unexpected package entries: {sorted(set(by_name) - expected_files)}")
            return {
                "valid": True,
                "format": KIND,
                "version": VERSION,
                "name": manifest["name"],
                "canvas": canvas,
                "frameCount": sum(len(action["frames"]) for action in actions),
                "transparentPixels": total_transparent_pixels,
                "readyForHumanReview": True,
                "installable": False,
                "review": "required",
            }
    except PackageError:
        raise
    except (OSError, zipfile.BadZipFile, RuntimeError) as error:
        raise PackageError(f"cannot read theme archive: {error}") from error


def preview(args: argparse.Namespace) -> dict[str, Any]:
    with zipfile.ZipFile(args.package, "r") as archive:
        result = inspect_package(Path(args.package))
        manifest = _load_json(archive.read("manifest.json"))
        action = next((item for item in manifest["actions"] if item["slot"] == args.slot), None)
        if action is None:
            raise PackageError(f"theme has no {args.slot} action")
        frames = [Image.open(io.BytesIO(archive.read(path))).convert("RGBA") for path in action["frames"]]
    if not frames:
        raise PackageError(f"theme has no {args.slot} action")
    cell_width, cell_height = 190, 254
    count = min(4, len(frames))
    if len(frames) > count:
        indices = sorted({round(index * (len(frames) - 1) / (count - 1)) for index in range(count)}) if count > 1 else [0]
        frames = [frames[index] for index in indices]
    row_height = cell_height + 22
    sheet = Image.new("RGB", (2 * cell_width, count * row_height), "#fffaf0")
    draw = ImageDraw.Draw(sheet)
    for index, image in enumerate(frames[:count]):
        image = ImageOps.contain(image, (cell_width - 8, cell_height - 8), Image.Resampling.LANCZOS)
        y = index * row_height + (cell_height - image.height) // 2
        for column, background in enumerate(("#f4eee0", "#b9d7ee")):
            x = column * cell_width + (cell_width - image.width) // 2
            tile = Image.new("RGBA", image.size, background)
            tile.alpha_composite(image)
            sheet.paste(tile.convert("RGB"), (x, y))
            label = ("warm background" if column == 0 else "blue background") + f" | {args.slot} {index + 1}"
            draw.text((column * cell_width + 8, index * row_height + cell_height + 3), label, fill="#333333")
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(output, quality=94)
    result["preview"] = str(args.output)
    result["previewSize"] = [sheet.width, sheet.height]
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    pack_parser = sub.add_parser("pack", help="build a review-pending theme from RGBA PNG frames")
    pack_parser.add_argument("--name", required=True)
    pack_parser.add_argument("--slot", default="idle", choices=sorted(ALLOWED_SLOTS))
    pack_parser.add_argument("--fps", type=int, default=8)
    pack_parser.add_argument("--once", action="store_true")
    pack_parser.add_argument("--output", type=Path, required=True)
    pack_parser.add_argument("frames", nargs="+")
    multi_parser = sub.add_parser("pack-multi", help="build a review-pending theme from local action frame directories")
    multi_parser.add_argument("--spec", type=Path, required=True)
    multi_parser.add_argument("--output", type=Path, required=True)
    inspect_parser = sub.add_parser("inspect", help="validate a package without extracting it")
    inspect_parser.add_argument("package", type=Path)
    preview_parser = sub.add_parser("preview", help="render a 190px contact sheet on warm and blue backgrounds")
    preview_parser.add_argument("package", type=Path)
    preview_parser.add_argument("--slot", default="idle", choices=sorted(ALLOWED_SLOTS))
    preview_parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command == "pack":
            result = pack(args)
        elif args.command == "pack-multi":
            result = pack_multi(args)
        elif args.command == "inspect":
            result = inspect_package(args.package)
        else:
            result = preview(args)
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 0
    except PackageError as error:
        print(json.dumps({"valid": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
