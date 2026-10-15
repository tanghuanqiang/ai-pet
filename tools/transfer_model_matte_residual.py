"""Review-only temporal premultiplied RGBA residual from a model dynamic matte.

This does not warp the whole source anchor. The optional advected correction
does spatially remap the source-minus-model baseline plane. Neither branch can
certify anatomy, naturalness, identity, or approve a failed dense-warp route.
"""
import argparse
import json
import math
from pathlib import Path
from types import SimpleNamespace
import cv2
import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter, distance_transform_edt, label
from transparent_head_tilt import geometry, sha, validate_plan
from theme_package import pack_multi

p = argparse.ArgumentParser(description=__doc__)
for name in ('source', 'plan', 'driver', 'model-source', 'annotation', 'matte', 'output'):
    p.add_argument('--'+name, type=Path, required=True)
p.add_argument('--baseline-correction', choices=('fixed','advected'), default='fixed')
p.add_argument('--contour-filter', choices=('none','premul-band'), default='none')
a = p.parse_args()
from model_head_plan import pose_weights
plan = json.loads(a.plan.read_text(encoding='utf-8'))
model_contract = plan.get('action') == 'model-head-pose'
if model_contract:
    from model_head_plan import bind_inputs
    plan = bind_inputs(plan, a.source, a.model_source, a.annotation)
    source_hash = plan['sourceRgbaSha256']
else:
    plan = validate_plan(plan)
    source_hash = plan['sourceSha256']
base = np.asarray(Image.open(a.source).convert('RGBA')).copy()
base[base[:, :, 3] == 0, :3] = 0
driver = json.loads((a.driver/'driver-report.json').read_text())
annotation = json.loads(a.annotation.read_text(encoding='utf-8'))
if (sha(a.source) != source_hash or sha(a.model_source) != driver['sourceSha256'] or
    sha(a.annotation) != driver['annotationSha256'] or annotation['pointsNormalized'] != plan['facePointsNormalized']):
    raise ValueError('Source, model, annotation or plan provenance mismatch')
if model_contract:
    if (driver.get('modelMotionPlanSha256') != sha(a.plan) or
        sha(a.driver/'model-motion-plan.json') != sha(a.plan) or
        driver.get('sourceRgbaSha256') != source_hash or driver.get('axis') != plan['axis'] or
        driver.get('degrees') != plan['signedPeakDegrees'] or driver.get('fps') != plan['fps'] or
        driver.get('poseAnchor') != plan['poseAnchor'] or
        driver.get('promptInterpretation') != plan['promptInterpretation']):
        raise ValueError('Model driver does not execute the specified pose contract')
    expected_angles = [plan['signedPeakDegrees']*w for w in pose_weights(plan['envelope'])]
    actual_plan = json.loads((a.driver/'driver-plan.json').read_text())
    if actual_plan.get('axis') != plan['axis'] or actual_plan.get('fps') != 20 or actual_plan.get('anglesDegrees') != expected_angles:
        raise ValueError('Model driver angle sequence differs from pose contract')
    if sha(a.driver/('bounded-'+plan['axis']+'.pkl')) != driver['driverSha256']:
        raise ValueError('Model driver template fingerprint mismatch')
pulse_weights = pose_weights(plan['envelope'] if model_contract else 'sin2-return')
gray = Image.new('RGBA', (base.shape[1], base.shape[0]), '#808080')
gray.alpha_composite(Image.fromarray(base)); gray_pixels = np.asarray(gray.convert('RGB'))
if not np.array_equal(gray_pixels, np.asarray(Image.open(a.model_source).convert('RGB'))):
    raise ValueError('Model source differs from RGBA anchor composited on gray')
metrics = json.loads((a.matte/'metrics.json').read_text())
if metrics['sourceFrameCount'] != 60 or metrics['reviewPlaybackFps'] != 20 or len(driver['frames']) != 60:
    raise ValueError('Expected actual 60-frame, 20fps model and matte')
if metrics.get('driverReportSha256') != sha(a.driver/'driver-report.json') or len(metrics.get('frames', [])) != 60:
    raise ValueError('Matte provenance does not refer to the specified model driver')
