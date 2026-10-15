"""Review-only closed-form matting from a same-photo segmentation seed.

The trimap is a heuristic, not identity/anatomy evidence. Opaque interior RGB is
preserved exactly. This never approves, installs or clears a candidate veto.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import time
import cv2
import numpy as np
from PIL import Image

def refine(photo,seed,inner=5,outer=5):
    if photo.size!=seed.size:raise ValueError('Photo and mask must share the exact canvas')
    if max(photo.size)>1600 or min(photo.size)<32:raise ValueError('Review route supports 32–1600 pixel sides')
    if type(inner) is not int or type(outer) is not int or not 1<=inner<=20 or not 1<=outer<=20:raise ValueError('Trimap widths must be 1–20 pixels')
    rgb=np.asarray(photo.convert('RGB'))
    alpha=np.asarray(seed.convert('RGBA'))[:,:,3]
    count,labels,stats,_=cv2.connectedComponentsWithStats((alpha>=128).astype(np.uint8),8)
    if count<2:raise ValueError('No foreground in seed')
    component=1+int(np.argmax(stats[1:,cv2.CC_STAT_AREA]))
    body=(labels==component).astype(np.uint8)
    inside=cv2.erode(body,np.ones((inner*2+1,inner*2+1),np.uint8)).astype(bool)
    outside=~cv2.dilate(body,np.ones((outer*2+1,outer*2+1),np.uint8)).astype(bool)
    if inside.sum()<100 or outside.sum()<100:raise ValueError('Insufficient known foreground/background')
    trimap=np.full(body.shape,.5,np.float64);trimap[inside]=1;trimap[outside]=0
    from pymatting import estimate_alpha_cf,estimate_foreground_ml
    started=time.monotonic()
    estimated=estimate_alpha_cf(rgb.astype(np.float64)/255,trimap,
                               laplacian_kwargs={'epsilon':1e-7},cg_kwargs={'maxiter':2000})
    foreground=estimate_foreground_ml(rgb.astype(np.float64)/255,estimated)
    output=np.zeros((*alpha.shape,4),np.uint8)
    output[:,:,:3]=np.rint(np.clip(foreground,0,1)*255).astype(np.uint8)
    output[:,:,3]=np.rint(np.clip(estimated,0,1)*255).astype(np.uint8)
    output[inside,:3]=rgb[inside]
    output[inside,3]=255
    output[outside]=0
    output[output[:,:,3]==0,:3]=0
    metrics={'method':'closed-form-alpha-and-multilevel-foreground','library':'pymatting','libraryVersion':'1.1.16',
             'trimap':'largest-seed-component; eroded-foreground; dilated-background; uncertain-boundary',
             'innerPixels':inner,'outerPixels':outer,'discardedSeedComponents':count-2,
             'foregroundInteriorPixels':int(inside.sum()),'unknownPixels':int((trimap==.5).sum()),
             'interiorRgbExactlyPreserved':bool(np.array_equal(output[inside,:3],rgb[inside])),
             'seconds':round(time.monotonic()-started,3),'approved':False,'installable':False,
             'limitations':['Trimap can omit fine fur or include background','No identity or anatomy inference','Hidden parts are not completed']}
    return Image.fromarray(output),Image.fromarray(np.rint(trimap*255).astype(np.uint8)),metrics


def main():
    p=argparse.ArgumentParser();p.add_argument('--photo',type=Path,required=True);p.add_argument('--seed',type=Path,required=True)
    p.add_argument('--output',type=Path,required=True);p.add_argument('--inner',type=int,default=2);p.add_argument('--outer',type=int,default=10)
    p.add_argument('--max-side',type=int,default=1200,choices=(768,1024,1200,1600));a=p.parse_args()
    out=a.output.resolve();out.mkdir(parents=True,exist_ok=False)
    photo=Image.open(a.photo).convert('RGB');seed=Image.open(a.seed).convert('RGBA')
    if photo.size!=seed.size:raise ValueError('Photo and seed canvas mismatch')
    original_size=photo.size
    if max(photo.size)>a.max_side:
        ratio=a.max_side/max(photo.size);size=tuple(max(1,round(d*ratio)) for d in photo.size)
        photo=photo.resize(size,Image.Resampling.LANCZOS);seed=seed.resize(size,Image.Resampling.LANCZOS)
    result,trimap,report=refine(photo,seed,a.inner,a.outer)
    report.update(inputDimensions=list(original_size),processingDimensions=list(photo.size),resized=original_size!=photo.size,
                  interiorPreservationScope='exact input RGB at processing resolution; any resizing is explicitly recorded')
    result.save(out/'foreground.png');trimap.save(out/'trimap.png')
    from run_birefnet import render_preview
    render_preview(photo,result,1024,out)
    report.update(photo=str(a.photo.resolve()),photoSha256=hashlib.sha256(a.photo.read_bytes()).hexdigest(),seed=str(a.seed.resolve()),seedSha256=hashlib.sha256(a.seed.read_bytes()).hexdigest(),outputSha256=hashlib.sha256((out/'foreground.png').read_bytes()).hexdigest())
    (out/'report.json').write_text(json.dumps(report,indent=2),encoding='utf-8');print(json.dumps(report))


if __name__=='__main__':main()
