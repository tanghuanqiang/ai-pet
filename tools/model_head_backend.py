"""Creator's fixed, local AI head-pose template; produces review-only output."""
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import numpy as np
from PIL import Image
from scipy.ndimage import distance_transform_edt
import eye_motion_backend as animal
from transparent_head_tilt import validate_plan,sha
from review_video import encode_review_assets
from theme_package import pack_multi
from types import SimpleNamespace

QUALITY_WORKERS = {'prepare_opaque_pet_interior.py':'d70f0da73481101ac94b71cdafbe6544b2b0207d2fe84991170e9a92c459baef',
    'repair_model_ear_contour.py':'2c61946848888377ac696364f5590857b4cb04c23a4475f3e7f87e17e958de4c',
    'refine_model_detached_fringe.py':'3991d2f17c0a83a23c2dc9e2ccf7e4b6d30b722c4e5e892372930b3e528b0005'}

def quality_availability(root):
    try:
        if root is None:raise ValueError('Local animal backend is not configured')
        for name,digest in QUALITY_WORKERS.items():
            if not (root/'tools'/name).is_file() or sha(root/'tools'/name)!=digest:raise ValueError('Refinement worker version mismatch: '+name)
        return True,None
    except (OSError,ValueError) as e:return False,str(e)

PINNED_WORKERS = {'model_head_workflow.py': '28842c09fe0b09208a0557f5ace917387b096e13ed61ddd2e90ddf48dc39529e', 'model_head_plan.py': 'fb7cd8a46b327e9e0f1374f01825300f8d7eb9b3487834db2ef7034e0ff02a22', 'run_animal_head_driver.py': 'ddbfd16f8869e64bcb8d8f0d0b90c8c9ea3b076e014f4e3ddb5bd68bd1690860', 'segment_model_frames_sam2_image.py': 'a88c9f0320695981bbba94448cf11e97755354748a44f2d9939da34c0fdbcdda', 'refine_model_gray_matte.py': '652a149a0091ed719c6a5326307c33df3611ea292b3f92f4b17e4f7f9d9a4f0c', 'transfer_model_matte_residual.py': '3bb0caf48d0e1b3ac153fd50219e8ae99d5209b2f76ce27563737679de7fa0bd'}
TEMPLATE_DEGREES = {'curious-head-tilt':10,'curious-head-tilt-refined':10,
    'gentle-head-tilt':4,'gentle-head-tilt-refined':4}

def capabilities():
    try:
        root=animal.backend_root()
        if root is None:raise ValueError('Local animal backend is not configured')
        for name,digest in PINNED_WORKERS.items():
            if not (root/'tools'/name).is_file() or sha(root/'tools'/name) != digest:
                raise ValueError('Local head-pose worker version mismatch: '+name)
        for name in ('.venv-liveportrait/Scripts/python.exe','.venv-sam2/Scripts/python.exe',
            '.venv-matting/Scripts/python.exe','models/SAM2.1-hiera-small/sam2.1_hiera_small.pt'):
            if not (root/name).is_file():raise ValueError('Local model dependency missing: '+name)
        if not animal.capabilities()['ready']:raise ValueError('Local Animals model or FFmpeg unavailable')
        ready=True;problem=None
    except (OSError,ValueError,TypeError) as e:ready=False;problem=str(e)
    quality_ready,quality_problem=quality_availability(root if ready else None)
    return {'ready':ready,'route':'model-head-template-v1','template':'curious-head-tilt',
        'templates':[{'id':name,'degrees':degrees,'refined':name.endswith('-refined')} for name,degrees in TEMPLATE_DEGREES.items()],
        'refinementReady':ready and quality_ready,'refinementUnavailableReason':quality_problem,
        'requiresHumanReview':True,'promptProseExecuted':False,'gpuModelsBundled':False,
        'remoteNetworkUsed':False,'unavailableReason':problem}

def validate_request_plan(plan):
    keys={'version','action','template','prompt','sourceSha256','facePointsNormalized','facePointsConfirmed','inferredParts'}
    if not isinstance(plan,dict) or set(plan) != keys or plan.get('action') != 'model-head-template' or plan.get('template') not in TEMPLATE_DEGREES:
        raise ValueError('Unsupported fixed model head template')
    # Reuse reviewed point/provenance field validation only; these dummy 2D
    # parameters are neither persisted as execution metadata nor rendered.
    validate_plan({k:v for k,v in plan.items() if k != 'template'} | {
        'action':'head-tilt','degrees':8,'durationSeconds':3,'direction':'left'})
    return plan

