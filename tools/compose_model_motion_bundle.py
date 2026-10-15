"""Compose genuine model head/eye actions with an identical return anchor.

Copies complete PNG frames; does not invent motion or approve visual quality.
"""
from pathlib import Path
import argparse, json, os, shutil
from types import SimpleNamespace
from PIL import Image, ImageChops
from transparent_head_tilt import sha
from theme_package import pack_multi
from review_video import encode_review_assets
import eye_motion_backend as eyes


def read(path):return json.loads(path.read_text(encoding='utf-8'))


def compose(head, eye, output, encoder, *, eye_fresh=False, head_fresh=False):
    head_report=read(head/'motion/report.json');eye_report=read(eye/'motion/report.json')
    if head_report.get('motionKind')!='model-head' or eye_report.get('motionKind')!='eye-bundle':
        raise ValueError('Genuine model head and eye reports required')
    if head_report['renderSourceSha256']!=eye_report['renderSourceSha256']:
        raise ValueError('Head and eye render anchors differ')
    if sha(head/'model-anchor.png')!=head_report['renderSourceSha256'] or sha(eye/'animal-anchor.png')!=eye_report['renderSourceSha256']:
        raise ValueError('Render anchor fingerprint mismatch')
    if read(head/'model-process-result.json')['exitCode']!=0 or read(eye/'animal-process-result.json')['exitCode']!=0:
        raise ValueError('Model execution failed')
    workflow=read(head/'model-workflow/workflow.json')
    if [s['stage'] for s in workflow['stages']]!=['model','sam2','refine','transparent'] or any(s['status']!='passed' or s['exitCode']!=0 for s in workflow['stages']):
        raise ValueError('Incomplete genuine head workflow')
    if sha(head/'motion/candidate.lotheme')!=head_report['packageSha256']:
        raise ValueError('Head package fingerprint mismatch')
    if sha(eye/'motion/candidate.lotheme')!=eye_report['packageSha256']:
        raise ValueError('Eye package fingerprint mismatch')
    output.mkdir(parents=True,exist_ok=False)
    spec={'name':'UNAPPROVED genuine model head and eye','actions':[]};actions={};provenance={}
    baseline=head/'motion/idle/frame-000.png';baseline_image=Image.open(baseline).convert('RGBA')
    for slot,origin,report,count in [('idle',eye,eye_report,120),('hover',head,head_report,60),('click',eye,eye_report,60)]:
        action=report['actions'][slot]
        if action['fps']!=20 or len(action['frames'])!=count:
            raise ValueError('Unexpected model action timing')
        directory=output/slot;directory.mkdir();records=[]
        for index,record in enumerate(action['frames']):
            frame=origin/'motion'/slot/record['file']
            if record['file']!=f'frame-{index:03d}.png' or sha(frame)!=record['sha256']:
                raise ValueError('Source action frame fingerprint/index mismatch')
            with Image.open(frame) as opened:
                if opened.mode!='RGBA' or opened.size!=baseline_image.size:
                    raise ValueError('Model action canvas mismatch')
                if index in (0,count-1) and ImageChops.difference(opened,baseline_image).getbbox(alpha_only=False) is not None:
                    raise ValueError('Action changes the shared return anchor')
            target=directory/frame.name;shutil.copy2(frame,target)
            records.append({'file':target.name,'sha256':sha(target),'origin':slot if slot=='hover' else 'model-eye',
                'sourceFrameSha256':record['sha256']})
        actions[slot]={'fps':20,'frames':records}
        provenance[slot]={'reportSha256':sha(origin/'motion/report.json'),'kind':report['motionKind'],
            'renderSourceSha256':report['renderSourceSha256']}
        spec['actions'].append({'slot':slot,'directory':slot,'fps':20,'loop':slot=='idle'})
    shutil.copy2(head/'model-anchor.png',output/'render-anchor.png')
    (output/'spec.json').write_text(json.dumps(spec,indent=2),encoding='utf-8')
    report={'motionKind':'model-bundle','sourceSha256':head_report['inputSourceSha256'],
        'renderSourceSha256':sha(head/'model-anchor.png'),
        'inputSourceSha256':head_report['inputSourceSha256'],'photoSha256':read(head/'request.json')['photoSha256'],
        'actions':actions,'actionSources':provenance,'frames':[{'slot':s,**f} for s,a in actions.items() for f in a['frames']],
        'sharedReturnAnchor':True,'sharedReturnAnchorSha256':sha(baseline),
        'headModelReused':not head_fresh,'eyeModelFresh':eye_fresh,'remoteNetworkUsed':False,'gpuModelsBundled':False,
        'visualApproval':False,'approved':False,'installable':False,
        'inferredParts':read(head/'model-plan.json')['inferredParts'],
        'headCandidateReportSha256':sha(head/'motion/report.json'),'eyeCandidateReportSha256':sha(eye/'motion/report.json')}
    report['reviewEncoding']=encode_review_assets(output,actions,encoder)
    pack_multi(SimpleNamespace(spec=output/'spec.json',output=output/'candidate.lotheme'))
    report['packageSha256']=sha(output/'candidate.lotheme')
    (output/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    return report


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--head',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--ffmpeg',type=Path,required=True);a=p.parse_args()
    out=a.output.resolve();out.mkdir(parents=True,exist_ok=False);head=a.head.resolve()
    os.environ['PATH']=str(a.ffmpeg.resolve().parent)+os.pathsep+os.environ.get('PATH','')
    config=out/'animal-backend.json';config.write_text(json.dumps({'version':1,'root':str(Path(__file__).resolve().parents[1])}))
    eyes.CONFIG_PATH=config
    request=read(head/'request.json')['plan'];anchor=head/'model-anchor.png';model_plan=read(head/'model-plan.json')
    plan={'version':1,'action':'head-tilt','degrees':10,'durationSeconds':3,'direction':'left',
        'prompt':request['prompt'],'facePointsNormalized':model_plan['facePointsNormalized'],'facePointsConfirmed':True,
        'sourceSha256':sha(anchor),'inferredParts':model_plan['inferredParts']}
    eye=out/'fresh-eye';eye.mkdir();shutil.copy2(anchor,eye/'source.png')
    report=eyes.create_bundle(eye/'source.png',plan,eye,{'version':1,'template':'wink-and-head-tilt','multiplier':1.5})
    pack_multi(SimpleNamespace(spec=eye/'motion/spec.json',output=eye/'motion/candidate.lotheme'))
    report['packageSha256']=sha(eye/'motion/candidate.lotheme')
    (eye/'motion/report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    composed=compose(head,eye,out/'motion',str(a.ffmpeg.resolve()),eye_fresh=True)
    print(json.dumps({'packageSha256':composed['packageSha256'],'sharedReturnAnchor':True,'approved':False}))


if __name__=='__main__':main()
