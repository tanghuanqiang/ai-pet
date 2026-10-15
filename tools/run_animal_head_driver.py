"""Quarantined model-generated 3D head pose experiment, not a rotated bitmap."""
import argparse
import copy
import hashlib
import json
import math
import os
from pathlib import Path
import pickle
import shutil
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
LIVE = ROOT / 'third_party/LivePortrait-src'


def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source', type=Path, required=True)
    p.add_argument('--annotation', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--degrees', type=float)
    p.add_argument('--axis', choices=('roll', 'yaw', 'pitch'))
    p.add_argument('--motion-plan', type=Path)
    p.add_argument('--rgba-source', type=Path)
    p.add_argument('--pose-anchor', choices=('driving', 'source-centroid'),
        help='Optionally remove latent root translation while retaining relative 3D pose')
    a = p.parse_args()
    contract = None
    if a.motion_plan:
        if a.degrees is not None or a.axis is not None or a.pose_anchor is not None or a.rgba_source is None:
            raise ValueError('Motion plan requires RGBA source and cannot be overridden by axis/degrees/pose-anchor')
        from model_head_plan import bind_inputs
        contract = bind_inputs(json.loads(a.motion_plan.read_text(encoding='utf-8')),
            a.rgba_source, a.source, a.annotation)
        a.degrees, a.axis = contract['signedPeakDegrees'], contract['axis']
        a.pose_anchor = contract['poseAnchor']
    else:
        if a.rgba_source is not None:
            raise ValueError('RGBA source binding requires a motion plan')
        a.degrees = 4 if a.degrees is None else a.degrees
        a.axis = 'roll' if a.axis is None else a.axis
        a.pose_anchor = 'driving' if a.pose_anchor is None else a.pose_anchor
    if not math.isfinite(a.degrees) or not 2 <= abs(a.degrees) <= 12:
        raise ValueError('Model pose must be bounded to 2–12 degrees')
    source, annotation, output = a.source.resolve(), a.annotation.resolve(), a.output.resolve()
    points = json.loads(annotation.read_text())
    if points['sourceSha256'] != sha(source):
        raise ValueError('Annotation source mismatch')
    output.mkdir(parents=True, exist_ok=False)
    if contract is not None:
        shutil.copyfile(a.motion_plan, output/'model-motion-plan.json')
    encoder = shutil.which('ffmpeg')
    if not encoder:
        raise ValueError('Explicit video encoder required')
    os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', IMAGEIO_FFMPEG_EXE=encoder)
    os.chdir(LIVE); sys.path.insert(0, str(LIVE))
    import numpy as np
    from PIL import Image
    from inference_animals import fast_check_args, partial_fields
    from src.config.argument_config import ArgumentConfig
    from src.config.inference_config import InferenceConfig
    from src.config.crop_config import CropConfig
    import src.live_portrait_pipeline_animal as pipeline
    original = LIVE / 'assets/examples/driving/wink.pkl'
    if sha(original) != '9acacbe805d07266fc8455c42285b008974183d929de41c6bd8c9d07528b79fb':
        raise ValueError('Local seed template fingerprint mismatch')
    seed = pickle.loads(original.read_bytes())
    template = {'n_frames': 60, 'output_fps': 20, 'motion': []}
    from model_head_plan import pose_weights
    envelope = contract['envelope'] if contract is not None else 'sin2-return'
    weights = pose_weights(envelope)
    angles = []
    for index in range(60):
        angle = a.degrees * weights[index]
        theta = math.radians(angle)
        c, s = math.cos(theta), math.sin(theta)
        matrices = {'roll': [[c,-s,0],[s,c,0],[0,0,1]],
            'yaw': [[c,0,s],[0,1,0],[-s,0,c]], 'pitch': [[1,0,0],[0,c,-s],[0,s,c]]}
        rotation = np.asarray(matrices[a.axis], dtype=np.float32)
        frame = copy.deepcopy(seed['motion'][0])
        frame['R'] = frame['R'] @ rotation
        template['motion'].append(frame); angles.append(angle)
    driver_name = 'bounded-' + a.axis
    driver = output / (driver_name + '.pkl')
    driver.write_bytes(pickle.dumps(template))
    (output / 'driver-plan.json').write_text(json.dumps({'kind': '3D latent rotation before animal warp_decode',
        'notBitmapRotation': True, 'axis': a.axis, 'fps': 20, 'envelope':envelope,
        'anglesDegrees': angles, 'seedTemplateSha256': sha(original),
        'approved': False}, indent=2))
    args = ArgumentConfig(source=str(source), driving=str(driver), output_dir=str(output),
        manual_animal_face_landmarks_path=str(annotation), driving_multiplier=1,
        scale=2.8, flag_stitching=True, flag_pasteback=True)
    fast_check_args(args)
    writer = pipeline.images2video
    saved = []
    def retain_frames(frames, wfp, **kwargs):
        if Path(wfp).name == source.stem + '--' + driver_name + '.mp4':
            directory = output / 'lossless'; directory.mkdir()
            for index, frame in enumerate(frames):
                path = directory / f'frame-{index:03d}.png'
                Image.fromarray(np.asarray(frame, dtype=np.uint8)).save(path)
                saved.append({'file': path.name, 'sha256': sha(path)})
        return writer(frames, wfp=wfp, **kwargs)
    pipeline.images2video = retain_frames
    started = time.perf_counter()
    model = pipeline.LivePortraitPipelineAnimal(partial_fields(InferenceConfig, args.__dict__),
        partial_fields(CropConfig, args.__dict__))
    # Observe actual latent displacement before/after learned stitching, without
    # altering the network output. This distinguishes driver attenuation from
    # a later transparent-motion transfer problem.
    wrapper = model.live_portrait_wrapper_animal
    stitch = wrapper.stitching
    telemetry = []
    def observe_stitch(source_kp, driving_kp):
        result = stitch(source_kp, driving_kp)
        before = (driving_kp-source_kp).detach().float().norm(dim=-1)
        after = (result-source_kp).detach().float().norm(dim=-1)
        observation = {'frame': len(telemetry),
            'beforeStitchMeanDisplacement': before.mean().item(),
            'beforeStitchMaxDisplacement': before.max().item(),
            'afterStitchMeanDisplacement': after.mean().item(),
            'afterStitchMaxDisplacement': after.max().item()}
        if a.pose_anchor == 'source-centroid':
            translation = result.mean(dim=1, keepdim=True)-source_kp.mean(dim=1, keepdim=True)
            anchored = result-translation
            pair_before = result[:, :, None, :]-result[:, None, :, :]
            pair_after = anchored[:, :, None, :]-anchored[:, None, :, :]
            error = (pair_after-pair_before).abs().max().item()
            if error > 1e-6:
                raise ValueError('Root anchoring changed relative 3D keypoint pose')
            observation.update(removedRootTranslation=translation.detach().float().cpu().tolist(),
                pairwisePoseMaxError=error,
                anchoredMeanDisplacement=(anchored-source_kp).detach().float().norm(dim=-1).mean().item())
            result = anchored
        telemetry.append(observation)
        return result
    wrapper.stitching = observe_stitch
    model.execute(args)
    if len(saved) != 60 or len(telemetry) != 60:
        raise ValueError('Expected 60 lossless model frames and stitching observations')
    report = {'model': 'LivePortrait Animals v1.1', 'sourceSha256': sha(source),
        'annotationSha256': sha(annotation), 'driverSha256': sha(driver), 'runnerSha256': sha(Path(__file__)),
        'encoderSha256': sha(Path(encoder)), 'frames': saved, 'fps': 20, 'seconds': time.perf_counter()-started,
        'degrees': a.degrees, 'axis': a.axis, 'approved': False, 'installed': False, 'remoteNetworkUsed': False,
        'envelope':envelope,
        'latentMotionTelemetry': telemetry, 'telemetryChangesNetworkOutput': a.pose_anchor != 'driving',
        'poseAnchor': a.pose_anchor,
        'modelMotionPlanSha256': sha(output/'model-motion-plan.json') if contract is not None else None,
        'modelMotionPlanValidatorSha256': sha(ROOT/'tools/model_head_plan.py') if contract is not None else None,
        'sourceRgbaSha256': contract['sourceRgbaSha256'] if contract is not None else None,
        'promptInterpretation': 'explicit-parameters-only' if contract is not None else 'legacy-axis-cli',
        'landmarkRoute': 'manual-nine-point', 'xposeUsed': False,
        'limitations': 'Raw RGB model experiment; transparent synthesis and naturalness not approved'}
    (output / 'driver-report.json').write_text(json.dumps(report, indent=2))
    print(json.dumps({'frames': len(saved), 'degrees': a.degrees, 'approved': False}))


if __name__ == '__main__':
    main()