raws = []; mattes = []; provenance = []
for i, record in enumerate(driver['frames']):
    raw_path = a.driver/'lossless'/record['file']
    matte_path = a.matte/'rgba-frames'/f'{i+1:06d}.png'
    if metrics['frames'][i].get('frame') != i or metrics['frames'][i].get('rgbaSha256') != sha(matte_path):
        raise ValueError('Matte frame fingerprint/index mismatch')
    if sha(raw_path) != record['sha256']:
        raise ValueError('Model frame fingerprint mismatch')
    raw = np.asarray(Image.open(raw_path).convert('RGB'))
    rgba = np.asarray(Image.open(matte_path).convert('RGBA'))
    if rgba.shape != base.shape or raw.shape != base[:, :, :3].shape:
        raise ValueError('Model/matte canvas mismatch')
    visible = rgba[:, :, 3] > 0
    if not visible.any() or rgba[:, :, 3].min() != 0:
        raise ValueError('Matte lacks a transparent background or visible subject')
    if not np.array_equal(rgba[:, :, :3][visible], raw[visible]):
        raise ValueError('Matte visible RGB does not match actual model frame')
    raws.append(raw); mattes.append(rgba[:, :, 3].astype(np.float32)/255)
    provenance.append({'driverSha256': record['sha256'], 'matteSha256': sha(matte_path)})
if not np.array_equal(raws[0], raws[-1]):
    raise ValueError('Model must genuinely return to its starting RGB pose')
grid, blend, _, _ = geometry(base, plan['facePointsNormalized'])
flow = cv2.calcOpticalFlowFarneback(cv2.cvtColor(gray_pixels, cv2.COLOR_RGB2GRAY),
    cv2.cvtColor(raws[0], cv2.COLOR_RGB2GRAY), None, .5, 4, 25, 5, 7, 1.5, 0)
max_alignment = float(np.linalg.norm(flow[blend > .5], axis=1).max())
if not np.isfinite(flow).all() or max_alignment > 20:
    raise ValueError('Fixed baseline correspondence exceeds 20px')
model_premul = []
for raw, alpha in zip(raws, mattes):
    # The RGB model is composited on known gray. Remove that contribution
    # before temporal RGBA subtraction; otherwise new edges acquire gray halos.
    premul = np.clip(raw.astype(np.float32)-128*(1-alpha[:, :, None]), 0, 255*alpha[:, :, None])
    data = np.concatenate((premul, alpha[:, :, None]), axis=2)
    model_premul.append(cv2.remap(data, grid[:, :, 0]+flow[:, :, 0], grid[:, :, 1]+flow[:, :, 1],
        cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0))
drift = model_premul[-1]-model_premul[0]
drift_pixels = int(np.count_nonzero((np.abs(drift[:, :, 3]) > .1) & (blend > 0)))
source_visible = int(np.count_nonzero((base[:, :, 3] >= 128) & (blend > 0)))
print(json.dumps({'alignmentMaxPx': max_alignment, 'endpointMatteDriftPixels': drift_pixels,
    'sourceVisibleHeadPixels': source_visible, 'allowedDriftPixels': .02*source_visible}), flush=True)
if drift_pixels > .02*source_visible:
    raise ValueError('Repeated identical pose has excessive matte drift; retained source needs resegmentation')
