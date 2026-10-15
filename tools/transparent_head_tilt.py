"""Reusable, local 2D head-tilt renderer for an RGBA pet and reviewed face points.

This preserves the input's identity pixels and its existing defects. It neither
completes hidden anatomy nor approves a candidate. Prompt prose is retained as
provenance; only the explicit, bounded motion parameters drive this renderer.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import math
from pathlib import Path
import cv2
import numpy as np
from PIL import Image, ImageDraw


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def smooth(a, b, x):
    t = np.clip((x-a)/(b-a), 0, 1)
    return t*t*(3-2*t)


def validate_plan(plan):
    required = {'version', 'action', 'prompt', 'degrees', 'durationSeconds', 'direction',
                'facePointsNormalized', 'facePointsConfirmed', 'sourceSha256', 'inferredParts'}
    if not isinstance(plan, dict) or set(plan) != required or type(plan['version']) is not int or plan['version'] != 1 or plan['action'] != 'head-tilt':
        raise ValueError('Unsupported head-tilt plan')
    for key, low, high in [('degrees', 2, 10), ('durationSeconds', 1.5, 5)]:
        if type(plan[key]) not in (int, float) or not math.isfinite(plan[key]) or not low <= plan[key] <= high:
            raise ValueError(f'{key} outside renderer bounds')
    if plan['direction'] not in ('left', 'right') or plan['facePointsConfirmed'] is not True:
        raise ValueError('Direction and reviewed face points required')
    if not isinstance(plan['prompt'], str) or not 1 <= len(plan['prompt']) <= 1200:
        raise ValueError('Prompt must contain 1–1200 characters')
    if not isinstance(plan['inferredParts'], str) or len(plan['inferredParts']) > 500:
        raise ValueError('Explicit inferred-parts description required')
    points = plan['facePointsNormalized']
    if not isinstance(points, list) or len(points) != 9:
        raise ValueError('Nine reviewed face points required')
    if any(not isinstance(p, list) or len(p) != 2 or
           any(type(v) not in (float, int) or not math.isfinite(v) or not 0 < v < 1 for v in p) for p in points):
        raise ValueError('Invalid normalized face points')
    return plan


def geometry(base, points):
    height, width = base.shape[:2]
    pts = np.asarray(points, np.float32)*np.array([width, height], np.float32)
    left, right = pts[:2].mean(axis=0), pts[2:4].mean(axis=0)
    span = float(np.linalg.norm(right-left))
    if right[0]-left[0] < 12 or span > width*.4:
        raise ValueError('Eye span is too small, reversed or inconsistent')
    eye = (left+right)/2
    if not eye[1] < pts[4,1] < pts[8,1] or pts[8,1]-eye[1] > span*2.8:
        raise ValueError('Face point vertical ordering is inconsistent')
    pivot = np.array([eye[0], max(eye[1]+span, pts[8,1]+span*.18)], np.float32)
    yy,xx = np.mgrid[:height,:width].astype(np.float32)
    # Derived face area is an editable-annotation heuristic, not anatomy detection.
    blend = (smooth(eye[0]-2.1*span, eye[0]-1.55*span, xx) *
             (1-smooth(eye[0]+1.55*span, eye[0]+2.1*span, xx)) *
             smooth(eye[1]-2.6*span, eye[1]-2.25*span, yy) *
             (1-smooth(pivot[1], pivot[1]+span*.95, yy)))
    return np.stack((xx,yy),axis=2), blend, pivot, span


def render(base, grid, blend, pivot, degrees):
    if abs(degrees) < 1e-7:
        return base.copy(), 1.0
    angle = -math.radians(degrees)
    matrix = np.array([[math.cos(angle),-math.sin(angle)], [math.sin(angle),math.cos(angle)]], np.float32)
    source = (grid-pivot)@matrix.T+pivot
    mapped = np.asarray(grid+(source-grid)*blend[:,:,None], dtype=np.float32)
    dyx,dxx=np.gradient(mapped[:,:,0]);dyy,dxy=np.gradient(mapped[:,:,1])
    jacobian=dxx*dyy-dyx*dxy
    alpha=base[:,:,3:4].astype(np.float32)/255
    premul=np.concatenate((base[:,:,:3].astype(np.float32)*alpha,base[:,:,3:4].astype(np.float32)),axis=2)
    warped=cv2.remap(premul,mapped[:,:,0],mapped[:,:,1],cv2.INTER_LINEAR,borderMode=cv2.BORDER_CONSTANT,borderValue=0)
    opacity=np.clip(warped[:,:,3],0,255);visible=opacity>=1
    result=np.zeros(base.shape,np.uint8);result[:,:,3]=np.rint(opacity).astype(np.uint8)
    result[visible,:3]=np.rint(np.clip(warped[visible,:3]*255/opacity[visible,None],0,255)).astype(np.uint8)
    # Preserve stationary pixels exactly, including their alpha, without resampling.
    result[blend==0]=base[blend==0]
    foreground = result[:,:,3]>=128
    minimum=float(jacobian[foreground].min())
    if minimum <= .15:
        raise ValueError('Head/neck deformation folds or compresses excessively')
    if any(np.any(edge>=8) for edge in (result[0,:,3],result[-1,:,3],result[:,0,3],result[:,-1,3])):
        raise ValueError('Candidate reaches canvas edge; wider source framing required')
    return result,minimum


def generate(source, plan, output):
    plan=validate_plan(plan)
    if sha(source)!=plan['sourceSha256']:
        raise ValueError('Source fingerprint differs from the reviewed plan')
    with Image.open(source) as im:
        if im.mode!='RGBA' or max(im.size)>1600 or min(im.size)<64:
            raise ValueError('Expected 64–1600 pixel RGBA source')
        base=np.asarray(im).copy()
    if base[:,:,3].min()!=0 or not np.any(base[:,:,3]>=128):
        raise ValueError('Source lacks transparent background or visible subject')
    grid,blend,pivot,span=geometry(base,plan['facePointsNormalized'])
    output=Path(output);output.mkdir(parents=True,exist_ok=False)
    frames=output/'hover';frames.mkdir()
    fps=20;count=round(plan['durationSeconds']*fps)
    entries=[];minimum=1.;direction=-1 if plan['direction']=='left' else 1
    video=cv2.VideoWriter(str(output/'hover-190px.mp4'),cv2.VideoWriter_fourcc(*'mp4v'),fps,(570,254))
    if not video.isOpened():raise RuntimeError('Review video encoder unavailable')
    phases=[]
    try:
        for i in range(count):
            phase=i/(count-1)
            degrees=plan['degrees']*direction*math.sin(math.pi*phase)**2
            frame,jac=render(base,grid,blend,pivot,degrees);minimum=min(minimum,jac)
            file=frames/f'frame-{i:03}.png';Image.fromarray(frame).save(file)
            entries.append({'file':file.name,'sha256':sha(file),'degrees':degrees})
            thumb=Image.fromarray(frame);thumb.thumbnail((190,254),Image.Resampling.LANCZOS)
            strip=Image.new('RGB',(570,254))
            for n,color in enumerate(('#f4eee0','#b9d7ee','#252930')):
                panel=Image.new('RGBA',(190,254),color);panel.alpha_composite(thumb,((190-thumb.width)//2,(254-thumb.height)//2));strip.paste(panel.convert('RGB'),(n*190,0))
            video.write(cv2.cvtColor(np.asarray(strip),cv2.COLOR_RGB2BGR))
            if i in (0,count//4,count//2,3*count//4,count-1):phases.append((i,strip))
    finally:video.release()
    if entries[0]['sha256']!=entries[-1]['sha256']:raise AssertionError('Loop endpoints differ')
    idle=output/'idle';idle.mkdir();Image.fromarray(base).save(idle/'frame-000.png')
    sheet=Image.new('RGB',(570,279*len(phases)),'white');d=ImageDraw.Draw(sheet)
    for n,(i,strip) in enumerate(phases):d.text((5,n*279+5),f'frame {i} / {count}',fill='black');sheet.paste(strip,(0,n*279+25))
    sheet.save(output/'phases.png')
    spec={'name':'UNAPPROVED transparent head tilt','actions':[{'slot':'idle','directory':'idle','fps':1,'loop':True},{'slot':'hover','directory':'hover','fps':fps,'loop':False}]}
    report={'status':'candidate-requires-human-review','approved':False,'installable':False,'sourceSha256':sha(source),'scriptSha256':sha(__file__),'plan':plan,
            'promptExecution':'Only explicit degree/duration/direction parameters executed; prose not interpreted by renderer.',
            'method':'premultiplied 2D head rotation with derived neck blend; no new anatomy',
            'pivotPixels':pivot.tolist(),'eyeSpanPixels':span,'minimumForegroundJacobian':minimum,
            'firstLastEqual':True,'stationaryPixelsPreserved':True,'fps':fps,'frames':entries}
    for name,value in [('report.json',report),('spec.json',spec)]:
        (output/name).write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    return report


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--source',type=Path,required=True);p.add_argument('--plan',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    a=p.parse_args();r=generate(a.source,json.loads(a.plan.read_text(encoding='utf-8')),a.output)
    print(json.dumps({'output':str(a.output),'frames':len(r['frames']),'approved':False}))


if __name__=='__main__':main()
