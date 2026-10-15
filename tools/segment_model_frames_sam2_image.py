"""Independent per-frame SAM2 diagnostic; no video memory or theme approval."""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import time
import numpy as np
from PIL import Image
from video_alpha import scores_to_alpha

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root/'third_party/SAM2-src'))
p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--driver', type=Path, required=True)
p.add_argument('--points', type=Path, required=True)
p.add_argument('--output', type=Path, required=True)
a = p.parse_args()
driver = json.loads((a.driver/'driver-report.json').read_text())
points = json.loads(a.points.read_text())
if len(driver['frames']) != 60 or driver['fps'] != 20:
    raise ValueError('Expected verified 60-frame model driver')
coords = np.asarray(points['positive']+points['negative'], dtype=np.float32)
labels = np.asarray([1]*len(points['positive'])+[0]*len(points['negative']), dtype=np.int32)
paths = [a.driver/'lossless'/f['file'] for f in driver['frames']]
if any(sha(path) != f['sha256'] for path, f in zip(paths, driver['frames'])):
    raise ValueError('Driver frame provenance mismatch')
a.output.mkdir(parents=True, exist_ok=False)
(a.output/'rgba-frames').mkdir()
import torch
from sam2.build_sam import build_sam2
from sam2.sam2_image_predictor import SAM2ImagePredictor
checkpoint = root/'models/SAM2.1-hiera-small/sam2.1_hiera_small.pt'
started = time.perf_counter()
predictor = SAM2ImagePredictor(build_sam2('configs/sam2.1/sam2.1_hiera_s.yaml', str(checkpoint), device='cuda'))
scores = []; records = []
with torch.inference_mode(), torch.autocast('cuda', dtype=torch.bfloat16):
    for i, path in enumerate(paths):
        rgb = np.asarray(Image.open(path).convert('RGB'))
        predictor.set_image(rgb)
        masks, confidence, _ = predictor.predict(point_coords=coords, point_labels=labels,
            multimask_output=False, return_logits=True)
        score = masks[0].astype(np.float32)
        if score.shape != rgb.shape[:2] or not np.isfinite(score).all():
            raise ValueError('Invalid per-frame model mask')
        for x, y in points['positive']:
            if score[int(y), int(x)] <= 0:
                raise ValueError(f'Frame {i} foreground prompt missed')
        alpha = scores_to_alpha(score); color = rgb.copy(); color[alpha == 0] = 0
        out = a.output/'rgba-frames'/f'{i+1:06d}.png'
        Image.fromarray(np.dstack((color, alpha))).save(out)
        scores.append(score)
        records.append({'frame': i, 'sourceSha256': sha(path), 'rgbaSha256': sha(out),
            'confidence': float(confidence[0])})
        print(json.dumps({'frame': i, 'confidence': float(confidence[0])}), flush=True)
scores = np.stack(scores)
np.savez_compressed(a.output/'scores.npz', scores=scores)
same_rgb = np.array_equal(np.asarray(Image.open(paths[0])), np.asarray(Image.open(paths[-1])))
same_alpha = np.array_equal(scores_to_alpha(scores[0]), scores_to_alpha(scores[-1]))
metrics = {'model':'SAM 2.1 Hiera Small independent image predictor', 'sourceFrameCount':60,
    'reviewPlaybackFps':20, 'videoMemoryUsed':False, 'approvedForInstallation':False,
    'checkpointSha256':sha(checkpoint), 'pointsSha256':sha(a.points),
    'driverReportSha256':sha(a.driver/'driver-report.json'), 'scriptSha256':sha(Path(__file__)),
    'seconds':time.perf_counter()-started, 'identicalEndpointRgb':same_rgb,
    'identicalEndpointAlpha':same_alpha, 'frames':records}
(a.output/'metrics.json').write_text(json.dumps(metrics, indent=2))
if same_rgb and not same_alpha:
    raise ValueError('Identical source images produced inconsistent endpoint alpha')
print(json.dumps({'frames':60,'endpointAlphaEqual':same_alpha,'approved':False}))
