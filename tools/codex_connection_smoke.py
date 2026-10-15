"""Exercise the registered Codex observer command against an isolated desktop process.

Uses documented-format hook inputs and a local-rollout fixture, not a real Codex turn.
No real Codex configuration or task transcripts are changed.
"""
from __future__ import annotations
import argparse
import base64
from datetime import datetime, timezone, timedelta
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
    mixed_sentinel = {'matcher': '*', 'hooks': [{'type': 'command', 'command': 'echo keep-mixed-hook'}]}
    original = {'description': 'keep-user-metadata', 'hooks': {'Stop': [sentinel], 'PreToolUse': [mixed_sentinel]}}
    hookpath = home / 'hooks.json'
    fixture = json.loads(json.dumps(original))
    legacy_script = "& '" + exe.replace("'", "''") + "' --codex-hook-relay '" + str(root).replace("'", "''") + "'"
    legacy_command = 'powershell.exe -NoProfile -NonInteractive -EncodedCommand ' + base64.b64encode(legacy_script.encode('utf-16le')).decode()
    legacy_handler = {'type': 'command', 'command': legacy_command, 'commandWindows': legacy_command, 'timeout': 3}
    for event in ('UserPromptSubmit','PreToolUse','PostToolUse','PermissionRequest','Stop','Interrupt','SessionEnd'):
        if event == 'PreToolUse': fixture['hooks'][event][0]['hooks'].append(legacy_handler)
        else: fixture['hooks'].setdefault(event, []).append({'hooks': [legacy_handler]})
    # Model an older installation without modifying an actual installation marker.
    legacy_marker = args.executable.absolute().parent / 'codex-hook-registration.json'
    if legacy_marker.exists(): raise AssertionError('use an isolated executable copy for legacy migration QA')
    legacy_marker.write_text(json.dumps({'productId': 'little-orbit.ai-pet-studio', 'version': 1,
        'codexHome': str(home), 'projectRoot': str(root), 'command': legacy_command}), encoding='utf-8')
    hookpath.write_text(json.dumps(fixture), encoding='utf-8')
    try:
        for _ in range(2):
            command('codex-install', '-CodexHome', str(home))
    finally:
        legacy_marker.unlink()
    config = json.loads(hookpath.read_text(encoding='utf-8-sig'))
    assert config['description'] == original['description']
    assert config['hooks']['Stop'][0] == sentinel and len(config['hooks']['Stop']) == 2
    assert config['hooks']['PreToolUse'][0] == mixed_sentinel and len(config['hooks']['PreToolUse']) == 2
    assert 'SessionEnd' not in config['hooks']
    assert all(len(config['hooks'][event]) == 1 for event in config['hooks'] if event not in ('Stop', 'PreToolUse'))
    assert legacy_command not in json.dumps(config)
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
        # Observed desktop async-input format: only the matching successful UI acknowledgement counts.
        def response(payload, timestamp=None, path=rollout):
            record = {'timestamp': timestamp or datetime.now(timezone.utc).isoformat(),
                      'type': 'response_item', 'payload': payload}
            with path.open('a', encoding='utf-8') as stream:
                stream.write(json.dumps(record, separators=(',', ':')) + '\n')
        def input_call(call, timestamp=None, path=rollout):
            response({'type': 'function_call', 'call_id': call, 'name': 'request_user_input_async',
                'arguments': '{"questions":[{"title":"PRIVATE-QUESTION-MUST-NOT-PERSIST"}]}',
                'internal_chat_message_metadata_passthrough': {'turn_id': turn}}, timestamp, path)
        def input_output(call, accepted=True, path=rollout):
            response({'type': 'function_call_output', 'call_id': call,
                      'output': json.dumps({'accepted': accepted})}, path=path)
        response({'type': 'message', 'role': 'assistant', 'content': [{'type':'output_text',
            'text': 'request_user_input_async accepted PRIVATE-QUESTION-MUST-NOT-PERSIST?'}]})
        input_call('call_failed'); input_output('call_failed', False)
        input_output('call_unknown')
        stale = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
        input_call('call_stale', stale); input_output('call_stale')
        foreign = sessions / ('rollout-2026-10-16T00-00-00-' + str(uuid.uuid4()) + '.jsonl')
        input_call('call_foreign', path=foreign); input_output('call_foreign', path=foreign)
        time.sleep(1.2)
        assert snapshot()['lastState'] == 'finished', snapshot()
        input_call('call_pending')
        time.sleep(.8)
        assert snapshot()['lastState'] == 'finished', 'a request attempt is not a displayed question'
        input_output('call_pending')
        needs_user = wait_state('needs-user', 'needs-user')
        # A duplicate result has no matching pending call and cannot enqueue another event.
        events = data / 'codex-events'
        count = len(list(events.glob('*.event.json')))
        input_output('call_pending')
        time.sleep(.8)
        assert len(list(events.glob('*.event.json'))) == count
        for path in events.glob('*.event.json'):
            assert 'PRIVATE-' not in path.read_text(encoding='utf-8')
        for path in (data / 'ai-events').glob('*.json'):
            text = path.read_text(encoding='utf-8')
            assert 'PRIVATE-' not in text and sid not in text
        command('codex-remove', '-CodexHome', str(home))
        assert json.loads(hookpath.read_text(encoding='utf-8-sig')) == original
        result = {'passed': True, 'inputSource': 'documented-format fixtures', 'fiveStates': reports,
                  'customFinishMapping': True, 'runningPersists': True, 'foreignSessionIgnored': True,
                  'disconnectedIgnoresHooks': True, 'desktopLifecycleMapping': True,
                  'unrelatedHooksPreserved': True, 'legacyHooksMigrated': True, 'mixedHookGroupPreserved': True,
                  'desktopDisplayedInput': needs_user, 'failedOrUnmatchedQuestionsIgnored': True,
                  'staleOrForeignQuestionsIgnored': True, 'ordinaryTextIgnored': True,
                  'reinstallIdempotent': True, 'privatePayloadDiscarded': True}
        (output / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({'passed': True, 'result': str(output / 'result.json')}))
    finally:
        runtime.terminate(); runtime.wait(timeout=10)


if __name__ == '__main__':
    main()
