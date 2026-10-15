"""Record only bounded Codex lifecycle evidence for the local desktop pet.

Use as an optional Codex command hook. It never prints hook output, changes an
approval decision, or saves prompts, tool arguments, responses, or transcripts.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import uuid


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_EVENT_DIR = ROOT / "runtime" / "publish" / "codex-events"
SUPPORTED_EVENTS = {
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PermissionRequest",
    "Stop",
    "Interrupt",
    "SessionEnd",
}
MAX_INPUT_BYTES = 2 * 1024 * 1024
MAX_QUEUED_EVENTS_PER_SESSION = 256
QUEUE_RETENTION_SECONDS = 10 * 60


def write_atomic_json(target: Path, record: dict[str, object], event_dir: Path) -> None:
    descriptor, temporary = tempfile.mkstemp(prefix=".codex-event-", suffix=".tmp", dir=event_dir)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(record, handle, separators=(",", ":"))
            handle.write("\n")
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def record_event(payload: object, event_dir: Path = DEFAULT_EVENT_DIR) -> Path | None:
    if not isinstance(payload, dict):
        return None
    event = payload.get("hook_event_name")
    session = payload.get("session_id")
    cwd = payload.get("cwd")
    if event not in SUPPORTED_EVENTS or not isinstance(session, str) or not (1 <= len(session) <= 128):
        return None
    if not isinstance(cwd, str):
        return None
    try:
        session_cwd = Path(cwd).resolve(strict=True)
        session_cwd.relative_to(ROOT)
    except (OSError, ValueError):
        return None
    session_hash = hashlib.sha256(session.encode("utf-8")).hexdigest()
    record = {
        "version": 1,
        "eventId": uuid.uuid4().hex,
        "observedAtMs": int(time.time() * 1000),
        "event": event,
        "session": session_hash,
    }
    event_dir.mkdir(parents=True, exist_ok=True)
    queued = event_dir / f"{session_hash}.{record['observedAtMs']:013d}.{record['eventId']}.event.json"
    write_atomic_json(queued, record, event_dir)
    write_atomic_json(event_dir / f"{session_hash}.json", record, event_dir)
    queued_files = sorted(event_dir.glob(f"{session_hash}.*.event.json"))
    expiry_ms = record["observedAtMs"] - QUEUE_RETENTION_SECONDS * 1000
    for old in queued_files:
        try:
            timestamp_ms = int(old.name.split(".", 2)[1])
            if timestamp_ms < expiry_ms:
                old.unlink(missing_ok=True)
        except (OSError, ValueError):
            continue
    queued_files = sorted(event_dir.glob(f"{session_hash}.*.event.json"))
    for old in queued_files[:-MAX_QUEUED_EVENTS_PER_SESSION]:
        try:
            old.unlink(missing_ok=True)
        except OSError:
            continue
    return queued


def main() -> None:
    try:
        data = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        if len(data) > MAX_INPUT_BYTES:
            return
        payload = json.loads(data.decode("utf-8"))
        override = os.environ.get("AI_PET_EVENT_DIR")
        event_dir = Path(override).resolve() if override and Path(override).is_absolute() else DEFAULT_EVENT_DIR
        record_event(payload, event_dir)
    except (OSError, ValueError, UnicodeError, TypeError):
        pass  # A pet must not affect Codex's lifecycle or approval flow.


if __name__ == "__main__":
    main()