def segmentation_points(rgba,face):
    width,height=rgba.size;alpha=np.asarray(rgba)[:,:,3]
    interior=distance_transform_edt(alpha>=250)>=4
    y,x=np.mgrid[:height,:width]
    nose=[int(face[4][0]*width),int(face[4][1]*height)]
    if alpha[nose[1],nose[0]] < 250:raise ValueError('Confirmed nose is outside opaque source interior')
    if not interior[nose[1],nose[0]]:
        # Pinholes near a valid confirmed nose may interrupt the inscribed
        # interior. Move only the SAM prompt, never the model face annotation.
        distance=np.where(interior,(x-nose[0])**2+(y-nose[1])**2,np.inf)
        yy,xx=np.unravel_index(distance.argmin(),distance.shape)
        if distance[yy,xx] > 64:raise ValueError('No opaque segmentation interior within eight pixels of nose')
        nose=[int(xx),int(yy)]
    positive=[nose]
    for _ in range(3):
        distance=np.minimum.reduce([(x-px)**2+(y-py)**2 for px,py in positive])
        distance=np.where(interior,distance,-1)
        yy,xx=np.unravel_index(distance.argmax(),distance.shape)
        if distance[yy,xx] < 64:raise ValueError('Source interior too small for model segmentation')
        positive.append([int(xx),int(yy)])
    exterior=distance_transform_edt(alpha==0)>=20
    negative=[]
    for cx,cy in ((0,0),(width-1,0),(width-1,height-1),(0,height-1)):
        distance=np.where(exterior,(x-cx)**2+(y-cy)**2,np.inf)
        yy,xx=np.unravel_index(distance.argmin(),distance.shape)
        if not np.isfinite(distance[yy,xx]):raise ValueError('Source has insufficient transparent exterior')
        point=[int(xx),int(yy)]
        if point not in negative:negative.append(point)
    if len(negative)<3:raise ValueError('Insufficient independent background prompts')
    return {'positive':positive,'negative':negative}

