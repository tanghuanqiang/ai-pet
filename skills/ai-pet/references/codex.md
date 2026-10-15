# Codex connection

Use the wrapper in the checkout or installed release; pass the same `-Executable` and `-DataDirectory` consistently if specified. Run from the real Codex session:

```powershell
.\tools\ai-pet.ps1 -Action codex-connect
.\tools\ai-pet.ps1 -Action codex-install
.\tools\ai-pet.ps1 -Action codex-status
.\tools\ai-pet.ps1 -Action status
```

`codex-connect` reads `CODEX_THREAD_ID`, or accepts an explicit `-Session`. Never bind a guessed most-recent session. It stores a session hash. For an existing Codex Desktop session it also records a validated local transcript location and starts at the file's current end. The local reader is experimental because the transcript format is not a stable integration interface. Selecting another tool or disconnecting clears that selection.

`codex-install` registers six observer events in `CODEX_HOME/hooks.json` (default `~/.codex/hooks.json`). It preserves other hooks and metadata, makes backups of replaced JSON, and is idempotent. `-CodexHome` selects an isolated Codex configuration when needed. Prepare and test before modifying a real configuration; the user's request to connect Codex authorizes the relevant setup, but not changing unrelated settings. Codex requires the user to review and trust the exact hook definition. Tell the user to review it in Codex (`/hooks` in the CLI); never edit Codex's trust records or claim trust from registration alone. Official reference: https://learn.chatgpt.com/docs/hooks

| Codex signal | Pet state |
| --- | --- |
| UserPromptSubmit / local task_started | started |
| PreToolUse, PostToolUse / observed local tool completion | running |
| Stop / local task_complete | finished (turn ended, outcome unknown) |
| Interrupt / local turn_aborted with interrupted reason | paused |
| PermissionRequest | needs-user (permission only) |

Ordinary text questions are not automatically detected. Source silence does not mean pause or completion. The observer emits no decisions or model context. It discards prompts, tool inputs and outputs, and only enqueues fresh state events for the bound session. Hidden pets and quiet hours suppress animation; running loops until a new state or disconnection. New hooks apply according to Codex's own loading/trust behavior; do not promise the active turn already loaded them.

`codex-status` checks registration, not runtime trust or event delivery. Verify real delivery with `status` after actual lifecycle activity. The repository smoke test uses documented-format fixtures and does not by itself establish real Codex integration acceptance.

Disconnect with `-Action disconnect`. Remove only this adapter's hook groups with `-Action codex-remove`; unrelated hooks remain. Removal is separate from disconnect so the user can reconnect later without registering again.
