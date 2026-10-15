"""Native generator protocol/lifecycle regression with an explicitly non-AI fixture."""
from __future__ import annotations
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')


def fixture(args):
    request = json.loads(args.request.read_text(encoding='utf-8-sig'))
    write_json(args.output.parent / 'observed.json', request)
    mode = request['prompt']
    if mode in ('cancel', 'timeout', 'interrupt'):
        child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(3600)'], creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        write_json(args.output.parent / 'child.json', {'pid': child.pid})
        write_json(args.progress, {'message': 'fixture child is running'})
        time.sleep(3600)
    if mode == 'retry':
        marker = args.request.parent / 'fixture-first-failure'
        if not marker.exists():
            marker.write_text('preserve failure', encoding='utf-8')
            write_json(args.progress, {'error': 'fixture failure, retry allowed'})
            raise SystemExit(7)
    if mode == 'invalid': args.output.write_bytes(b'not a theme package')
    else: shutil.copyfile(args.theme, args.output)


def alive(pid):
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.OpenProcess.restype = ctypes.c_void_p
    handle = kernel.OpenProcess(0x1000, False, pid)
    if not handle: return False
    try:
        code = ctypes.c_ulong()
        return bool(kernel.GetExitCodeProcess(ctypes.c_void_p(handle), ctypes.byref(code))) and code.value == 259
    finally: kernel.CloseHandle(ctypes.c_void_p(handle))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--executable', type=Path); parser.add_argument('--root', type=Path)
    parser.add_argument('--provider', action='store_true'); parser.add_argument('--request', type=Path)
    parser.add_argument('--output', type=Path); parser.add_argument('--progress', type=Path); parser.add_argument('--theme', type=Path)
    args = parser.parse_args()
    if args.provider: fixture(args); return
    root = args.root.absolute(); root.mkdir(parents=True, exist_ok=False)
    install = root / "test pet's program"; install.mkdir()
    for name in ('AIPetDesktop.exe', 'reference-cat.jpg', 'public-default.lotheme'):
        shutil.copyfile(args.executable.parent / name, install / name)
    exe = install / 'AIPetDesktop.exe'; data = root / 'data'; data.mkdir()
    env = dict(os.environ, AI_PET_DATA_DIR=str(data))
    config = {'version': 1, 'name': 'Protocol fixture (not AI)', 'dataHandling': 'Local fixture only',
              'executable': sys.executable, 'workingDirectory': str(root), 'timeoutSeconds': 10, 'maxReferences': 4,
              'arguments': [str(Path(__file__).absolute()), '--provider', '--request', '{request}',
                            '--output', '{output}', '--progress', '{progress}', '--theme', str(install / 'public-default.lotheme')]}
    cfg = root / 'generator.json'; write_json(cfg, config)
    def command(*arguments, check=True):
        result = subprocess.run([str(exe), *map(str, arguments)], env=env, timeout=15)
        if check: assert result.returncode == 0, (arguments, result.returncode)
        return result.returncode
    command('--ai-generator-config', cfg)
    def create(prompt):
        spec = root / ('spec-' + str(time.time_ns()) + '.json'); result = spec.with_suffix('.result.json')
        write_json(spec, {'photos': [str(install / 'reference-cat.jpg')] * 4, 'prompt': prompt})
        command('--ai-create-request', spec, result)
        return json.loads(result.read_text(encoding='utf-8'))['id']
    def status(id):
        result = root / 'status.json'; command('--ai-generation-status', id, result)
        return json.loads(result.read_text(encoding='utf-8'))
    def wait(id, expected, timeout=25):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            state = status(id)
            if state['status'] in expected: return state
            time.sleep(.1)
        raise AssertionError((id, state))
    active = data / 'active-theme.lotheme'; shutil.copyfile(install / 'public-default.lotheme', active)
    original = hashlib.sha256(active.read_bytes()).hexdigest()
    checks = {}
    prompt = 'Wave, preserve all photos; literal $(whoami), `date`, "quotes", 中文 and newlines\nremain content.'
    successful = create(prompt); command('--ai-start-generation', successful)
    wait(successful, {'ready'})
    folder = data / 'creation-requests' / successful
    observed = json.loads(next(folder.glob('attempts/*/observed.json')).read_text(encoding='utf-8'))
    assert observed['prompt'] == prompt and len(observed['references']) == 4
    assert all(hashlib.sha256((folder / ref['path']).read_bytes()).hexdigest() == ref['sha256'] for ref in observed['references'])
    checks['allReferencesAndPromptPreserved'] = True
    checks['candidateRequiresPreview'] = hashlib.sha256(active.read_bytes()).hexdigest() == original
    invalid = create('invalid'); command('--ai-start-generation', invalid)
    assert wait(invalid, {'failed'})['status'] == 'failed'
    assert not (data / 'creation-requests' / invalid / 'candidate.lotheme').exists()
    checks['invalidOutputRejected'] = True
    retry = create('retry'); command('--ai-start-generation', retry)
    first = wait(retry, {'failed'}); assert 'fixture failure' in first['message']
    command('--ai-start-generation', retry); wait(retry, {'ready'})
    assert len(list((data / 'creation-requests' / retry / 'attempts').iterdir())) == 2
    checks['retryPreservesFailure'] = True
    for mode in ('cancel', 'timeout', 'interrupt'):
        id = create(mode); command('--ai-start-generation', id); current = wait(id, {'running'})
        folder = data / 'creation-requests' / id; childfile = folder / 'attempts' / current['attempt'] / 'child.json'
        deadline = time.monotonic() + 10
        while not childfile.exists() and time.monotonic() < deadline: time.sleep(.1)
        child = json.loads(childfile.read_text())['pid']; assert alive(child)
        assert command('--ai-start-generation', id, check=False) == 2, 'duplicate generation was accepted'
        if mode == 'cancel':
            command('--ai-cancel-generation', id); wait(id, {'cancelled'})
        elif mode == 'timeout': wait(id, {'failed'})
        else:
            # Terminate only this fixture's native worker to verify job-handle cleanup.
            worker = ctypes.WinDLL('kernel32').OpenProcess(1, False, current['pid'])
            assert worker
            ctypes.WinDLL('kernel32').TerminateProcess(worker, 1); ctypes.WinDLL('kernel32').CloseHandle(worker)
            wait(id, {'interrupted'})
        deadline = time.monotonic() + 5
        while alive(child) and time.monotonic() < deadline: time.sleep(.1)
        assert not alive(child), (mode, 'child left running', child)
        checks[mode + 'KillsDescendants'] = True
    assert hashlib.sha256(active.read_bytes()).hexdigest() == original
    checks['activePetPreserved'] = True
    write_json(root / 'result.json', {'passed': all(checks.values()), 'fixtureIsNotAI': True, 'checks': checks})
    print(json.dumps(checks))


if __name__ == '__main__': main()
