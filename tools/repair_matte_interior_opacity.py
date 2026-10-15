"""Review-only interior-opacity repair with exact RGB and contour preservation.

An eroded largest foreground component is a heuristic. Review all backgrounds
before using the candidate; this cannot certify identity or complete anatomy.
"""
import argparse
import hashlib
import json
from pathlib import Path
import cv2
import numpy as np
from PIL import Image, ImageDraw
from review_all_rgba_frames import BACKGROUNDS, render_panel


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def repair(base, radius=2):
    if type(radius) is not int or not 1 <= radius <= 8:
        raise ValueError('Radius must be 1–8 pixels')
    if base.dtype != np.uint8 or base.ndim != 3 or base.shape[2] != 4:
        raise ValueError('Expected uint8 RGBA pixels')
    alpha = base[:, :, 3]
    count, labels, stats, _ = cv2.connectedComponentsWithStats((alpha >= 128).astype('uint8'), 8)
    if count < 2:
        raise ValueError('No foreground')
    component = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    body = (labels == component).astype('uint8')
    distance = cv2.distanceTransform(body, cv2.DIST_L2, 5)
    t = np.clip((distance - 1) / radius, 0, 1)
    weight = t * t * (3 - 2 * t)
    candidate = base.copy()
    candidate[:, :, 3] = np.rint(alpha + (255 - alpha.astype('float32')) * weight).astype('uint8')
    assert np.array_equal(candidate[:, :, :3], base[:, :, :3])
    assert np.array_equal(candidate[:, :, 3] > 0, alpha > 0)
    assert np.array_equal(candidate[:, :, 3] >= 128, alpha >= 128)
    assert np.array_equal(candidate[distance <= 1], base[distance <= 1])
    interior = distance >= radius + 1
    if not interior.any():
        raise ValueError('No trusted interior')
    assert np.all(candidate[:, :, 3][interior] == 255)
    metrics = {'interiorPixels': int(interior.sum()),
        'previousPartialInteriorPixels': int(np.count_nonzero(alpha[interior] < 255)),
        'previousInteriorMinAlpha': int(alpha[interior].min()),
        'alphaChangedPixels': int(np.count_nonzero(candidate[:, :, 3] != alpha)),
        'rgbChangedPixels': 0, 'visibleSupportChangedPixels': 0,
        'opaqueContourChangedPixels': 0, 'boundaryWithinOnePixelChangedPixels': 0}
    return candidate, weight, metrics


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source', type=Path, required=True)
    p.add_argument('--source-sha256', required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--radius', type=int, default=2)
    a = p.parse_args()
    if not 1 <= a.radius <= 8:
        p.error('Radius must be 1–8 pixels')
    if sha(a.source) != a.source_sha256:
        raise ValueError('Source fingerprint mismatch')
    with Image.open(a.source) as loaded:
        if loaded.mode != 'RGBA' or not 32 <= min(loaded.size) <= max(loaded.size) <= 1600:
            raise ValueError('Expected 32–1600px RGBA source')
        base = np.asarray(loaded).copy()
    alpha = base[:, :, 3]
    candidate, weight, metrics = repair(base, a.radius)
    a.output.mkdir(parents=True, exist_ok=False)
    path = a.output / 'UNAPPROVED-interior-opaque.png'
    Image.fromarray(candidate).save(path)
    Image.fromarray(np.rint(weight * 255).astype('uint8')).save(a.output / 'repair-weight.png')
    delta = candidate[:, :, 3].astype('int16') - alpha
    Image.fromarray(np.clip(delta * 4, 0, 255).astype('uint8')).save(a.output / 'alpha-change-x4.png')
    sheet = Image.new('RGB', (570, 558), 'white')
    draw = ImageDraw.Draw(sheet)
    for row, (name, pixels) in enumerate((('ORIGINAL', base), ('UNAPPROVED OPACITY REPAIR', candidate))):
        draw.text((5, row * 279 + 5), name, fill='black')
        for col, (_, color) in enumerate(BACKGROUNDS):
            sheet.paste(render_panel(Image.fromarray(pixels), color), (col * 190, row * 279 + 25))
    sheet.save(a.output / 'comparison-190px.png')
    report = {'approved': False, 'installable': False, 'sourceSha256': a.source_sha256,
        'outputSha256': sha(path), 'scriptSha256': sha(__file__), 'radius': a.radius,
        'method': 'Largest alpha>=128 component, distance feather, opaque eroded interior',
        **metrics,
        'limitations': ['Interior foreground classification is a heuristic',
            'Existing boundary defects remain', 'No hidden anatomy or new fur is generated']}
    (a.output / 'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report))


if __name__ == '__main__':
    main()
