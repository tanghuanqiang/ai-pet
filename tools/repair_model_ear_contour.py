"""Review-only actual model premultiplied contour substitution above the eyes.

Preserves face/body, motion flow and exact rest. Does not recover missing fur,
infer anatomy or approve naturalness. Existing Creator route remains unchanged.
"""
import argparse,json
from pathlib import Path
from types import SimpleNamespace
import cv2,numpy as np
from PIL import Image
from scipy.ndimage import distance_transform_edt,gaussian_filter
from transparent_head_tilt import geometry,sha
from model_head_plan import bind_inputs,pose_weights
from theme_package import pack_multi
p=argparse.ArgumentParser();p.add_argument('--candidate',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
c=a.candidate;workflow=c/'model-workflow';source=workflow/'inputs/source.png';planfile=workflow/'inputs/plan.json'
plan=bind_inputs(json.loads(planfile.read_text(encoding='utf-8')),source,workflow/'inputs/model-source.png',workflow/'inputs/annotation.json')
d=json.loads((workflow/'driver/driver-report.json').read_text(encoding='utf-8'))
m=json.loads((workflow/'matte/metrics.json').read_text(encoding='utf-8'))
r=json.loads((c/'motion/report.json').read_text(encoding='utf-8'))
if r['driverReportSha256']!=sha(workflow/'driver/driver-report.json') or m['driverReportSha256']!=r['driverReportSha256'] or r['motionPlanSha256']!=sha(planfile):raise ValueError('Candidate/model source mismatch')
base=np.asarray(Image.open(source).convert('RGBA')).copy();base[base[:,:,3]==0,:3]=0
grid,blend,_,_=geometry(base,plan['facePointsNormalized']);weights=pose_weights(plan['envelope'])
modelsource=np.asarray(Image.open(workflow/'inputs/model-source.png').convert('RGB'))
first=np.asarray(Image.open(workflow/'driver/lossless'/d['frames'][0]['file']).convert('RGB'))
flow=cv2.calcOpticalFlowFarneback(cv2.cvtColor(modelsource,cv2.COLOR_RGB2GRAY),cv2.cvtColor(first,cv2.COLOR_RGB2GRAY),None,.5,4,25,5,7,1.5,0)
if not np.isfinite(flow).all() or np.linalg.norm(flow[blend>.5],axis=1).max()>20:raise ValueError('Baseline correspondence outside existing limit')
eye_y=min(y for x,y in plan['facePointsNormalized'][:4])*base.shape[0]
y=np.arange(base.shape[0])[:,None]
# Fade ends before eye level; this never substitutes eye/nose/mouth texture.
upper=np.clip((eye_y-3-y)/4,0,1)*blend
out=a.output.resolve();out.mkdir(parents=True,exist_ok=False);(out/'idle').mkdir();(out/'hover').mkdir()
actions={};records=[]
for slot,action in r['actions'].items():
    frames=[]
    for index,f in enumerate(action['frames']):
        path=c/'motion'/slot/f['file']
        if sha(path)!=f['sha256']:raise ValueError('Input motion fingerprint mismatch')
        original=np.asarray(Image.open(path).convert('RGBA'));result=original.copy();changed=0
        if slot=='hover' and weights[index]>0:
            rawpath=workflow/'driver/lossless'/d['frames'][index]['file'];matpath=workflow/'matte/rgba-frames'/f'{index+1:06d}.png'
            if sha(rawpath)!=d['frames'][index]['sha256'] or sha(matpath)!=m['frames'][index]['rgbaSha256']:raise ValueError('Model/matte frame fingerprint mismatch')
            raw=np.asarray(Image.open(rawpath).convert('RGB'));mat=np.asarray(Image.open(matpath).convert('RGBA'))
            if not np.array_equal(raw[mat[:,:,3]>0],mat[:,:,:3][mat[:,:,3]>0]):raise ValueError('Matte color is not model RGB')
            alpha=mat[:,:,3:4].astype(np.float32)/255
            model=np.concatenate((np.clip(raw.astype(np.float32)-128*(1-alpha),0,255*alpha),alpha),axis=2)
            model=cv2.remap(model,grid[:,:,0]+flow[:,:,0],grid[:,:,1]+flow[:,:,1],cv2.INTER_LINEAR,borderMode=cv2.BORDER_CONSTANT,borderValue=0)
            solid=model[:,:,3]>=.5;inside=distance_transform_edt(solid);outside=distance_transform_edt(~solid)
            # All exterior pixels and the inner four-pixel band are eligible.
            # Interior texture beyond that band stays from the original route.
            band=np.clip((5-inside)/2,0,1)
            edge=(inside<=2)&(outside<=2)
            smooth=gaussian_filter(model,sigma=(.65,.65,0),mode='constant')
            model=model+(smooth-model)*edge[:,:,None]
            original_alpha=original[:,:,3:4].astype(np.float32)/255
            premul=np.concatenate((original[:,:,:3]*original_alpha,original_alpha),axis=2)
            mix=(band*upper*weights[index])[:,:,None]
            repaired=premul+(model-premul)*mix
            opacity=np.clip(repaired[:,:,3:4],0,1)
            color=np.clip(repaired[:,:,:3],0,255*opacity)/np.maximum(opacity,1e-7)
            result=np.concatenate((np.rint(color).astype(np.uint8),np.rint(opacity*255).astype(np.uint8)),axis=2)
            result[result[:,:,3]==0,:3]=0
            protected=upper==0
            assert np.array_equal(result[protected],original[protected])
            changed=int(np.any(result!=original,axis=2).sum())
        else:assert np.array_equal(result,original)
        target=out/slot/f['file'];Image.fromarray(result).save(target)
        frames.append({'file':target.name,'sha256':sha(target),'inputSha256':f['sha256'],'earContourChangedPixels':changed})
        records.append({'slot':slot,'frame':index,'changedPixels':changed})
    actions[slot]={'fps':action['fps'],'loop':action.get('loop',slot=='idle'),'frames':frames}
spec={'name':'待审模型上耳轮廓修复（后身尾巴推断）','actions':[{'slot':slot,'directory':slot,'fps':a['fps'],'loop':a['loop']} for slot,a in actions.items()]}
(out/'spec.json').write_text(json.dumps(spec,ensure_ascii=False,indent=2),encoding='utf-8');pack_multi(SimpleNamespace(spec=out/'spec.json',output=out/'candidate.lotheme'))
report={'approved':False,'installable':False,'route':'model-ear-contour-v1','scriptSha256':sha(Path(__file__)),
    'inputReportSha256':sha(c/'motion/report.json'),'inputPackageSha256':sha(c/'motion/candidate.lotheme'),
    'driverReportSha256':sha(workflow/'driver/driver-report.json'),'matteMetricsSha256':sha(workflow/'matte/metrics.json'),
    'planSha256':sha(planfile),'sourceSha256':sha(source),'earRegionEndsBeforeEyeY':eye_y-3,
    'maximumInnerBandPx':5,'smoothContourSigma':.65,'realModelRgbUsed':True,'wholeAnchorWarped':False,
    'actions':actions,'frames':records,'packageSha256':sha(out/'candidate.lotheme'),
    'limitations':['Model silhouette may omit fine fur','Local ear contour only; face/body defects remain','No naturalness or installation approval']}
(out/'report.json').write_text(json.dumps(report,indent=2),encoding='utf-8');print(json.dumps({'frames':len(records),'changed':sum(r['changedPixels'] for r in records),'approved':False}))
