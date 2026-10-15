"""Local typed model→SAM2→matte→transparent review-only workflow.

Uses the configured local GPU/CPU environments. No approval or installation.
"""
import argparse
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import time
from model_head_plan import bind_inputs,sha,pose_weights

def main():
    p=argparse.ArgumentParser(description=__doc__)
    for name in ('source','model-source','annotation','plan','points','output'):
        p.add_argument('--'+name,type=Path,required=True)
    p.add_argument('--backend-root',type=Path,default=Path(__file__).resolve().parents[1])
    p.add_argument('--verified-driver',type=Path)
    a=p.parse_args();backend=a.backend_root.resolve();out=a.output.resolve()
    plan=bind_inputs(json.loads(a.plan.read_text(encoding='utf-8')),a.source,a.model_source,a.annotation)
    scripts=['run_animal_head_driver.py','segment_model_frames_sam2_image.py',
        'refine_model_gray_matte.py','transfer_model_matte_residual.py']
    for env in ('liveportrait','sam2','matting'):
        if not (backend/f'.venv-{env}/Scripts/python.exe').is_file():
            raise ValueError('Local model dependency missing: '+env)
    for script in scripts:
        if not (backend/'tools'/script).is_file():raise ValueError('Local worker missing: '+script)
    ffmpeg=shutil.which('ffmpeg')
    if not ffmpeg:raise ValueError('Explicit local FFmpeg is required')
    if a.verified_driver:
        d=json.loads((a.verified_driver/'driver-report.json').read_text())
        if (d.get('modelMotionPlanSha256') != sha(a.plan) or d['sourceSha256'] != sha(a.model_source)
            or d['annotationSha256'] != sha(a.annotation) or d.get('sourceRgbaSha256') != sha(a.source)
            or d['axis'] != plan['axis'] or d['degrees'] != plan['signedPeakDegrees']
            or d['fps'] != 20 or len(d['frames']) != 60 or d.get('poseAnchor') != plan['poseAnchor']):
            raise ValueError('Existing model driver provenance differs from this request')
        actual=json.loads((a.verified_driver/'driver-plan.json').read_text())
        if actual['anglesDegrees'] != [plan['signedPeakDegrees']*w for w in pose_weights(plan['envelope'])]:
            raise ValueError('Existing model driver angles differ from this request')
        if sha(a.verified_driver/'model-motion-plan.json') != sha(a.plan):
            raise ValueError('Existing model driver plan bytes differ from this request')
        if sha(a.verified_driver/('bounded-'+plan['axis']+'.pkl')) != d['driverSha256']:
            raise ValueError('Existing model driver template fingerprint invalid')
        for f in d['frames']:
            if Path(f['file']).name != f['file'] or sha(a.verified_driver/'lossless'/f['file']) != f['sha256']:
                raise ValueError('Existing model frame fingerprint invalid')
    points=json.loads(a.points.read_text(encoding='utf-8'))
    if not isinstance(points,dict) or set(points) != {'positive','negative'} or not points.get('positive') or not points.get('negative'):
        raise ValueError('Explicit segmentation foreground/background points required')
    from PIL import Image
    with Image.open(a.source) as im:width,height=im.size
    for kind in ('positive','negative'):
        if not isinstance(points[kind],list) or not 1 <= len(points[kind]) <= 64:
            raise ValueError('Invalid segmentation point count')
        for point in points[kind]:
            if (not isinstance(point,list) or len(point) != 2 or
                any(type(v) not in (int,float) or not math.isfinite(v) for v in point) or
                not 0 <= point[0] < width or not 0 <= point[1] < height):
                raise ValueError('Segmentation point outside source canvas')
    out.mkdir(parents=True,exist_ok=False);(out/'inputs').mkdir()
    inputs={}
    for name,path in [('source',a.source),('model-source',a.model_source),('annotation',a.annotation),
                      ('plan',a.plan),('points',a.points)]:
        target=out/'inputs'/(name+path.suffix);shutil.copyfile(path,target);inputs[name]=target
    state={'approved':False,'installed':False,'installable':False,'status':'running',
        'workflowScriptSha256':sha(Path(__file__)),
        'externalGpuDependenciesBundled':False,'creatorIntegrated':False,
        'inputSha256':{n:sha(path) for n,path in inputs.items()},'encoderSha256':sha(Path(ffmpeg)),
        'workerSha256':{s:sha(backend/'tools'/s) for s in scripts},'stages':[]}
    def save(): (out/'workflow.json').write_text(json.dumps(state,indent=2),encoding='utf-8')
    save()
    env=os.environ.copy();env.update(PYTHONIOENCODING='utf-8',HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1',IMAGEIO_FFMPEG_EXE=ffmpeg)
    def run(stage,environment,script,args):
        record={'stage':stage,'status':'running','workerSha256':sha(backend/'tools'/script)}
        state['stages'].append(record);save();print(json.dumps(record),flush=True)
        started=time.monotonic()
        with (out/(stage+'.log')).open('w',encoding='utf-8') as log:
            result=subprocess.run([str(backend/f'.venv-{environment}/Scripts/python.exe'),
                str(backend/'tools'/script)]+[str(x) for x in args],cwd=backend,env=env,
                stdout=log,stderr=subprocess.STDOUT,timeout=600)
        record.update(status='passed' if result.returncode == 0 else 'failed',exitCode=result.returncode,
            seconds=time.monotonic()-started,logSha256=sha(out/(stage+'.log')));save()
        if result.returncode:raise RuntimeError('Model workflow stage failed: '+stage)
    try:
        if a.verified_driver:
            driver=out/'driver';driver.mkdir();(driver/'lossless').mkdir()
            for name in ('driver-report.json','driver-plan.json','model-motion-plan.json','bounded-'+plan['axis']+'.pkl'):
                shutil.copyfile(a.verified_driver/name,driver/name)
            for f in d['frames']:shutil.copyfile(a.verified_driver/'lossless'/f['file'],driver/'lossless'/f['file'])
            state['stages'].append({'stage':'model','status':'reused-verified-output',
                'sourceDriverReportSha256':sha(a.verified_driver/'driver-report.json'),
                'modelRerun':False,'source':str(a.verified_driver.resolve())});save()
        else:
            run('model','liveportrait',scripts[0],['--source',inputs['model-source'],'--annotation',inputs['annotation'],
                '--rgba-source',inputs['source'],'--motion-plan',inputs['plan'],'--output',out/'driver'])
        run('sam2','sam2',scripts[1],['--driver',out/'driver','--points',inputs['points'],'--output',out/'sam2'])
        run('refine','matting',scripts[2],['--driver',out/'driver','--matte',out/'sam2','--output',out/'matte'])
        run('transparent','matting',scripts[3],['--source',inputs['source'],'--model-source',inputs['model-source'],
            '--annotation',inputs['annotation'],'--plan',inputs['plan'],'--driver',out/'driver','--matte',out/'matte',
            '--baseline-correction','advected','--contour-filter','premul-band','--output',out/'motion'])
        report=json.loads((out/'motion/report.json').read_text())
        state.update(status='candidate-requires-human-review',packageSha256=report['packageSha256'],
            motionReportSha256=sha(out/'motion/report.json'));save();print(json.dumps(state),flush=True)
    except Exception as e:
        state.update(status='failed',error=str(e));save();raise

if __name__ == '__main__':main()
