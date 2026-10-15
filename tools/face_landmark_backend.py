"""Optional pinned offline CPU face-point proposals, never approvals or themes."""
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import uuid
from PIL import Image
from fetch_face_landmark_experiment import MODELS

PROJECT = Path(__file__).resolve().parents[1]
CONFIG_PATH = PROJECT/'generated/face-backend.json'
OUTPUT = PROJECT/'generated/face-point-drafts'
PINS = {
    'evaluate_face_landmarks.py': '389be0328e9cef867bffbc15d11d6d9e27a0d135fd47b6396b5b637f4c94517c',
    'fetch_face_landmark_experiment.py': '051506b0002c4af84ecfcc2de322152dd4ca20a252e6b8a4e9e50e19a6c0080b',
    'prepare_face_landmark_draft.py': '5f88e8cd14d166f3b2cc103393d0948b363476f2e9358056e041ca9bf18af9a2',
}


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def configuration():
    if CONFIG_PATH.is_file():
        record = json.loads(CONFIG_PATH.read_text(encoding='utf-8'))
        if not isinstance(record, dict) or set(record) != {'version','root'} or type(record['version']) is not int or record['version'] != 1:
            raise ValueError('Invalid saved face backend configuration')
        value, origin = record['root'], 'saved'
    else:
        value = os.environ.get('AI_PET_FACE_BACKEND_ROOT')
        origin = 'environment' if value else 'unconfigured' if getattr(sys,'frozen',False) else 'development'
        if not value and not getattr(sys,'frozen',False): value = str(PROJECT)
    if value is not None and (not isinstance(value,str) or not value.strip() or len(value)>1024 or value.startswith(('\\\\','//')) or not Path(value).is_absolute()):
        raise ValueError('Face backend must use an absolute local directory')
    return {'source':origin,'root':value}


def validate_root(root):
    if not (root/'.venv-face-landmarks/Scripts/python.exe').is_file():
        raise ValueError('Local CPU face interpreter is missing')
    for name, expected in PINS.items():
        path = root/'tools'/name
        if not path.is_file() or sha(path) != expected:
            raise ValueError('Face worker fingerprint mismatch: '+name)
    models = root/'models/face-landmarks-v1'
    for species, model in MODELS.items():
        for name, expected in model['files'].items():
            path = models/species/name
            if not path.is_file() or sha(path) != expected:
                raise ValueError('Face model fingerprint mismatch: '+name)
    return models


def capabilities():
    config = {'source':'invalid','root':None}
    problem = None
    try:
        config = configuration()
        if not config['root']: raise ValueError('Local CPU face backend is not configured')
        validate_root(Path(config['root']))
    except (OSError,ValueError,TypeError) as error:
        problem = str(error)
    return dict(ready=problem is None, configuration=config, unavailableReason=problem,
                route='local-landmark-exploratory-v1', species=['cat','dog'],
                license='CC-BY-NC-4.0', modelsBundled=False, remoteNetworkUsed=False,
                confidenceAvailable=False, singleFaceAssumed=True,
                approved=False, facePointsConfirmed=False, installable=False)


def configure(request):
    if not isinstance(request,dict) or set(request) != {'root'}:
        raise ValueError('Expected a local face backend directory or null')
    value = request['root']
    if value is not None:
        if not isinstance(value,str) or not value.strip() or len(value)>1024 or value.startswith(('\\\\','//')) or not Path(value).is_absolute():
            raise ValueError('Choose an absolute local face directory')
        root = Path(value).resolve(); validate_root(root); value = str(root)
    CONFIG_PATH.parent.mkdir(parents=True,exist_ok=True)
    temporary = CONFIG_PATH.with_suffix('.tmp')
    temporary.write_text(json.dumps({'version':1,'root':value}),encoding='utf-8')
    os.replace(temporary,CONFIG_PATH)
    return capabilities()


def propose(request):
    if not isinstance(request,dict) or set(request) != {'imageBase64','photoSha256','species'}:
        raise ValueError('Invalid face proposal fields')
    species = request['species']
    if not isinstance(species,str) or species not in MODELS:
        raise ValueError('Explicit cat or dog selection required')
    if not isinstance(request['photoSha256'],str) or not re.fullmatch('[a-f0-9]{64}',request['photoSha256']):
        raise ValueError('Invalid face photo fingerprint')
    if not isinstance(request['imageBase64'],str): raise ValueError('Expected encoded photo bytes')
    payload = base64.b64decode(request['imageBase64'],validate=True)
    if not 1 <= len(payload) <= 8*1024*1024 or hashlib.sha256(payload).hexdigest() != request['photoSha256']:
        raise ValueError('Face photo byte fingerprint mismatch')
    with Image.open(io.BytesIO(payload)) as image:
        if image.format not in ('JPEG','PNG','WEBP') or min(image.size)<32 or max(image.size)>4096 or image.width*image.height>16000000:
            raise ValueError('Unsupported face photo format or canvas')
        image.verify()
    config = configuration()
    if not config['root']: raise ValueError('Local CPU face backend is not configured')
    root = Path(config['root']); models = validate_root(root)
    folder = OUTPUT/uuid.uuid4().hex; folder.mkdir(parents=True,exist_ok=False)
    source = folder/'source-photo.bin'; source.write_bytes(payload)
    record = dict(photoSha256=request['photoSha256'],species=species,approved=False,
                  remoteNetworkUsed=False,workerSha256=PINS,originalUploadBytesRetained=False)
    (folder/'request.json').write_text(json.dumps(record,indent=2),encoding='utf-8')
    environment = dict(os.environ,HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1')
    interpreter = root/'.venv-face-landmarks/Scripts/python.exe'
    try:
        for name, arguments in (
            ('evaluate_face_landmarks.py',['--source',str(source),'--species',species,'--models',str(models),'--output',str(folder/'model')]),
            ('prepare_face_landmark_draft.py',['--source',str(source),'--report',str(folder/'model/report.json'),'--output',str(folder/'face-point-draft.json')])):
            with (folder/(name+'.log')).open('w',encoding='utf-8') as log:
                result = subprocess.run([str(interpreter),str(root/'tools'/name),*arguments],cwd=root,env=environment,
                                        stdout=log,stderr=subprocess.STDOUT,timeout=90,
                                        creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
            if result.returncode: raise ValueError('Local face worker failed; evidence retained: '+name)
        draft = json.loads((folder/'face-point-draft.json').read_text(encoding='utf-8'))
        if draft['sourceSha256'] != request['photoSha256'] or draft['species'] != species or draft['approved'] is not False or draft['facePointsConfirmed'] is not False:
            raise ValueError('Face worker result source/state mismatch')
        record.update(status='draft-requires-point-review',draftSha256=sha(folder/'face-point-draft.json'))
        return draft
    except Exception as error:
        record.update(status='failed',error=str(error))
        raise
    finally:
        # Numbered cropped/full-source review images deliberately remain as
        # evidence; the original upload bytes are temporary, not retained.
        source.unlink(missing_ok=True)
        record['reviewImagesRetained'] = True
        (folder/'result.json').write_text(json.dumps(record,indent=2),encoding='utf-8')
