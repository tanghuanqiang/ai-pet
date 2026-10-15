"""Freeze the local CPU creator into a versioned, self-contained directory.

Does not install anything or bundle GPU models. Retains build inputs and logs.
"""
from __future__ import annotations
import argparse
import hashlib
import importlib.metadata as metadata
import json
from pathlib import Path
import shutil
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[1]
SOURCE_FILES=['creator_launcher.py','head_tilt_service.py','transparent_head_tilt.py',
              'theme_package.py','review_ledger.py','creative_plan_service.py',
              'creative_plan.schema.json','head_tilt_plan.schema.json','creator-control.js',
              'matte_refinement_service.py','refine_foreground_matte.py','model_adapters.py','run_birefnet.py','hook-pymatting.py',
              'eye_motion_backend.py','transparent_eye_motion.py','review_all_rgba_frames.py',
              'model_head_backend.py','model_bundle_backend.py','compose_model_motion_bundle.py','review_video.py','creator_segmentation_backend.py',
              'face_landmark_backend.py','fetch_face_landmark_experiment.py']
WEB_FILES=['index.html','app.js','theme-frame-player.js','styles.css','simple-ui.js','simple-ui.css','reference-cat.jpg','assets/reviewed-reference-cat.png','assets/pending-model-reference-cat.png']


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--output',type=Path,required=True)
    p.add_argument('--ffmpeg',type=Path,required=True)
    args=p.parse_args()
    out=args.output.resolve()
    out.mkdir(parents=True,exist_ok=False)
    source=out/'source';source.mkdir()
    web=out/'studio';web.mkdir()
    for name in SOURCE_FILES:shutil.copy2(ROOT/'tools'/name,source/name)
    for name in WEB_FILES:
        target=web/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(ROOT/name,target)
    shutil.copy2(source/'creator-control.js',web/'creator-control.js')
    notices=out/'notices';notices.mkdir()
    versions={}
    for package in ('numpy','pillow','opencv-python-headless','pyinstaller','pymatting','scipy','numba','llvmlite'):
        distribution=metadata.distribution(package);versions[package]=distribution.version
        for item in distribution.files or []:
            if any(key in item.name.lower() for key in ('license','copying','notice')) and '.dist-info' in str(item):
                path=Path(distribution.locate_file(item))
                if path.is_file():shutil.copy2(path,notices/(package+'-'+item.name))
    python_license=Path(sys.base_prefix)/'LICENSE_PYTHON.txt'
    if python_license.is_file():shutil.copy2(python_license,notices/'PYTHON-LICENSE.txt')
    ffmpeg_license=args.ffmpeg.parent.parent/'LICENSE'
    for candidate in (ffmpeg_license,ffmpeg_license.with_suffix('.txt')):
        if candidate.is_file():shutil.copy2(candidate,notices/'FFMPEG-LICENSE.txt');break
    ffmpeg_info=subprocess.run([str(args.ffmpeg),'-version'],capture_output=True,text=True,check=True)
    (notices/'FFMPEG-BUILD.txt').write_text(ffmpeg_info.stdout,encoding='utf-8')
    command=[sys.executable,'-m','PyInstaller','--noconfirm','--onedir','--windowed','--name','AIPetCreator',
        '--distpath',str(out/'dist'),'--workpath',str(out/'build'),'--specpath',str(out),
        '--paths',str(source),'--add-data',str(web)+';studio',
        '--add-data',str(source/'creative_plan.schema.json')+';tools',
        '--add-data',str(source/'head_tilt_plan.schema.json')+';tools',
        '--add-data',str(source/'transparent_head_tilt.py')+';.',
        '--add-data',str(source/'transparent_eye_motion.py')+';.',
        '--add-data',str(source/'review_video.py')+';.',
        '--add-data',str(notices)+';notices','--add-binary',str(args.ffmpeg)+';bin']
    # PyMatting's cached Numba functions need their source location when frozen.
    command+=['--additional-hooks-dir',str(source),'--collect-all','llvmlite','--collect-submodules','numba']
    # These optional scientific/UI stacks are unrelated to numpy/cv2/Pillow
    # rendering and must not enter from the developer's broad Python install.
    for excluded in ('torch','tensorflow','pandas','matplotlib','IPython','notebook','PyQt5','PyQt6','PySide2','PySide6','tkinter'):
        command+=['--exclude-module',excluded]
    command.append(str(source/'creator_launcher.py'))
    (out/'build-command.json').write_text(json.dumps(command,indent=2),encoding='utf-8')
    with (out/'build.log').open('w',encoding='utf-8') as log:
        result=subprocess.run(command,cwd=out,stdout=log,stderr=subprocess.STDOUT)
    if result.returncode:raise RuntimeError('Creator build failed; see retained build.log')
    bundle=out/'dist/AIPetCreator'
    report={'format':'little-orbit.creator-build','python':sys.version,'packages':versions,
        'gpuModelsBundled':False,'installed':False,'sourceSha256':{name:hashlib.sha256((source/name).read_bytes()).hexdigest() for name in SOURCE_FILES},
        'webSha256':{name:hashlib.sha256((web/name).read_bytes()).hexdigest() for name in WEB_FILES},
        'files':[{ 'path':str(f.relative_to(bundle)),'bytes':f.stat().st_size,'sha256':hashlib.sha256(f.read_bytes()).hexdigest()} for f in sorted(bundle.rglob('*')) if f.is_file()]}
    (out/'build-report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps({'bundle':str(bundle),'files':len(report['files']),'bytes':sum(f['bytes'] for f in report['files'])}))


if __name__=='__main__':main()