out = a.output.resolve(); out.mkdir(parents=True, exist_ok=False)
(out/'hover').mkdir(); (out/'idle').mkdir()
alpha = base[:, :, 3:4].astype(np.float32)/255
source_premul = np.concatenate((base[:, :, :3].astype(np.float32)*alpha, alpha), axis=2)
correction = source_premul-model_premul[0]
motion_flows = None; minimum_jacobian = 1; max_correction_travel = 0
if a.baseline_correction == 'advected':
    aligned_rgb = [cv2.remap(raw, grid[:, :, 0]+flow[:, :, 0], grid[:, :, 1]+flow[:, :, 1],
        cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE) for raw in raws]
    first_gray = cv2.cvtColor(aligned_rgb[0], cv2.COLOR_RGB2GRAY)
    motion_flows = np.stack([cv2.calcOpticalFlowFarneback(cv2.cvtColor(raw, cv2.COLOR_RGB2GRAY),
        first_gray, None, .5, 4, 25, 5, 7, 1.5, 0) for raw in aligned_rgb])
    spatial_flows = gaussian_filter(motion_flows, sigma=(0,8,8,0), mode='nearest')
    motion_flows = gaussian_filter(spatial_flows, sigma=(1,0,0,0), mode='nearest')
    # A genuine stationary model pose must not inherit neighbor motion merely
    # because it appears beside a transition in the temporal smoothing window.
    repeated_poses = {}
    for index, record in enumerate(driver['frames']):
        repeated_poses.setdefault(record['sha256'],[]).append(index)
    for indices in repeated_poses.values():
        if len(indices) > 1:
            motion_flows[indices] = spatial_flows[indices[0]]
    motion_flows[np.asarray(pulse_weights) == 0] = 0
    max_correction_travel = float(np.linalg.norm(motion_flows[:, blend > 0], axis=2).max())
    if not np.isfinite(motion_flows).all() or max_correction_travel > 12:
        raise ValueError('Correction transport exceeds bounded 12px displacement')
frames = []
for i, model in enumerate(model_premul):
    # Remove only endpoint segmentation drift, not a genuine pose change.
    delta = model-model_premul[0]-(i/59)*drift
    if motion_flows is None:
        data = source_premul+delta*blend[:, :, None]
    else:
        mapped = grid+motion_flows[i]
        dyx, dxx = np.gradient(mapped[:, :, 0]); dyy, dxy = np.gradient(mapped[:, :, 1])
        jacobian = dxx*dyy-dyx*dxy
        minimum_jacobian = min(minimum_jacobian, float(jacobian.min()))
        if jacobian.min() < .65:
            location = np.unravel_index(jacobian.argmin(), jacobian.shape)
            (out/'failure.json').write_text(json.dumps({'frame':i,'minimumJacobian':float(jacobian.min()),
                'minimumAtSourcePixel':[int(location[1]),int(location[0])], 'approved':False,
                'error':'Baseline correction transport folds or compresses excessively'},indent=2))
            raise ValueError('Baseline correction transport folds or compresses excessively')
        transported = cv2.remap(correction, mapped[:, :, 0], mapped[:, :, 1], cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_CONSTANT, borderValue=0)
        target = model-(i/59)*drift+transported
        data = source_premul+(target-source_premul)*blend[:, :, None]
    opacity = np.clip(data[:, :, 3:4], 0, 1)
    clipped = np.count_nonzero((data[:, :, :3] < 0) | (data[:, :, :3] > 255*opacity))
    contour_pixels = 0; detached_pixels = 0
    if a.contour_filter == 'premul-band' and pulse_weights[i] > 0:
        # Blur premultiplied color and alpha together only near the contour.
        # Opaque face texture, stationary body and endpoint anchor stay exact.
        valid = np.concatenate((np.clip(data[:,:,:3],0,255*opacity),opacity),axis=2)
        solid = opacity[:,:,0] >= .5
        edge = (distance_transform_edt(solid) <= 2) & (distance_transform_edt(~solid) <= 2)
        weight = edge.astype(np.float32)*blend*pulse_weights[i]
        smooth = gaussian_filter(valid,sigma=(.65,.65,0),mode='constant')
        filtered = valid+(smooth-valid)*weight[:,:,None]
        components,_ = label(filtered[:,:,3] >= 16/255, structure=np.ones((3,3),np.uint8))
        sizes = np.bincount(components.ravel())
        tiny = (components > 0) & (sizes[components] <= 8) & (blend > 0)
        filtered[tiny] *= 1-pulse_weights[i]
        contour_pixels = int(np.count_nonzero(weight))
        detached_pixels = int(np.count_nonzero(tiny))
        data = filtered
        opacity = np.clip(data[:,:,3:4],0,1)
    rgb = np.clip(data[:, :, :3], 0, 255*opacity)/np.maximum(opacity, 1e-7)
    frame = np.concatenate((np.rint(rgb).astype(np.uint8), np.rint(opacity*255).astype(np.uint8)), axis=2)
    frame[frame[:, :, 3] == 0, :3] = 0
    assert np.array_equal(frame[blend == 0], base[blend == 0])
    if i in (0,59): assert np.array_equal(frame, base)
    path = out/'hover'/f'frame-{i:03d}.png'; Image.fromarray(frame).save(path)
    frames.append({'file': path.name, 'sha256': sha(path), **provenance[i],
        'outsideHeadChangedPixels': 0, 'premulClippedChannels': int(clipped),
        'contourFilteredPixels':contour_pixels, 'attenuatedDetachedPixels':detached_pixels,
        'alphaChangedPixels': int(np.count_nonzero(frame[:, :, 3] != base[:, :, 3]))})
