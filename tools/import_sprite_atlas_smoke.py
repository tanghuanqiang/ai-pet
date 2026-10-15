"""Check atlas import with non-AI fixtures, including odd grids and clipping."""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import tempfile
import zipfile

from PIL import Image, ImageDraw

from import_sprite_atlas import import_atlas
from theme_package import PackageError


def main() -> None:
    with tempfile.TemporaryDirectory(prefix='ai-pet-atlas-test-') as temporary:
        root = Path(temporary)
        sheet = Image.new('RGBA', (301, 151))
        draw = ImageDraw.Draw(sheet)
        for index in range(6):
            x, y = (index % 3) * 100, (index // 3) * 75
            draw.rectangle((x + 20, y + 20, x + 65 + index, y + 55), fill=(50 + index, 90, 120, 255))
        source = root / 'atlas.png'
        sheet.save(source)
        args = argparse.Namespace(image=source, columns=3, rows=2, name='Non-AI import fixture',
                                  slot='click', fps=6, loop=False, output=root / 'candidate.lotheme')
        result = import_atlas(args)
        with zipfile.ZipFile(args.output) as package:
            manifest = json.loads(package.read('manifest.json'))
            assert manifest['review'] == 'required'
            assert len(manifest['actions'][0]['frames']) == 1
            assert len(manifest['actions'][1]['frames']) == 6
            assert manifest['actions'][1]['fps'] == 6 and not manifest['actions'][1]['loop']
            assert result['atlas']['canvas'] == [101, 76]
            import io
            first = Image.open(io.BytesIO(package.read('frames/click/0001.png')))
            assert first.getpixel((25, 25)) == sheet.getpixel((25, 25))
        checks = {'oddGridKeepsPixelsAndCommonCanvas': True, 'idleAndMotionRequireReview': True}
        def reject(label, image, columns=3, rows=2):
            image.save(source)
            args.output = root / (label + '.lotheme')
            args.columns, args.rows = columns, rows
            try:
                import_atlas(args)
            except PackageError:
                assert not args.output.exists()
                checks[label] = True
                return
            raise AssertionError(label + ' should fail')
        reject('opaqueRejected', Image.new('RGBA', sheet.size, 'white'))
        reject('emptyRejected', Image.new('RGBA', sheet.size))
        clipped = sheet.copy()
        ImageDraw.Draw(clipped).rectangle((0, 20, 20, 55), fill='red')
        reject('clippingRejected', clipped)
        repeated = Image.new('RGBA', (200, 100))
        repeated.paste(sheet.crop((0, 0, 100, 100)), (0, 0))
        repeated.paste(sheet.crop((0, 0, 100, 100)), (100, 0))
        reject('staticImageRejected', repeated, 2, 1)
        reject('invalidGridRejected', sheet, 0, 2)
        sheet.save(source)
        args.columns, args.rows, args.output = 3, 2, root / 'candidate.lotheme'
        try:
            import_atlas(args)
        except PackageError:
            checks['existingCandidatePreserved'] = True
        else:
            raise AssertionError('existing output overwritten')
        print(json.dumps({'passed': all(checks.values()), 'fixtureIsNotAI': True, 'checks': checks}))


if __name__ == '__main__':
    main()
