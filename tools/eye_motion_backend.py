"""Optional local animal inference adapter for unapproved transparent bundles.

No downloads, arbitrary commands, remote photos, approvals or installations.
The GPU model is a separately configured dependency, never claimed bundled.
"""
from pathlib import Path
import json
import os
import shutil
import subprocess
import sys
from PIL import Image
from transparent_head_tilt import sha
from transparent_eye_motion import generate
from review_video import encode_review_assets

PROJECT = Path(__file__).resolve().parents[1]
CONFIG_PATH = PROJECT / 'generated/animal-backend.json'
RUNNER_SHA256 = 'df96225ff9d85c3fa45fc0e23b832e9d6bfead14852d057c99842a6ec06902fe'


def required_files():
    return ['.venv-liveportrait/Scripts/python.exe', 'tools/run_animal_eye_driver.py',
        'third_party/LivePortrait-src/assets/examples/driving/wink.pkl'] + [
        'third_party/LivePortrait-src/pretrained_weights/liveportrait_animals/base_models_v1.1/' + n + '.pth'
        for n in ('appearance_feature_extractor', 'motion_extractor', 'spade_generator', 'warping_module')]


def configuration():
    if CONFIG_PATH.is_file():
        record = json.loads(CONFIG_PATH.read_text(encoding='utf-8'))
        if (not isinstance(record, dict) or set(record) != {'version', 'root'}
                or type(record['version']) is not int or record['version'] != 1
                or (record['root'] is not None and not isinstance(record['root'], str))):
            raise ValueError('Invalid saved animal backend configuration')
        return {'source': 'saved', 'root': record['root']}
    configured = os.environ.get('AI_PET_ANIMAL_BACKEND_ROOT')
    return {'source': 'environment' if configured else 'development' if not getattr(sys, 'frozen', False) else 'unconfigured',
        'root': configured or (str(PROJECT) if not getattr(sys, 'frozen', False) else None)}


def configure_backend(request):
    if not isinstance(request, dict) or set(request) != {'root'}:
        raise ValueError('Expected a local backend directory or null')
    value = request['root']
    if value is not None:
        if not isinstance(value, str) or not value.strip() or len(value) > 1024:
            raise ValueError('Invalid local backend directory')
        root = Path(value)
        if not root.is_absolute() or value.startswith(('\\\\', '//')):
            raise ValueError('Choose an absolute local directory')
        root = root.resolve()
        missing = [name for name in required_files() if not (root / name).is_file()]
        if missing:
            raise ValueError('Local backend is incomplete: ' + ', '.join(missing))
        if sha(root / 'tools/run_animal_eye_driver.py') != RUNNER_SHA256:
            raise ValueError('Local inference adapter version does not match this creator')
        value = str(root)
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary = CONFIG_PATH.with_suffix('.tmp')
    temporary.write_text(json.dumps({'version': 1, 'root': value}, indent=2), encoding='utf-8')
    os.replace(temporary, CONFIG_PATH)
    return capabilities()


def backend_root():
    configured = configuration()['root']
    if configured:
        root = Path(configured)
        if not root.is_absolute():
            raise ValueError('Animal backend directory must be absolute')
        return root.resolve()
    return None


def capabilities():
    problem = None
    config = {'source': 'invalid', 'root': None}
    ready = False
    try:
        config = configuration()
        root = backend_root()
        ready = root is not None and all((root / name).is_file() for name in required_files())
        if ready and sha(root / 'tools/run_animal_eye_driver.py') != RUNNER_SHA256:
            ready = False
            problem = 'Local inference adapter version does not match this creator'
        ready = ready and shutil.which('ffmpeg') is not None
    except (OSError, ValueError, TypeError) as error:
        problem = str(error)
    return {'ready': ready, 'route': 'transparent-eye-bundle-v1', 'gpuModelsBundled': False,
        'remoteNetworkUsed': False, 'requiresHumanReview': True, 'promptProseExecuted': False,
        'template': 'wink-and-head-tilt', 'slots': ['idle', 'hover', 'click'],
        'configuration': config,
        'unavailableReason': None if ready else problem or 'Local animal model or video encoder unavailable; no candidate generated'}


