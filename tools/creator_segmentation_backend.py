"""Guarded one-shot external segmentation; no GPU imports in the frozen host."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import uuid
import eye_motion_backend as animal

OUTPUT = Path(__file__).resolve().parents[1] / 'generated/creator-segmentation'
LOCK = threading.Lock()
PINS = {
    'creator_segmentation_worker.py': '07f8d9c45c3dcd15e5ef1302737fe4479e0b88a4ef242be495c26404137e185e',
    'birefnet_service.py': 'd596ebf121716a33d3158c410d25ae7c0c2fb52c972b66d620544fb613b0689f',
    'model_adapters.py': '3db7b02c1aaeb4e5a6fd44a9748878f0e397e9881d2160fa5f1ed7e4f27fe7dc',
    'run_birefnet.py': '390d85215946d32f247184acf1803a6be3814c6644da5f440fc9ff1528e77e62',
    'theme_package.py': '2c48bf7e7ce05db2cf47678e3d669c440485ca8f931fce2a09e4d59c304256ad',
}


def run(operation, adapter, body=b'', content_type='image/png', prompts=None):
    if operation not in ('capabilities', 'segment', 'package-still') or adapter not in ('birefnet-local', 'sam2-local'):
        return 400, b'{"error":"unsupported-segmentation-route"}', 'application/json'
    if not LOCK.acquire(blocking=False):
        return 409, b'{"error":"segmentation-busy"}', 'application/json'
    started = time.perf_counter()
    report = {'operation': operation, 'adapter': adapter, 'inputSha256': hashlib.sha256(body).hexdigest() if body else None,
              'remoteNetworkUsed': False, 'inputPersisted': False, 'approved': False}
    identifier = uuid.uuid4().hex
    try:
        OUTPUT.mkdir(parents=True, exist_ok=True)
        config = animal.configuration()
        if not config['root']:
            raise ValueError('Local model environment is not configured')
        root = Path(config['root'])
        if not root.is_absolute() or not root.is_dir():
            raise ValueError('Local model environment is unavailable')
        for name, expected in PINS.items():
            file = root / 'tools' / name
            if not file.is_file() or hashlib.sha256(file.read_bytes()).hexdigest() != expected:
                raise ValueError('External segmentation worker fingerprint mismatch: ' + name)
        runtime = root / ('.venv-sam2' if adapter == 'sam2-local' else '.venv-birefnet') / 'Scripts/python.exe'
        if not runtime.is_file():
            raise ValueError('Local segmentation interpreter is unavailable')
        environment = dict(os.environ, HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', PYTHONDONTWRITEBYTECODE='1')
        # Remove developer injection paths; the fixed worker imports its pinned sibling modules.
        environment.pop('PYTHONPATH', None)
        with tempfile.TemporaryDirectory(prefix='request-', dir=OUTPUT) as temporary:
            folder = Path(temporary)
            (folder / 'input.bin').write_bytes(body)
            request = folder / 'request.json'
            request.write_text(json.dumps({'operation': operation, 'adapter': adapter, 'contentType': content_type, 'prompts': prompts}), encoding='utf-8')
            response = folder / 'response.bin'
            with (OUTPUT / (identifier + '.log')).open('w', encoding='utf-8') as log:
                result = subprocess.run([str(runtime), str(root / 'tools/creator_segmentation_worker.py'),
                    '--request', str(request), '--output', str(response)], cwd=root, env=environment,
                    stdout=log, stderr=subprocess.STDOUT, timeout=150,
                    creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            report['returnCode'] = result.returncode
            if result.returncode or not response.is_file():
                raise ValueError('Local segmentation failed; retained worker log')
            meta = json.loads(response.with_suffix('.meta.json').read_text(encoding='utf-8'))
            payload = response.read_bytes()
            if len(payload) > 128 * 1024 * 1024 or meta['contentType'] not in ('application/json; charset=utf-8', 'application/zip'):
                raise ValueError('Invalid segmentation response')
            report.update(status=meta['status'], responseSha256=hashlib.sha256(payload).hexdigest(), workerSha256=PINS)
        return meta['status'], payload, meta['contentType']
    except (OSError, ValueError, KeyError, subprocess.TimeoutExpired) as error:
        report.update(status=503, error=str(error)[:240])
        return 503, json.dumps({'ready': False, 'error': 'segmentation-unavailable', 'detail': report['error']}).encode(), 'application/json'
    finally:
        report['seconds'] = round(time.perf_counter() - started, 3)
        try:
            (OUTPUT / (identifier + '.json')).write_text(json.dumps(report, indent=2), encoding='utf-8')
        finally:
            LOCK.release()
