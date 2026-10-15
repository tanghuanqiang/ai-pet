"""Review-only removal of tiny detached upper-contour residuals absent from model matte.

Never alters the main alpha component or infers anatomy. A model may omit fur;
the result still requires comparison and normal-speed visual approval.
"""
import argparse,json
from pathlib import Path
from types import SimpleNamespace
import cv2,numpy as np
from PIL import Image
from scipy.ndimage import label,distance_transform_edt
from transparent_head_tilt import geometry,sha
from model_head_plan import bind_inputs,pose_weights
from theme_package import pack_multi

def remove_unsupported_components(original,model_alpha,upper):
    """Retain connected fur and any isolated feature supported by model or outside upper band."""
    result=original.copy();labs,n=label(original[:,:,3]>0,np.ones((3,3)))
    sizes=np.bincount(labs.ravel());sizes[0]=0;main=int(sizes.argmax())
    distance=distance_transform_edt(model_alpha<8);records=[]
    for ident in range(1,n+1):
        if ident==main:continue
        mask=labs==ident;alpha=original[:,:,3][mask]
        if sizes[ident]>16 or alpha.max()>16 or not np.all(upper[mask]>0):continue
        if np.any(model_alpha[mask]>0) or distance[mask].min()<3:continue
        ys,xs=np.where(mask)
        records.append({'pixels':int(sizes[ident]),'maxAlpha':int(alpha.max()),
            'bounds':[int(xs.min()),int(ys.min()),int(xs.max()+1),int(ys.max()+1)],
            'modelAlphaMax':0,'minimumModelSupportDistancePx':float(distance[mask].min())})
        result[mask]=0
    assert np.array_equal(result[labs==main],original[labs==main])
    assert np.array_equal(result[upper==0],original[upper==0])
    return result,records

