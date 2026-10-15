"""Transfer only local eye changes onto an unchanged RGBA identity anchor.

This is a review-only renderer. It does not complete hidden anatomy, infer a
successful blink from pixel statistics, approve, or install an animation.
"""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import math
import numpy as np
import cv2
from PIL import Image, ImageDraw
from transparent_head_tilt import sha, smooth, geometry, render, validate_plan


def eye_mask(base, points):
    h,w=base.shape[:2]; pts=np.asarray(points)*[w,h]
    yy,xx=np.mgrid[:h,:w].astype(np.float32); mask=np.zeros((h,w),np.float32)
    for pair in (pts[:2],pts[2:4]):
        c=pair.mean(axis=0); width=float(np.linalg.norm(pair[1]-pair[0]))
        if width < 6: raise ValueError('Eye width insufficient for local transfer')
        # Face-point heuristic, explicitly reviewable; not an eyelid detector.
        r=np.sqrt(((xx-c[0])/(width*.95))**2+((yy-c[1])/(width*.70))**2)
        mask=np.maximum(mask,1-smooth(.6,1.,r))
    # Matting may leave an internal eye at alpha 230--249. A hard >=250
    # cutoff makes a perforated eye mask and leaves fragments of the old pupil.
    # Smooth support keeps the source alpha unchanged and excludes transparency.
    return mask*smooth(128,224,base[:,:,3].astype(np.float32))


def transfer(base, first, frame, mask, strength=1):
    result=base.copy()
    delta=(frame.astype(np.float32)-first.astype(np.float32))*mask[:,:,None]*strength
    result[:,:,:3]=np.rint(np.clip(base[:,:,:3].astype(np.float32)+delta,0,255)).astype(np.uint8)
    result[base[:,:,3]==0,:3]=0
    return result


def align_baseline(base, drivers, mask):
    """Map source-eye locations into the model's first frame before taking delta.

    Flow is estimated once, never independently per frame. This avoids adding
    temporal jitter and retains the source body and alpha exactly. It cannot
    certify anatomy or recover details missing from the model output.
    """
    original = cv2.cvtColor(base[:,:,:3], cv2.COLOR_RGB2GRAY)
    baseline = cv2.cvtColor(drivers[0], cv2.COLOR_RGB2GRAY)
    flow = cv2.calcOpticalFlowFarneback(original, baseline, None,
        .5, 4, 25, 5, 7, 1.5, 0)
    motion = np.linalg.norm(flow[mask > .5], axis=1)
    if not np.isfinite(flow).all() or float(motion.max()) > 20:
        raise ValueError('Model baseline alignment exceeds bounded 20px displacement')
    yy, xx = np.mgrid[:base.shape[0], :base.shape[1]].astype(np.float32)
    aligned = [cv2.remap(frame, xx+flow[:,:,0], yy+flow[:,:,1],
        cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE) for frame in drivers]
    return aligned, {'method': 'one fixed source-to-model baseline optical flow',
        'eyeMaxDisplacementPx': float(motion.max()),
        'eyeMeanDisplacementPx': float(motion.mean()), 'visualApproval': False}


