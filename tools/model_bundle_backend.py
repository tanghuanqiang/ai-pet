"""Fresh local model head + eye generation; retain every stage, never approve."""
import json,re,shutil
from types import SimpleNamespace
from pathlib import Path
import eye_motion_backend as eyes
import model_head_backend as heads
from compose_model_motion_bundle import compose
from theme_package import pack_multi
from transparent_head_tilt import sha

def capabilities():
    head=heads.capabilities();eye=eyes.capabilities()
    return {'ready':head['ready'] and eye['ready'],'route':'model-motion-bundle-v1',
            'requiresHumanReview':True,'remoteNetworkUsed':False,'promptProseExecuted':False,
            'gpuModelsBundled':False,'refinementReady':head['refinementReady'],
            'headOnlyRedoReady':head['ready']}

def validate_head_redo(parent, plan):
    """A head-only redo cannot change the photograph, identity or eye anchor."""
    heads.validate_request_plan(plan)
    request=json.loads((parent/'request.json').read_text(encoding='utf-8'))
    report=json.loads((parent/'motion/report.json').read_text(encoding='utf-8'))
    if report.get('motionKind')!='model-bundle' or report.get('sourceStages')!={'head':'head-generation','eye':'eye-generation'}:
        raise ValueError('Head redo requires a genuine three-action candidate')
    if {k:v for k,v in plan.items() if k!='template'}!={k:v for k,v in request['plan'].items() if k!='template'}:
        raise ValueError('Head redo cannot change source, face points, Prompt or inferred parts')
    if plan['template']==request['plan']['template']:
        raise ValueError('Choose a different head amplitude for comparison')
    if plan['template'].endswith('-refined')!=request['plan']['template'].endswith('-refined'):
        raise ValueError('Head redo cannot change the shared anchor refinement')
    if sha(parent/'source.png')!=plan['sourceSha256'] or sha(parent/'motion/candidate.lotheme')!=report['packageSha256']:
        raise ValueError('Head redo parent fingerprint mismatch')
    if report['sourceSha256']!=plan['sourceSha256'] or report['photoSha256']!=request['photoSha256']:
        raise ValueError('Head redo parent source binding mismatch')
    for stage,key in [('head-generation','headCandidateReportSha256'),('eye-generation','eyeCandidateReportSha256')]:
        if sha(parent/stage/'motion/report.json')!=report[key]:
            raise ValueError('Head redo parent stage report fingerprint mismatch')
    eye_report=json.loads((parent/'eye-generation/motion/report.json').read_text(encoding='utf-8'))
    if eye_report['renderSourceSha256']!=report['renderSourceSha256'] or sha(parent/'eye-generation/motion/candidate.lotheme')!=eye_report['packageSha256'] or sha(parent/'eye-generation/animal-anchor.png')!=report['renderSourceSha256']:
        raise ValueError('Head redo parent eye package or anchor mismatch')
    for slot in ('idle','click'):
        if report['actions'][slot]['fps']!=eye_report['actions'][slot]['fps'] or [f['sha256'] for f in report['actions'][slot]['frames']]!=[f['sha256'] for f in eye_report['actions'][slot]['frames']]:
            raise ValueError('Head redo parent eye action fingerprint mismatch')
        for frame in eye_report['actions'][slot]['frames']:
            if not re.fullmatch(r'frame-[0-9]{3}\.png',frame['file']) or sha(parent/'eye-generation/motion'/slot/frame['file'])!=frame['sha256'] or sha(parent/'motion'/slot/frame['file'])!=frame['sha256']:
                raise ValueError('Head redo parent eye frame fingerprint mismatch')
    return report,request