idle = []
for i in range(2):
    path = out/'idle'/f'frame-{i:03d}.png'; Image.fromarray(base).save(path)
    idle.append({'file': path.name, 'sha256': sha(path), 'outsideHeadChangedPixels': 0})
spec = {'name': '待审原猫模型matte残差（后身与尾巴推断）', 'actions': [
    {'slot':'idle','directory':'idle','fps':20,'loop':True},
    {'slot':'hover','directory':'hover','fps':20,'loop':False}]}
(out/'spec.json').write_text(json.dumps(spec, ensure_ascii=False, indent=2), encoding='utf-8')
package = out/'UNAPPROVED-model-matte.lotheme'
pack_multi(SimpleNamespace(spec=out/'spec.json', output=package))
report = {'approved': False, 'installed': False, 'installable': False,
    'method': ('Fixed gray-background registration and model-matte residual with '+a.baseline_correction+' baseline correction'),
    'notDenseAnchorDeformation': True, 'denseWarpRouteApproved': False,
    'sourceSha256': sha(a.source), 'modelSourceSha256': sha(a.model_source),
    'motionPlanSha256':sha(a.plan), 'modelMotionContractBound':model_contract,
    'motionEnvelope':plan['envelope'] if model_contract else 'sin2-return',
    'promptInterpretation':'explicit-parameters-only' if model_contract else 'legacy-plan-for-geometry-only',
    'annotationSha256': sha(a.annotation), 'driverReportSha256': sha(a.driver/'driver-report.json'),
    'matteMetricsSha256': sha(a.matte/'metrics.json'), 'matteScoresSha256': sha(a.matte/'scores.npz'),
    'scriptSha256': sha(Path(__file__)), 'modelAxis': driver['axis'], 'modelDegrees': driver['degrees'],
    'alignmentMaxPx': max_alignment, 'endpointMatteDriftPixels': drift_pixels,
    'baselineCorrection':a.baseline_correction, 'correctionTransportMinimumJacobian':minimum_jacobian,
    'contourFilter':a.contour_filter,
    'contourFilterParameters':{'sigmaPx':.65,'insideBandPx':2,'outsideBandPx':2,
        'maxDetachedComponentPixels':8,'connectivity':8,'temporalEnvelope':plan['envelope'] if model_contract else 'sin2-return'} if a.contour_filter != 'none' else None,
    'correctionTransportMaxTravelPx':max_correction_travel,
    'correctionFlowSmoothingSigma':{'temporal':1,'spatial':8} if motion_flows is not None else None,
    'identicalModelPosesUseSameCorrectionFlow':motion_flows is not None,
    'endpointDriftCorrection': 'Linear bias subtraction for identical RGB return pose only',
    'packageSha256': sha(package), 'actions': {
        'idle': {'fps':20,'loop':True,'frames':idle}, 'hover': {'fps':20,'loop':False,'frames':frames}},
    'limitations': ['SAM2 matte is not ground-truth alpha', 'Heuristic head support and residual may cause ghosting',
        'No identity, anatomy, edge, normal-speed or actual-window visual approval']}
(out/'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps({'frames':60,'endpointMatteDriftPixels':drift_pixels,'packageSha256':sha(package),'approved':False}))