def create_template(source,request_plan,folder):
    validate_request_plan(request_plan)
    if not capabilities()['ready']:raise ValueError('Local model head template unavailable; no simulated candidate')
    if sha(source) != request_plan['sourceSha256']:raise ValueError('Source and template request fingerprint differ')
    root=animal.backend_root();rgba=Image.open(source).convert('RGBA')
    if rgba.getchannel('A').getextrema() != (0,255):raise ValueError('Source needs transparent exterior and opaque subject')
    refined=request_plan['template'].endswith('-refined')
    def run_quality(name,arguments):
        ready,problem=quality_availability(root)
        if not ready:raise ValueError(problem)
        env={k.upper():v for k,v in os.environ.items()};env['PYTHONIOENCODING']='utf-8'
        with (folder/(name+'.log')).open('w',encoding='utf-8') as log:
            result=subprocess.run([str(root/'.venv-matting/Scripts/python.exe'),str(root/'tools'/name),*map(str,arguments)],cwd=root,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=120,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
        if result.returncode:raise ValueError('Local refinement failed; log retained: '+name)
    preparation=None
    if refined:
        run_quality('prepare_opaque_pet_interior.py',['--source',source,'--output',folder/'source-refinement'])
        preparation=json.loads((folder/'source-refinement/report.json').read_text(encoding='utf-8'))
        rgba=Image.open(folder/'source-refinement/UNAPPROVED-opaque-interior.png').convert('RGBA')
    width,height=rgba.size
    anchor=Image.new('RGBA',(width+width%2,height+height%2));anchor.paste(rgba,(0,0))
    anchor.save(folder/'model-anchor.png')
    face=[[x*width/anchor.width,y*height/anchor.height] for x,y in request_plan['facePointsNormalized']]
    gray=Image.new('RGBA',anchor.size,'#808080');gray.alpha_composite(anchor)
    gray.convert('RGB').save(folder/'model-source.png')
    annotation=folder/'model-points.json'
    annotation.write_text(json.dumps({'sourceSha256':sha(folder/'model-source.png'),
        'imageSize':list(anchor.size),'pointsNormalized':face}),encoding='utf-8')
    typed={'version':1,'action':'model-head-pose','axis':'roll','signedPeakDegrees':TEMPLATE_DEGREES[request_plan['template']],
        'durationSeconds':3,'fps':20,'envelope':'quick-look-return','poseAnchor':'driving',
        'prompt':request_plan['prompt'],'promptInterpretation':'explicit-parameters-only',
        'sourceRgbaSha256':sha(folder/'model-anchor.png'),'modelSourceSha256':sha(folder/'model-source.png'),
        'annotationSha256':sha(annotation),'facePointsNormalized':face,'facePointsConfirmed':True,
        'inferredParts':request_plan['inferredParts'] or 'No additional anatomy inferred by this head-pose template.'}
    plan=folder/'model-plan.json';plan.write_text(json.dumps(typed,ensure_ascii=False,indent=2),encoding='utf-8')
    points=folder/'segmentation-points.json';points.write_text(json.dumps(segmentation_points(anchor,face)),encoding='utf-8')
    encoder=shutil.which('ffmpeg');env={k.upper():v for k,v in os.environ.items()}
    env.update(PYTHONIOENCODING='utf-8',HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1')
    command=[str(root/'.venv-matting/Scripts/python.exe'),str(root/'tools/model_head_workflow.py'),
        '--backend-root',str(root),'--source',str(folder/'model-anchor.png'),
        '--model-source',str(folder/'model-source.png'),'--annotation',str(annotation),
        '--plan',str(plan),'--points',str(points),'--output',str(folder/'model-workflow')]
    with (folder/'model-workflow.log').open('w',encoding='utf-8') as log:
        result=subprocess.run(command,cwd=root,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=600,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    (folder/'model-process-result.json').write_text(json.dumps({'exitCode':result.returncode,'approved':False}),encoding='utf-8')
    if result.returncode:raise ValueError('Local model head generation failed; stage logs retained')
    workflow=folder/'model-workflow';state=json.loads((workflow/'workflow.json').read_text())
    if state['status'] != 'candidate-requires-human-review':raise ValueError('Incomplete model workflow')
    shutil.copytree(workflow/'motion',folder/'motion')
    report=json.loads((folder/'motion/report.json').read_text())
    spec=json.loads((folder/'motion/spec.json').read_text(encoding='utf-8'))
    spec['name']='待审轻微歪头模型动作' if typed['signedPeakDegrees']==4 else '待审好奇歪头模型动作'
    (folder/'motion/spec.json').write_text(json.dumps(spec,ensure_ascii=False,indent=2),encoding='utf-8')
    report.update(motionKind='model-head',actionTemplate=request_plan['template'],executedModelPlan=typed,
        inputSourceSha256=sha(source),renderSourceSha256=report['sourceSha256'],sourceSha256=sha(source),
        inputCanvas=[width,height],renderCanvas=list(anchor.size),
        padding='At most one transparent pixel right/bottom; no resampling',
        workflowSha256=sha(workflow/'workflow.json'),workflowPackageSha256=state['packageSha256'],
        segmentationPointStrategy='source-alpha-inscribed-four-points-and-exterior-corners',
        gpuModelsBundled=False,remoteNetworkUsed=False,promptProseExecuted=False)
    if refined:
        # Retain the pre-repair theme/report before overwriting final frame files.
        pack_multi(SimpleNamespace(spec=folder/'motion/spec.json',output=folder/'motion/candidate.lotheme'))
        report['packageSha256']=sha(folder/'motion/candidate.lotheme')
        (folder/'motion/report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
        run_quality('repair_model_ear_contour.py',['--candidate',folder,'--output',folder/'ear-refinement'])
        shutil.copytree(folder/'motion',folder/'unrefined-motion')
        # Service packs the final frames once; keep the pre-repair archive in
        # unrefined-motion, then release only our temporary package pathname.
        (folder/'motion/candidate.lotheme').unlink()
        ear=json.loads((folder/'ear-refinement/report.json').read_text(encoding='utf-8'))
        for slot,action in ear['actions'].items():
            for frame in action['frames']:shutil.copy2(folder/'ear-refinement'/slot/frame['file'],folder/'motion'/slot/frame['file'])
        report['unrefinedActions']=report['actions'];report['actions']=ear['actions']
        report['qualityRefinement']={'source':preparation,'earReportSha256':sha(folder/'ear-refinement/report.json'),
            'unrefinedPackageSha256':sha(folder/'unrefined-motion/candidate.lotheme'),
            'workers':QUALITY_WORKERS,'assumesOpaqueFur':True,'requiresHumanReview':True}
        # Bind the next worker to the actual ear-repaired package, retaining
        # the exact intermediate report and package before final replacement.
        pack_multi(SimpleNamespace(spec=folder/'motion/spec.json',output=folder/'motion/candidate.lotheme'))
        report['packageSha256']=sha(folder/'motion/candidate.lotheme')
        (folder/'motion/report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
        run_quality('refine_model_detached_fringe.py',['--candidate',folder,'--output',folder/'fringe-refinement',
            '--ffmpeg',encoder,'--no-review-video'])
        shutil.copytree(folder/'motion',folder/'pre-fringe-motion')
        (folder/'motion/candidate.lotheme').unlink()
        fringe=json.loads((folder/'fringe-refinement/report.json').read_text(encoding='utf-8'))
        report['preFringeActions']=report['actions'];report['actions']=fringe['actions']
        for slot,action in fringe['actions'].items():
            for frame in action['frames']:shutil.copy2(folder/'fringe-refinement'/slot/frame['file'],folder/'motion'/slot/frame['file'])
        report['qualityRefinement'].update(fringeReportSha256=sha(folder/'fringe-refinement/report.json'),
            preFringePackageSha256=sha(folder/'pre-fringe-motion/candidate.lotheme'),
            fringePolicy=fringe['policy'],fringeRemovedPixels=sum(f['removedPixels'] for f in fringe['frames']))
    report['frames']=[{'slot':slot,**f} for slot,a in report['actions'].items() for f in a['frames']]
    report['reviewEncoding']=encode_review_assets(folder/'motion',report['actions'],encoder)
    return report
