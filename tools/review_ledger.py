#!/usr/bin/env python3
"""Local, content-addressed rejection record shared by the video bridge and WPF."""

from __future__ import annotations

import hashlib
import json
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

FORMAT = "little-orbit.review-veto"
REASONS = frozenset({"identity", "motion", "anatomy", "crop", "edge"})
MAX_ENTRIES = 128
MAX_BYTES = 128 * 1024
HEX64 = re.compile(r"[a-f0-9]{64}\Z")
HEX32 = re.compile(r"[a-f0-9]{32}\Z")


def ledger_path() -> Path:
    override = os.environ.get("AI_PET_REVIEW_LEDGER")
    if override:
        path = Path(override).expanduser()
        if not path.is_absolute():
            raise ValueError("AI_PET_REVIEW_LEDGER must be absolute")
        return path.resolve()
    local_app_data = os.environ.get("LOCALAPPDATA")
    if not local_app_data:
        raise ValueError("LOCALAPPDATA is unavailable")
    return Path(local_app_data) / "AI Pet Studio" / "candidate-review-ledger.json"


def package_sha256(package: Path) -> str:
    digest = hashlib.sha256()
    with package.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _unique_pairs(pairs: list[tuple[str, object]]) -> dict[str, object]:
    output = {}
    for key, value in pairs:
        if key in output:
            raise ValueError("duplicate-ledger-key")
        output[key] = value
    return output


def read_ledger(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []
    if not path.is_file() or path.stat().st_size > MAX_BYTES:
        raise ValueError("invalid-review-ledger")
    value = json.loads(path.read_text(encoding="utf-8-sig"), object_pairs_hook=_unique_pairs)
    if not isinstance(value, dict) or set(value) != {"format", "version", "denied"} or value["format"] != FORMAT or type(value["version"]) is not int or value["version"] != 1:
        raise ValueError("invalid-review-ledger")
    denied = value["denied"]
    if not isinstance(denied, list) or len(denied) > MAX_ENTRIES:
        raise ValueError("invalid-review-ledger")
    seen = set()
    for item in denied:
        if (not isinstance(item, dict) or set(item) != {"sha256", "candidateId", "reason", "decidedAt"} or
                not isinstance(item["sha256"], str) or not HEX64.fullmatch(item["sha256"]) or
                not isinstance(item["candidateId"], str) or not HEX32.fullmatch(item["candidateId"]) or
                not isinstance(item["reason"], str) or item["reason"] not in REASONS or
                not isinstance(item["decidedAt"], str) or
                len(item["decidedAt"]) > 40 or item["sha256"] in seen):
            raise ValueError("invalid-review-ledger")
        try:
            datetime.fromisoformat(item["decidedAt"])
        except ValueError as error:
            raise ValueError("invalid-review-ledger") from error
        seen.add(item["sha256"])
    return denied


def decision_for(path: Path, package: Path) -> dict[str, str] | None:
    digest = package_sha256(package)
    return next((item for item in read_ledger(path) if item["sha256"] == digest), None)


def set_decision(path: Path, package: Path, candidate_id: str, reason: str | None) -> dict[str, object]:
    if not HEX32.fullmatch(candidate_id) or (reason is not None and reason not in REASONS):
        raise ValueError("invalid-review-decision")
    digest = package_sha256(package)
    entries = [item for item in read_ledger(path) if item["sha256"] != digest]
    if reason is not None:
        entries.append({"sha256": digest, "candidateId": candidate_id, "reason": reason,
                        "decidedAt": datetime.now(timezone.utc).isoformat(timespec="seconds")})
    if len(entries) > MAX_ENTRIES:
        raise ValueError("review-ledger-full")
    entries.sort(key=lambda item: item["sha256"])
    body = (json.dumps({"format": FORMAT, "version": 1, "denied": entries},
                       ensure_ascii=True, separators=(",", ":")) + "\n").encode("utf-8")
    if len(body) > MAX_BYTES:
        raise ValueError("review-ledger-full")
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with temporary.open("xb") as stream:
            stream.write(body)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
    return {"status": "needs-work" if reason else "pending", "reason": reason, "sha256": digest}
