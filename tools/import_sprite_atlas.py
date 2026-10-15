"""Package an Agent-generated RGBA sprite atlas as a review-required pet theme.

Splits equal grid cells in reading order and pads odd-sized cells to one canvas.
Preserves every source pixel; it does not generate motion or remove backgrounds.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import tempfile

from PIL import Image

from theme_package import ALLOWED_SLOTS, MAX_FRAMES, MAX_FRAME_EDGE, PackageError, pack_multi


def import_atlas(args: argparse.Namespace) -> dict:
    if not 1 <= args.columns <= MAX_FRAMES or not 1 <= args.rows <= MAX_FRAMES:
        raise PackageError('columns and rows must be positive and at most 120')
    count = args.columns * args.rows
    if not 2 <= count <= MAX_FRAMES:
        raise PackageError('an animation atlas must contain 2 to 120 cells')
    if args.slot not in ALLOWED_SLOTS - {'idle'} or not 1 <= args.fps <= 30:
        raise PackageError('choose a non-idle action slot and fps from 1 to 30')
    source = args.image.absolute()
    if not source.is_file() or source.stat().st_size > 120 * 1024 * 1024:
        raise PackageError('atlas must be a local PNG below 120 MiB')
    if args.output.exists():
        raise PackageError(f'refusing to overwrite existing package: {args.output}')
    with Image.open(source) as opened:
        if opened.format != 'PNG' or opened.mode != 'RGBA' or getattr(opened, 'n_frames', 1) != 1:
            raise PackageError('atlas must be one RGBA PNG with a transparent background')
        width, height = opened.size
        if width * height > 24_000_000 or width < args.columns or height < args.rows:
            raise PackageError('atlas dimensions are invalid or exceed 24 million pixels')
        canvas = ((width + args.columns - 1) // args.columns, (height + args.rows - 1) // args.rows)
        if max(canvas) > MAX_FRAME_EDGE:
            raise PackageError('each cell must fit within 4096 pixels per edge')
        opened.load()
        frames = []
        for index in range(count):
            row, column = divmod(index, args.columns)
            box = (round(column * width / args.columns), round(row * height / args.rows),
                   round((column + 1) * width / args.columns), round((row + 1) * height / args.rows))
            cell = opened.crop(box)
            alpha = cell.getchannel('A')
            if alpha.getextrema() == (255, 255):
                raise PackageError(f'cell {index + 1} is opaque; use an available background-removal tool first')
            solid = alpha.point(lambda value: 255 if value >= 16 else 0).getbbox()
            if not solid:
                raise PackageError(f'cell {index + 1} has no visible subject')
            if solid[0] == 0 or solid[1] == 0 or solid[2] == cell.width or solid[3] == cell.height:
                raise PackageError(f'cell {index + 1} touches its edge; regenerate with transparent margins to avoid clipping')
            frame = Image.new('RGBA', canvas)
            frame.paste(cell, (0, 0))
            frames.append(frame)
    if len({hashlib.sha256(frame.tobytes()).digest() for frame in frames}) < 2:
        raise PackageError('all cells are identical; a static image is not a generated animation')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='ai-pet-atlas-', dir=args.output.parent) as temporary:
        work = Path(temporary)
        (work / 'idle').mkdir()
        (work / args.slot).mkdir()
        frames[0].save(work / 'idle' / 'frame-000.png')
        for index, frame in enumerate(frames):
            frame.save(work / args.slot / f'frame-{index:03d}.png')
        spec = {'name': args.name, 'actions': [
            {'slot': 'idle', 'fps': 1, 'loop': True, 'directory': 'idle'},
            {'slot': args.slot, 'fps': args.fps, 'loop': args.loop, 'directory': args.slot},
        ]}
        path = work / 'spec.json'
        path.write_text(json.dumps(spec, ensure_ascii=False), encoding='utf-8')
        result = pack_multi(argparse.Namespace(spec=path, output=args.output))
    result['atlas'] = {'sha256': hashlib.sha256(source.read_bytes()).hexdigest(),
                       'columns': args.columns, 'rows': args.rows, 'frames': count,
                       'canvas': list(canvas), 'sourcePixelsPreserved': True}
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', type=Path, required=True)
    parser.add_argument('--columns', type=int, required=True)
    parser.add_argument('--rows', type=int, required=True)
    parser.add_argument('--name', required=True)
    parser.add_argument('--slot', choices=sorted(ALLOWED_SLOTS - {'idle'}), default='click')
    parser.add_argument('--fps', type=int, default=6)
    parser.add_argument('--loop', action='store_true')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(import_atlas(args), ensure_ascii=False))
        return 0
    except (PackageError, OSError, Image.DecompressionBombError) as error:
        print(json.dumps({'valid': False, 'error': str(error)}, ensure_ascii=False))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
