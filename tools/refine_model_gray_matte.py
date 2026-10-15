"""Review-only known-gray color projection in a narrow SAM2 contour band."""
import argparse
import json
from pathlib import Path
import shutil
import numpy as np
from PIL import Image
from scipy.ndimage import distance_transform_edt
from transparent_head_tilt import sha

p = argparse.ArgumentParser(description=__doc__)
for name in ('driver','matte','output'): p.add_argument('--'+name, type=Path, required=True)
a = p.parse_args()
d = json.loads((a.driver/'driver-report.json').read_text())
m = json.loads((a.matte/'metrics.json').read_text())
if m['driverReportSha256'] != sha(a.driver/'driver-report.json') or len(d['frames']) != 60:
    raise ValueError('Matte/model provenance mismatch')
a.output.mkdir(parents=True, exist_ok=False); (a.output/'rgba-frames').mkdir()
records = []; alphas = []
for i, record in enumerate(d['frames']):
    raw_path = a.driver/'lossless'/record['file']
    input_path = a.matte/'rgba-frames'/f'{i+1:06d}.png'
    if sha(raw_path) != record['sha256'] or sha(input_path) != m['frames'][i]['rgbaSha256']:
        raise ValueError('Model/matte frame fingerprint mismatch')
    raw = np.asarray(Image.open(raw_path).convert('RGB'))
    original = np.asarray(Image.open(input_path).convert('RGBA'))
    visible = original[:, :, 3] > 0
    if not np.array_equal(original[:, :, :3][visible], raw[visible]):
        raise ValueError('Matte RGB is not the actual model output')
    mask = original[:, :, 3] >= 128
    interior_distance = distance_transform_edt(mask)
    trusted = (original[:, :, 3] >= 250) & (interior_distance >= 3)
    if not trusted.any(): raise ValueError('No opaque interior for foreground color estimate')
    _, nearest = distance_transform_edt(~trusted, return_indices=True)
    foreground = raw[nearest[0], nearest[1]].astype(np.float32)-128
    contrast = np.square(foreground).sum(axis=2)
    projection = ((raw.astype(np.float32)-128)*foreground).sum(axis=2)/np.maximum(contrast, 1)
    band = (interior_distance < 3) & (distance_transform_edt(~mask) <= 4)
    observed = raw.astype(np.float32)-128
    reconstruction = np.clip(projection, 0, 1)[:, :, None]*foreground
    reconstruction_error = np.max(np.abs(observed-reconstruction), axis=2)
    observed_contrast = np.linalg.norm(observed, axis=2)
    confident = (contrast >= 100) & (reconstruction_error <= 8)
    alpha = original[:, :, 3].astype(np.float32)/255
    alpha[trusted] = 1
    alpha[band & confident] = np.clip(projection[band & confident], 0, 1)
    alpha[band & ~mask & (observed_contrast < 12)] = 0
    alpha[distance_transform_edt(~mask) > 4] = 0
    alpha = np.rint(alpha*255).astype(np.uint8)
    color = raw.copy(); color[alpha == 0] = 0
    out = a.output/'rgba-frames'/f'{i+1:06d}.png'
    Image.fromarray(np.dstack((color, alpha))).save(out)
    alphas.append(alpha)
    records.append({'frame':i,'sourceSha256':record['sha256'],'inputMatteSha256':sha(input_path),
        'rgbaSha256':sha(out),'alphaChangedPixels':int(np.count_nonzero(alpha != original[:, :, 3])),
        'lowConfidenceBandPixels':int(np.count_nonzero(band & ~confident)),
        'suppressedBackgroundNoisePixels':int(np.count_nonzero(band & ~mask & (observed_contrast < 12)))})
same_alpha = np.array_equal(alphas[0], alphas[-1])
if m['identicalEndpointRgb'] and not same_alpha:
    raise ValueError('Deterministic gray matting changed identical endpoint masks')
shutil.copyfile(a.matte/'scores.npz', a.output/'scores.npz')
metrics = {'model':'Known-gray color projection after SAM2 trimap', 'sourceFrameCount':60,
    'reviewPlaybackFps':20,'approvedForInstallation':False,
    'driverReportSha256':sha(a.driver/'driver-report.json'),
    'inputMatteMetricsSha256':sha(a.matte/'metrics.json'),'scriptSha256':sha(Path(__file__)),
    'copiedScoresAreOriginalSam2Logits':True,'foregroundInteriorRadiusPx':3,
    'outsideContourBandPx':4,'minimumForegroundContrastSquared':100,
    'maximumColorReconstructionErrorRgb':8,'minimumNewExteriorContrastRgb':12,
    'identicalEndpointRgb':m['identicalEndpointRgb'],'identicalEndpointAlpha':same_alpha,
    'frames':records,'limitations':['Nearest interior color is a heuristic for fur alpha',
        'Low-contrast band keeps SAM2 alpha; not a ground-truth matte or naturalness approval']}
(a.output/'metrics.json').write_text(json.dumps(metrics, indent=2))
print(json.dumps({'frames':60,'endpointAlphaEqual':same_alpha,'approved':False}))