def read(p):return json.loads(p.read_text(encoding='utf-8'))
def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--candidate',type=Path,required=True)
    p.add_argument('--output',type=Path,required=True);p.add_argument('--ffmpeg',type=Path,required=True)
    p.add_argument('--no-review-video',action='store_true',help='Creator encodes final review assets once');a=p.parse_args()
    c=a.candidate.resolve();w=c/'model-workflow';r=read(c/'motion/report.json')
    source=w/'inputs/source.png';planfile=w/'inputs/plan.json'
    plan=bind_inputs(read(planfile),source,w/'inputs/model-source.png',w/'inputs/annotation.json')
    d=read(w/'driver/driver-report.json');m=read(w/'matte/metrics.json')
    if r.get('motionKind')!='model-head' or not r.get('qualityRefinement'):raise ValueError('Expected refined genuine model head candidate')
    if r['packageSha256']!=sha(c/'motion/candidate.lotheme') or r['driverReportSha256']!=sha(w/'driver/driver-report.json') or m['driverReportSha256']!=r['driverReportSha256'] or r['motionPlanSha256']!=sha(planfile):raise ValueError('Candidate/model fingerprints mismatch')
    if r['matteMetricsSha256']!=sha(w/'matte/metrics.json'):raise ValueError('Matte metrics mismatch')
    if list(r['actions'])!=['idle','hover'] or any(len(r['actions'][slot]['frames'])!=count for slot,count in [('idle',2),('hover',60)]):raise ValueError('Expected fixed 62-frame contract')
    if len(d['frames'])!=60 or len(m['frames'])!=60:raise ValueError('Expected 60 genuine model/matte frames')
    # Validate all original and matte bytes before creating output.
    for slot,action in r['actions'].items():
        if action['fps']!=20 or action['loop']!=(slot=='idle'):raise ValueError('Unexpected action playback contract')
        for i,f in enumerate(action['frames']):
            if f['file']!=f'frame-{i:03d}.png':raise ValueError('Noncanonical motion filename')
            if sha(c/'motion'/slot/f['file'])!=f['sha256']:raise ValueError('Motion frame mismatch')
    for i,f in enumerate(d['frames']):
        if sha(w/'driver/lossless'/f['file'])!=f['sha256'] or sha(w/f'matte/rgba-frames/{i+1:06d}.png')!=m['frames'][i]['rgbaSha256']:raise ValueError('Model/matte frame mismatch')
    base=np.asarray(Image.open(source).convert('RGBA'));grid,blend,_,_=geometry(base,plan['facePointsNormalized'])
    modelsource=np.asarray(Image.open(w/'inputs/model-source.png').convert('RGB'))
    first=np.asarray(Image.open(w/'driver/lossless'/d['frames'][0]['file']).convert('RGB'))
    flow=cv2.calcOpticalFlowFarneback(cv2.cvtColor(modelsource,cv2.COLOR_RGB2GRAY),cv2.cvtColor(first,cv2.COLOR_RGB2GRAY),None,.5,4,25,5,7,1.5,0)
    if not np.isfinite(flow).all() or np.linalg.norm(flow[blend>.5],axis=1).max()>20:raise ValueError('Baseline correspondence outside limit')
    eye_y=min(y for x,y in plan['facePointsNormalized'][:4])*base.shape[0]
    upper=np.clip((eye_y-3-np.arange(base.shape[0])[:,None])/4,0,1)*blend
    weights=pose_weights(plan['envelope']);out=a.output.resolve();out.mkdir(parents=True,exist_ok=False)
    actions={};records=[]
    for slot,action in r['actions'].items():
        (out/slot).mkdir();frames=[]
        for i,f in enumerate(action['frames']):
            original=np.asarray(Image.open(c/'motion'/slot/f['file']).convert('RGBA'));result=original.copy();removed=[]
            if slot=='hover' and weights[i]>0:
                model_alpha=np.asarray(Image.open(w/f'matte/rgba-frames/{i+1:06d}.png').convert('RGBA'))[:,:,3]
                model_alpha=cv2.remap(model_alpha,grid[:,:,0]+flow[:,:,0],grid[:,:,1]+flow[:,:,1],cv2.INTER_LINEAR,borderMode=cv2.BORDER_CONSTANT,borderValue=0)
                result,removed=remove_unsupported_components(original,model_alpha,upper)
            else:assert np.array_equal(result,original)
            target=out/slot/f['file'];Image.fromarray(result).save(target)
            frames.append({'file':target.name,'sha256':sha(target),'inputSha256':f['sha256']})
            records.append({'slot':slot,'frame':i,'removedComponents':removed,'removedPixels':sum(x['pixels'] for x in removed)})
        actions[slot]={'fps':action['fps'],'loop':action['loop'],'frames':frames}
    spec={'name':'待审模型上耳孤立碎片修整（后身尾巴推断）','actions':[{'slot':slot,'directory':slot,'fps':v['fps'],'loop':v['loop']} for slot,v in actions.items()]}
    (out/'spec.json').write_text(json.dumps(spec,ensure_ascii=False,indent=2),encoding='utf-8')
    pack_multi(SimpleNamespace(spec=out/'spec.json',output=out/'candidate.lotheme'))
    report={'approved':False,'installed':False,'installable':False,'route':'model-detached-fringe-v1',
        'inputReportSha256':sha(c/'motion/report.json'),'inputPackageSha256':sha(c/'motion/candidate.lotheme'),
        'scriptSha256':sha(Path(__file__)),'driverReportSha256':sha(w/'driver/driver-report.json'),
        'matteMetricsSha256':sha(w/'matte/metrics.json'),'planSha256':sha(planfile),'sourceSha256':sha(source),
        'actions':actions,'frames':records,'packageSha256':sha(out/'candidate.lotheme'),
        'policy':{'alphaMax':16,'componentPixelsMax':16,'modelAlphaMax':0,'minimumModelSupportDistancePx':3,
            'earRegionEndsBeforeEyeY':eye_y-3,'mainAlphaComponentPreserved':True,'zeroPosePreserved':True},
        'limitations':['Model may omit legitimate isolated fine fur; comparison remains mandatory',
            'No connected-contour repair, naturalness or installation approval']}
    if not a.no_review_video:
        from review_video import encode_review_assets
        report['reviewEncoding']=encode_review_assets(out,actions,a.ffmpeg.resolve())
    (out/'report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps({'frames':len(records),'changedFrames':sum(bool(x['removedPixels']) for x in records),'removedPixels':sum(x['removedPixels'] for x in records),'approved':False}))

if __name__=='__main__':main()
