"""Exercise the registered Codex observer command against an isolated desktop process.

Uses documented-format hook inputs and a local-rollout fixture, not a real Codex turn.
No real Codex configuration or task transcripts are changed.
"""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import subprocess
import time
import uuid


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--executable', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--wrapper', type=Path)
    args = parser.parse_args()
    root = Path(__file__).absolute().parents[1]
    output = args.output.absolute()
    output.mkdir(parents=True, exist_ok=False)
    data = output / 'data'; home = output / 'codex'
    data.mkdir(); home.mkdir()
    env = dict(os.environ, AI_PET_DATA_DIR=str(data), CODEX_HOME=str(home))
    wrapper = args.wrapper.absolute() if args.wrapper else root / 'tools/ai-pet.ps1'
    exe = str(args.executable.absolute())
    def command(action, *extra):
        return subprocess.run(['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(wrapper),
                               '-Executable', exe, '-DataDirectory', str(data), '-Action', action, *extra],
                              env=env, check=True, capture_output=True, timeout=30)
    sentinel = {'hooks': [{'type': 'command', 'command': 'echo keep-user-hook'}]}
    original = {'description': 'keep-user-metadata', 'hooks': {'Stop': [sentinel]}}
    hookpath = home / 'hooks.json'
    hookpath.write_text(json.dumps(original), encoding='utf-8')
    for _ in range(2):
        command('codex-install', '-CodexHome', str(home))
    config = json.loads(hookpath.read_text(encoding='utf-8-sig'))
    assert config['description'] == original['description']
    assert config['hooks']['Stop'][0] == sentinel and len(config['hooks']['Stop']) == 2
    assert all(len(config['hooks'][event]) == 1 for event in config['hooks'] if event != 'Stop')
    registered = json.loads(command('codex-status', '-CodexHome', str(home)).stdout)
    assert registered['registered']
    observer = config['hooks']['UserPromptSubmit'][0]['hooks'][0]['command'].split()
    sid = str(uuid.uuid4())
    command('codex-connect', '-Session', sid)
    runtime = subprocess.Popen([exe], env=env)
    reports = []
    def snapshot():
        try:
            return json.loads((data / 'ai-status.json').read_text(encoding='utf-8-sig'))
        except (FileNotFoundError, PermissionError, json.JSONDecodeError):
            return {}
    def wait_state(state, slot=None):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            assert runtime.poll() is None, 'desktop exited'
            status = snapshot()
            if status.get('lastState') == state and status.get('lastOutcome') == 'played':
                if slot is None or status.get('activeSlot') == slot:
                    return status
            time.sleep(.1)
        raise AssertionError((state, slot, snapshot()))
    def hook(event, session=sid):
        result = subprocess.run(observer, input=json.dumps({'hook_event_name': event, 'session_id': session,
                                'cwd': str(root), 'turn_id': str(uuid.uuid4()), 'prompt': 'PRIVATE-PROMPT-MUST-NOT-PERSIST',
                                'tool_input': {'command': 'PRIVATE-TOOL-MUST-NOT-PERSIST'}}).encode(),
                                env=env, capture_output=True, timeout=10)
        assert result.returncode == 0 and not result.stdout and not result.stderr, result
    try:
        for event, state in [('UserPromptSubmit','started'),('PreToolUse','running'),
                             ('PostToolUse','running'),('PermissionRequest','needs-user'),('Stop','finished'),('Interrupt','paused')]:
            hook(event)
            reports.append(wait_state(state))
        command('bind', '-State', 'finished', '-Slot', 'click')
        hook('Stop'); wait_state('finished', 'click')
        count = len(list((data / 'ai-events').glob('*.json')))
        hook('PermissionRequest', str(uuid.uuid4()))
        assert len(list((data / 'ai-events').glob('*.json'))) == count
        hook('PreToolUse'); wait_state('running', 'recent-activity')
        time.sleep(5)
        assert snapshot()['activeSlot'] == 'recent-activity', snapshot()
        command('disconnect')
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and snapshot().get('tool') is not None:
            time.sleep(.1)
        # A disconnected runtime is queried through the CLI (no stale live snapshot accepted).
        status = json.loads(command('status').stdout)
        assert status['tool'] is None
        count = len(list((data / 'ai-events').glob('*.json')))
        hook('PreToolUse')
        assert len(list((data / 'ai-events').glob('*.json'))) == count
        # Desktop metadata lookup and incremental lifecycle playback use the same bindings.
        desktopid = str(uuid.uuid4()); turn = str(uuid.uuid4())
        sessions = home / 'sessions' / '2026' / '10' / '16'; sessions.mkdir(parents=True)
        rollout = sessions / ('rollout-2026-10-16T00-00-00-' + desktopid + '.jsonl')
        rollout.write_text(json.dumps({'type': 'session_meta', 'payload': {'id': desktopid, 'cwd': str(root), 'originator': 'Codex Desktop'}}) + '\n', encoding='utf-8')
        command('codex-connect', '-Session', desktopid)
        time.sleep(1)
        for kind, state in [('task_started','started'),('turn_aborted','paused'),('task_complete','finished')]:
            record = {'timestamp': '2026-10-16T00:00:00Z', 'type': 'event_msg', 'payload': {'type': kind, 'turn_id': turn, 'reason': 'interrupted'}}
            with rollout.open('a', encoding='utf-8') as stream:
                stream.write(json.dumps(record, separators=(',', ':')) + '\n')
            wait_state(state, 'click' if state == 'finished' else None)
        for path in (data / 'ai-events').glob('*.json'):
            text = path.read_text(encoding='utf-8')
            assert 'PRIVATE-' not in text and sid not in text
        command('codex-remove', '-CodexHome', str(home))
        assert json.loads(hookpath.read_text(encoding='utf-8-sig')) == original
        result = {'passed': True, 'inputSource': 'documented-format fixtures', 'fiveStates': reports,
                  'customFinishMapping': True, 'runningPersists': True, 'foreignSessionIgnored': True,
                  'disconnectedIgnoresHooks': True, 'desktopLifecycleMapping': True,
                  'unrelatedHooksPreserved': True, 'reinstallIdempotent': True, 'privatePayloadDiscarded': True}
        (output / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({'passed': True, 'result': str(output / 'result.json')}))
    finally:
        runtime.terminate(); runtime.wait(timeout=10)


if __name__ == '__main__':
    main()
