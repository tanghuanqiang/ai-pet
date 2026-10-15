"""Explicit model pose contract; prompt text is provenance, never an NLP parser."""
import hashlib
import json
import math
import re
from pathlib import Path


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def validate_plan(plan):
    keys = {'version', 'action', 'axis', 'signedPeakDegrees', 'durationSeconds',
            'fps', 'envelope', 'prompt', 'promptInterpretation', 'sourceRgbaSha256',
            'modelSourceSha256', 'annotationSha256', 'facePointsNormalized',
            'facePointsConfirmed', 'inferredParts', 'poseAnchor'}
    if not isinstance(plan, dict) or set(plan) != keys:
        raise ValueError('Model head plan fields mismatch')
    if type(plan['version']) is not int or plan['version'] != 1 or plan['action'] != 'model-head-pose':
        raise ValueError('Unsupported model head plan')
    if plan['axis'] not in ('roll', 'yaw', 'pitch'):
        raise ValueError('Unsupported model axis')
    if plan['poseAnchor'] != 'driving':
        raise ValueError('Model contract currently implements the driving pose anchor only')
    degrees = plan['signedPeakDegrees']
    if type(degrees) not in (int, float) or not math.isfinite(degrees) or not 2 <= abs(degrees) <= 12:
        raise ValueError('Signed model angle must be 2–12 degrees')
    if type(plan['fps']) is not int or plan['fps'] != 20 or type(plan['durationSeconds']) not in (int,float) or plan['durationSeconds'] != 3:
        raise ValueError('Only 60-frame, 20fps, three-second model motion is implemented')
    if plan['envelope'] not in ('sin2-return','quick-look-return') or plan['promptInterpretation'] != 'explicit-parameters-only':
        raise ValueError('Unsupported envelope or prompt interpretation')
    for key in ('sourceRgbaSha256', 'modelSourceSha256', 'annotationSha256'):
        if not isinstance(plan[key], str) or not re.fullmatch(r'[0-9a-f]{64}', plan[key]):
            raise ValueError('Invalid source fingerprint')
    if not isinstance(plan['prompt'], str) or not 1 <= len(plan['prompt']) <= 1200:
        raise ValueError('Prompt provenance required')
    if not isinstance(plan['inferredParts'], str) or not 1 <= len(plan['inferredParts']) <= 500:
        raise ValueError('Inferred anatomy disclosure required')
    points = plan['facePointsNormalized']
    if plan['facePointsConfirmed'] is not True or not isinstance(points, list) or len(points) != 9:
        raise ValueError('Nine confirmed face points required')
    if any(not isinstance(p, list) or len(p) != 2 or any(type(v) not in (int,float) or not math.isfinite(v) or not 0 < v < 1 for v in p) for p in points):
        raise ValueError('Invalid face coordinates')
    return plan


def pose_weights(envelope):
    """60 sample weights; quick look uses seconds at the declared 20fps."""
    if envelope == 'sin2-return':
        return [math.sin(math.pi*i/59)**2 if i not in (0,59) else 0 for i in range(60)]
    if envelope != 'quick-look-return':
        raise ValueError('Unsupported model pose envelope')
    def ease(x):
        x=max(0,min(1,x))
        return x*x*x*(10+x*(-15+6*x))
    weights=[]
    for i in range(60):
        seconds=i/20
        if seconds < .45: weight=ease(seconds/.45)
        elif seconds <= .85: weight=1
        elif seconds < 1.65: weight=1-ease((seconds-.85)/.8)
        else: weight=0
        weights.append(weight)
    return weights


def bind_inputs(plan, rgba_source, model_source, annotation_path):
    validate_plan(plan)
    for key, path in [('sourceRgbaSha256', rgba_source), ('modelSourceSha256', model_source),
                      ('annotationSha256', annotation_path)]:
        if sha(path) != plan[key]:
            raise ValueError('Model head plan input fingerprint mismatch: '+key)
    annotation = json.loads(Path(annotation_path).read_text(encoding='utf-8'))
    if annotation['sourceSha256'] != plan['modelSourceSha256'] or annotation['pointsNormalized'] != plan['facePointsNormalized']:
        raise ValueError('Model head plan annotation mismatch')
    from PIL import Image, ImageChops
    with Image.open(rgba_source) as im:
        if im.mode != 'RGBA':
            raise ValueError('Transparent source must be RGBA')
        rgba = im.copy()
    if rgba.getchannel('A').getextrema() != (0,255):
        raise ValueError('Source requires transparent background and opaque subject')
    gray = Image.new('RGBA', rgba.size, '#808080')
    gray.alpha_composite(rgba)
    with Image.open(model_source) as im:
        rgb = im.convert('RGB')
    if rgb.size != rgba.size or annotation['imageSize'] != list(rgba.size):
        raise ValueError('Model source/annotation size mismatch')
    if ImageChops.difference(gray.convert('RGB'), rgb).getbbox() is not None:
        raise ValueError('Model source is not the exact gray composite of the RGBA source')
    return plan