def create_bundle(source, plan, folder, settings):
    if (not isinstance(settings,dict) or settings != {'version': 1, 'template': 'wink-and-head-tilt', 'multiplier': 1.5}
            or type(settings['version']) is not int):
        raise ValueError('Unsupported eye motion template or parameters')
    if not capabilities()['ready']:
        raise ValueError('Local animal model unavailable; no simulated candidate')
    root = backend_root()
    if sha(source) != plan['sourceSha256']:
        raise ValueError('Source and plan fingerprint differ')
    original = Image.open(source).convert('RGBA')
    width, height = original.size
    anchor = Image.new('RGBA', (width+width%2, height+height%2))
    anchor.paste(original, (0, 0))
    anchor.save(folder / 'animal-anchor.png')
    rendered_plan = dict(plan)
    rendered_plan['sourceSha256'] = sha(folder / 'animal-anchor.png')
    rendered_plan['facePointsNormalized'] = [[x*width/anchor.width, y*height/anchor.height]
        for x, y in plan['facePointsNormalized']]
    plan_path = folder / 'animal-plan.json'
    plan_path.write_text(json.dumps(rendered_plan, ensure_ascii=False, indent=2), encoding='utf-8')
    background = Image.new('RGBA', anchor.size, '#808080')
    background.alpha_composite(anchor)
    rgb = folder / 'animal-source.png'
    background.convert('RGB').save(rgb)
    annotation = folder / 'animal-points.json'
    annotation.write_text(json.dumps({'sourceSha256': sha(rgb), 'imageSize': list(anchor.size),
        'pointsNormalized': rendered_plan['facePointsNormalized']}), encoding='utf-8')
    env = {key.upper(): value for key, value in os.environ.items()}
    env.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', PYTHONIOENCODING='utf-8')
    encoder = shutil.which('ffmpeg')
    env['PATH'] = str(Path(encoder).parent)+os.pathsep+env.get('PATH', '')
    # imageio otherwise chooses its unrelated, old bundled FFmpeg even when
    # the creator has a verified encoder on PATH.
    env['IMAGEIO_FFMPEG_EXE'] = encoder
    command = [str(root / '.venv-liveportrait/Scripts/python.exe'),
        str(root / 'tools/run_animal_eye_driver.py'), '--source', str(rgb), '--annotation', str(annotation),
        '--output', str(folder / 'animal-driver'), '--multiplier', '1.5']
    with (folder / 'animal-inference.log').open('w', encoding='utf-8') as log:
        result = subprocess.run(command, env=env, cwd=root, stdout=log, stderr=subprocess.STDOUT, timeout=180,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    (folder / 'animal-process-result.json').write_text(json.dumps({
        'exitCode': result.returncode, 'encoder': encoder,
        'encoderSha256': sha(encoder), 'runnerSha256': sha(root / 'tools/run_animal_eye_driver.py'),
        'approved': False}, indent=2), encoding='utf-8')
    if result.returncode:
        raise ValueError('Local animal inference failed; retained log, no candidate approved')
    driver = folder / 'animal-driver'
    provenance = json.loads((driver / 'driver-report.json').read_text(encoding='utf-8'))
    paths = sorted((driver / 'lossless').glob('frame-*.png'))
    if (provenance['sourceSha256'] != sha(rgb) or provenance['annotationSha256'] != sha(annotation)
            or len(paths) != 57 or len(provenance['frames']) != 57
            or any(item['file'] != path.name or item['sha256'] != sha(path)
                for item, path in zip(provenance['frames'], paths))):
        raise ValueError('Animal frame provenance mismatch')
    report = generate(folder / 'animal-anchor.png', plan_path, driver, folder / 'motion',
        align=True, mode='replacement')
    report.update(inputSourceSha256=sha(source), renderSourceSha256=report['sourceSha256'],
        inputCanvas=[width, height], renderCanvas=list(anchor.size),
        padding='At most one transparent pixel right/bottom; no resampling',
        model=provenance['model'], driverReportSha256=sha(driver / 'driver-report.json'),
        gpuModelsBundled=False, remoteNetworkUsed=False, promptProseExecuted=False,
        motionKind='eye-bundle', actionTemplate=settings['template'])
    # Preserve the HTTP input fingerprint; record actual padded renderer input
    # separately instead of pretending it is byte-identical.
    report['sourceSha256'] = sha(source)
    report['frames'] = [{'slot': slot, **frame} for slot, action in report['actions'].items() for frame in action['frames']]
    report['reviewEncoding']=encode_review_assets(folder/'motion',report['actions'],encoder)
    return report