def redo_model_head(parent,plan,folder,photo_sha):
    previous,_=validate_head_redo(parent,plan)
    if not heads.capabilities()['ready']:raise ValueError('Local model head unavailable; no simulated substitute')
    head=folder/'head-generation';head.mkdir();shutil.copy2(parent/'source.png',head/'source.png')
    (head/'request.json').write_text(json.dumps({'plan':plan,'photoSha256':photo_sha},ensure_ascii=False,indent=2),encoding='utf-8')
    report=heads.create_template(head/'source.png',plan,head)
    pack_multi(SimpleNamespace(spec=head/'motion/spec.json',output=head/'motion/candidate.lotheme'))
    report.update(packageSha256=sha(head/'motion/candidate.lotheme'),photoSha256=photo_sha)
    (head/'motion/report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    if report['renderSourceSha256']!=previous['renderSourceSha256']:
        raise ValueError('Head redo changed shared anchor; retained failure, no combined candidate')
    eye=folder/'eye-generation'
    # Keep the original model evidence with these exact reused eye frames.
    shutil.copytree(parent/'eye-generation',eye)
    encoder=shutil.which('ffmpeg')
    if not encoder:raise ValueError('FFmpeg unavailable; retained head redo stages')
    report=compose(head,eye,folder/'motion',encoder,eye_fresh=False,head_fresh=True)
    report['sourceStages']={'head':'head-generation','eye':'eye-generation'}
    report['singleActionRedo']={'slot':'hover','parentCandidateId':previous['candidateId'],
        'parentPackageSha256':previous['packageSha256'],'parentReportSha256':sha(parent/'motion/report.json'),
        'retainedActions':['idle','click'],'parentTemplate':json.loads((parent/'request.json').read_text(encoding='utf-8'))['plan']['template']}
    return report

def create_model_bundle(source,plan,folder,photo_sha):
    heads.validate_request_plan(plan)
    if not capabilities()['ready']:raise ValueError('Local model bundle unavailable; no simulated substitute')
    head=folder/'head-generation';head.mkdir()
    shutil.copy2(source,head/'source.png')
    (head/'request.json').write_text(json.dumps({'plan':plan,'photoSha256':photo_sha},ensure_ascii=False,indent=2),encoding='utf-8')
    report=heads.create_template(head/'source.png',plan,head)
    pack_multi(SimpleNamespace(spec=head/'motion/spec.json',output=head/'motion/candidate.lotheme'))
    report.update(packageSha256=sha(head/'motion/candidate.lotheme'),photoSha256=photo_sha)
    (head/'motion/report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    eye=folder/'eye-generation';eye.mkdir();shutil.copy2(head/'model-anchor.png',eye/'source.png')
    typed=json.loads((head/'model-plan.json').read_text(encoding='utf-8'))
    eye_plan={'version':1,'action':'head-tilt','degrees':10,'durationSeconds':3,'direction':'left',
              'prompt':plan['prompt'],'sourceSha256':sha(eye/'source.png'),
              'facePointsNormalized':typed['facePointsNormalized'],'facePointsConfirmed':True,'inferredParts':plan['inferredParts']}
    (eye/'request.json').write_text(json.dumps({'plan':eye_plan,'photoSha256':photo_sha,
         'discardedIntermediateHover':'Eye adapter generates a 2D hover; final hover uses genuine head model only.'},ensure_ascii=False,indent=2),encoding='utf-8')
    report=eyes.create_bundle(eye/'source.png',eye_plan,eye,{'version':1,'template':'wink-and-head-tilt','multiplier':1.5})
    pack_multi(SimpleNamespace(spec=eye/'motion/spec.json',output=eye/'motion/candidate.lotheme'))
    report.update(packageSha256=sha(eye/'motion/candidate.lotheme'),photoSha256=photo_sha)
    (eye/'motion/report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    encoder=shutil.which('ffmpeg')
    if not encoder:raise ValueError('FFmpeg unavailable; retained model stages')
    report=compose(head,eye,folder/'motion',encoder,eye_fresh=True,head_fresh=True)
    report['sourceStages']={'head':'head-generation','eye':'eye-generation'}
    return report
