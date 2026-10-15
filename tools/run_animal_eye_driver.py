"""Run the existing local animal model with manual points; retain lossless frames.

Review-only experiment: no detector, downloads, approvals or theme installation.
Run with the existing .venv-liveportrait Python environment.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
LIVE = ROOT / 'third_party/LivePortrait-src'


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source', type=Path, required=True)
    p.add_argument('--annotation', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--multiplier', type=float, default=1.5)
    a = p.parse_args()
    if not .5 <= a.multiplier <= 2: raise ValueError('Bounded driver multiplier required')
    source, annotation, output = a.source.resolve(), a.annotation.resolve(), a.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1')
    os.chdir(LIVE); sys.path.insert(0, str(LIVE))
    from PIL import Image
    import numpy as np
    from inference_animals import fast_check_args, partial_fields
    from src.config.argument_config import ArgumentConfig
    from src.config.inference_config import InferenceConfig
    from src.config.crop_config import CropConfig
    import src.live_portrait_pipeline_animal as pipeline
    driver = LIVE / 'assets/examples/driving/wink.pkl'
    args = ArgumentConfig(source=str(source), driving=str(driver), output_dir=str(output),
        manual_animal_face_landmarks_path=str(annotation), driving_multiplier=a.multiplier,
        scale=2.8, flag_stitching=True, flag_pasteback=True)
    fast_check_args(args)
    original_writer = pipeline.images2video
    saved = []
    def retain_frames(frames, wfp, **kwargs):
        if Path(wfp).name == source.stem + '--wink.mp4':
            directory = output / 'lossless'; directory.mkdir()
            for i, frame in enumerate(frames):
                path = directory / f'frame-{i:03}.png'
                Image.fromarray(np.asarray(frame, dtype=np.uint8)).save(path)
                saved.append({'file': path.name, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
        return original_writer(frames, wfp=wfp, **kwargs)
    pipeline.images2video = retain_frames
    started = time.perf_counter()
    model = pipeline.LivePortraitPipelineAnimal(partial_fields(InferenceConfig, args.__dict__),
        partial_fields(CropConfig, args.__dict__))
    model.execute(args)
    if len(saved) != 57: raise RuntimeError('Expected 57 lossless driver frames')
    report = {'model': 'LivePortrait Animals v1.1', 'landmarkRoute': 'manual-nine-point',
        'xposeUsed': False, 'remoteNetworkUsed': False, 'approved': False,
        'licenseLimit': 'Existing local model only; distribution review pending',
        'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
        'annotationSha256': hashlib.sha256(annotation.read_bytes()).hexdigest(),
        'driverSha256': hashlib.sha256(driver.read_bytes()).hexdigest(),
        'multiplier': a.multiplier, 'seconds': time.perf_counter()-started, 'frames': saved}
    (output/'driver-report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')


if __name__ == '__main__': main()
