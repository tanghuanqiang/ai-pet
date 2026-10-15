# Codex connection

## Desktop app: default connection

For a user working in the Codex desktop app, connect the actual desktop session first. Do not require them to switch to the CLI or configure Hooks for ordinary desktop use. Use the wrapper in the checkout or installed release; pass the same `-Executable` and `-DataDirectory` consistently if specified. Run from the real Codex session:

```powershell
.\tools\ai-pet.ps1 -Action codex-connect
.\tools\ai-pet.ps1 -Action status
```

`codex-connect` reads `CODEX_THREAD_ID`, or accepts an explicit `-Session`. Never bind a guessed most-recent session. It stores a session hash. For an existing Codex Desktop session it also records a validated local transcript location and starts at the file's current end. The local reader is experimental because the transcript format is not a stable integration interface. Selecting another tool or disconnecting clears that selection.

This route observes task start, tool activity, turn completion, explicit interruption and successfully displayed desktop input requests. The input-request compatibility reader matches the observed `request_user_input_async` call to its own `accepted: true` result, using only fresh records in the selected session. It ignores failed/unmatched requests, ordinary text and replayed results. It does not reliably observe permission prompts or ordinary follow-up questions. Explain those limits without presenting optional Hook trust as a prerequisite for the desktop connection. `status.codexDesktop` reports the reader's supported input sources; older executables without that field do not establish this support.

## Optional Hooks

Hooks add another lifecycle source, including permission requests. Configure them only when the user wants this integration and can review the definitions in a supported client:

```powershell
.\tools\ai-pet.ps1 -Action codex-install
.\tools\ai-pet.ps1 -Action codex-status
```

`codex-install` registers six observer events in `CODEX_HOME/hooks.json` (default `~/.codex/hooks.json`). It preserves other hooks and metadata, makes backups of replaced JSON, and is idempotent. `-CodexHome` selects an isolated Codex configuration when needed. Prepare and test before modifying a real configuration; the user's request to connect Codex authorizes the relevant setup, but not changing unrelated settings. Codex requires the user to review and trust the exact hook definition. Tell the user to review it in Codex (`/hooks` in the CLI); never edit Codex's trust records or claim trust from registration alone. Official reference: https://learn.chatgpt.com/docs/hooks

The official reference documents `/hooks` in the CLI. A desktop trust-review entry point has not been verified for this project; do not invent a desktop Settings path or assume typing the CLI command in a desktop conversation performs that review. Keep desktop session reading usable while optional Hooks await review.

| Codex signal | Pet state |
| --- | --- |
| UserPromptSubmit / local task_started | started |
| PreToolUse, PostToolUse / observed local tool completion | running |
| Stop / local task_complete | finished (turn ended, outcome unknown) |
| Interrupt / local turn_aborted with interrupted reason | paused |
| PermissionRequest | needs-user (permission only) |
| Desktop `request_user_input_async` with matching successful display acknowledgement | needs-user (explicit input request) |

Ordinary text questions are not automatically detected. An asynchronous input prompt is an attention signal, not proof that all work has stopped; later task/tool activity may return the pet to running. Source silence does not mean pause or completion. The observer emits no decisions or model context. It discards prompts, tool inputs and outputs, and only enqueues fresh state events for the bound session. Hidden pets and quiet hours suppress animation; running loops until a new state or disconnection. New hooks apply according to Codex's own loading/trust behavior; do not promise the active turn already loaded them.

`codex-status` checks registration, not runtime trust or event delivery. Verify real delivery with `status` after actual lifecycle activity. The repository smoke test uses documented-format fixtures and does not by itself establish real Codex integration acceptance.

When upgrading an older AI-PET installation, `codex-install` also recognizes that installation's `codex-hook-registration.json`. It migrates only the exact legacy command matching the selected executable, recorded project and Codex directory, including the old `SessionEnd` observer. Unrelated hooks and handlers sharing a group are preserved. The old marker is kept for recovery and `hooks.json` is backed up. Changed hook definitions still require Codex's own review and trust; migration never edits trust records.

Disconnect with `-Action disconnect`. Remove only this adapter's hook groups with `-Action codex-remove`; unrelated hooks remain. Removal is separate from disconnect so the user can reconnect later without registering again.