def generate(source, plan_path, driver_path, output, align=False, mode='delta'):
    plan=validate_plan(json.loads(plan_path.read_text(encoding='utf-8')))
    base=np.asarray(Image.open(source).convert('RGBA')).copy(); base[base[:,:,3]==0,:3]=0
    if sha(source)!=plan['sourceSha256']: raise ValueError('Source/plan fingerprint mismatch')
    paths=sorted((driver_path/'lossless').glob('frame-*.png'))
    drivers=[np.asarray(Image.open(p).convert('RGB')) for p in paths]
    if len(drivers)!=57 or any(x.shape!=base[:,:,:3].shape for x in drivers):
        raise ValueError('Lossless driver and RGBA anchor dimensions differ')
    mask=eye_mask(base,plan['facePointsNormalized'])
    alignment=None
    if align:
        drivers,alignment=align_baseline(base,drivers,mask)
    # A delta cannot erase source pupils when the synthesized baseline differs
    # in shape. Replacement is an explicit experimental route, not approval.
    ring=(mask>.02)&(mask<.3)
    color_offset=np.median((base[:,:,:3].astype(np.float32)-drivers[0])[ring],axis=0)
    output.mkdir(parents=True,exist_ok=False)
    Image.fromarray(np.rint(mask*255).astype(np.uint8)).save(output/'eye-region.png')
    grid,blend,pivot,span=geometry(base,plan['facePointsNormalized'])
    reports={}; spec={'name':'UNAPPROVED eye and head motion','actions':[]}
    for slot,count,fps in [('idle',120,20),('hover',round(plan['durationSeconds']*20),20),('click',60,20)]:
        folder=output/slot;folder.mkdir(); records=[];outside=0;alpha_changes=0
        for i in range(count):
            seconds=i/fps;phase=i/(count-1)
            # Idle: one wink with a rest before/after. Click: a responsive wink.
            driver_time=(seconds-(1.4 if slot=='idle' else .15))*25
            index=round(driver_time)
            frame=base.copy()
            if slot!='hover' and 0<=index<len(drivers):
                strength=min(1,index/5,(len(drivers)-1-index)/6)
                if mode=='replacement':
                    target=np.clip(drivers[index].astype(np.float32)+color_offset,0,255)
                    weight=mask[:,:,None]*strength
                    frame[:,:,:3]=np.rint(base[:,:,:3]*(1-weight)+target*weight).astype(np.uint8)
                else:
                    frame=transfer(base,drivers[0],drivers[index],mask,strength)
            if slot=='hover':
                direction=-1 if plan['direction']=='left' else 1
                frame,_=render(base,grid,blend,pivot,direction*plan['degrees']*math.sin(math.pi*phase)**2)
            else:
                outside+=int(np.any(frame[mask==0]!=base[mask==0],axis=1).sum())
                alpha_changes+=int(np.count_nonzero(frame[:,:,3]!=base[:,:,3]))
            path=folder/f'frame-{i:03}.png';Image.fromarray(frame).save(path)
            records.append({'file':path.name,'sha256':sha(path),'driverIndex':index if slot!='hover' else None})
        assert records[0]['sha256']==records[-1]['sha256']
        reports[slot]={'frames':records,'fps':fps,'outsideEyeChangedPixels':outside if slot!='hover' else None,
            'alphaChangedPixels':alpha_changes if slot!='hover' else None}
        spec['actions'].append({'slot':slot,'directory':slot,'fps':fps,'loop':slot=='idle'})
    assert reports['idle']['outsideEyeChangedPixels']==reports['click']['outsideEyeChangedPixels']==0
    assert reports['idle']['alphaChangedPixels']==reports['click']['alphaChangedPixels']==0
    report={'approved':False,'installable':False,'sourceSha256':sha(source),'plan':plan,
        'driverReportSha256':sha(driver_path/'driver-report.json'),'rendererSha256':sha(__file__),
        'baselineAlignment':alignment,
        'transferMode':mode, 'eyeRingColorOffset':color_offset.tolist(),
        'method':f'Local eye RGB {mode} from a lossless AI driver; unchanged source alpha/body; local 2D head tilt.',
        'limitations':'Eye masks are manual-point heuristics. Wink naturalness and identity require visual review.',
        'actions':reports}
    for name,data in [('report.json',report),('spec.json',spec)]:
        (output/name).write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')
    return report


def main():
    p=argparse.ArgumentParser(description=__doc__)
    for n in ('source','plan','driver','output'):p.add_argument('--'+n,type=Path,required=True)
    p.add_argument('--align-baseline', action='store_true')
    p.add_argument('--transfer-mode', choices=('delta','replacement'), default='delta')
    a=p.parse_args(); generate(a.source,a.plan,a.driver,a.output,a.align_baseline,a.transfer_mode)


if __name__=='__main__':main()
