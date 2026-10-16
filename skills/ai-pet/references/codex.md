# Codex connection

## Desktop app: default connection

For a user working in the Codex desktop app, use automatic following when they want the pet to follow whichever local task is active. Do not require switching to the CLI or configuring Hooks. Use the wrapper in the checkout or installed release; pass the same `-Executable` and `-DataDirectory` consistently if specified:

```powershell
.\tools\ai-pet.ps1 -Action codex-auto
.\tools\ai-pet.ps1 -Action status
```

Automatic follow discovers up to 32 recent root desktop sessions from validated metadata and observes their explicit lifecycle/input events. File modification time alone is never treated as a running task. A newly started task takes over; interleaved tool activity does not repeatedly steal ownership. Explicitly displayed input requests have priority. Completion/interruption leaves a brief gesture before handing off to another observed active chat. The connection panel shows the current title and other active titles; pet/tray hover also identifies ownership. Duplicate titles include project/time context. `status.codexFollow` reports mode, active session fingerprints/states and the current fingerprint without persisting titles or task content.

This is a bounded local compatibility reader, not an attachment to the desktop host's app-server subscription. Initial discovery considers only the last two minutes of observed signals; five minutes without a new signal marks an active chat unconfirmed and lets the pet rest or follow another chat. It does not infer completion from silence. Long silent thinking, remote/cloud-only sessions, unsupported transcript formats, and sessions outside the scan limit may not be confirmed. Already-ended history is not replayed on startup. Ordinary prose questions and all permission states are not automatically covered.

Use `-Action codex-connect` in the actual session, or the panel's manual session picker, when the user wants a fixed chat. It disables automatic switching. Disconnect disables automatic follow too. New installations with no tool configuration start in automatic mode; upgrades preserve existing manual choices unless the user asks to enable automatic following.

`codex-connect` reads `CODEX_THREAD_ID`, or accepts an explicit `-Session`. Never manually pin a guessed most-recent session. It stores a session hash. For an existing Codex Desktop session it also records a validated local transcript location and starts at the file's current end. The local reader is experimental because the transcript format is not a stable integration interface. Selecting another tool or disconnecting clears that selection.

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

Ordinary text questions are not automatically detected. An asynchronous input prompt is an attention signal, not proof that all work has stopped. Automatic follow keeps that attention state until a new start, explicit Agent/Hook state update, terminal event or signal expiry; completion of the request's own tool call is not evidence of an answer. Source silence does not mean pause or completion. The observer emits no decisions or model context. It discards prompts, tool inputs and outputs, and only enqueues fresh state events for the bound session. Hidden pets and quiet hours suppress animation. New hooks apply according to Codex's own loading/trust behavior; do not promise the active turn already loaded them.

`codex-status` checks registration, not runtime trust or event delivery. Verify real delivery with `status` after actual lifecycle activity. The repository smoke test uses documented-format fixtures and does not by itself establish real Codex integration acceptance.

When upgrading an older AI-PET installation, `codex-install` also recognizes that installation's `codex-hook-registration.json`. It migrates only the exact legacy command matching the selected executable, recorded project and Codex directory, including the old `SessionEnd` observer. Unrelated hooks and handlers sharing a group are preserved. The old marker is kept for recovery and `hooks.json` is backed up. Changed hook definitions still require Codex's own review and trust; migration never edits trust records.

Disconnect with `-Action disconnect`. Remove only this adapter's hook groups with `-Action codex-remove`; unrelated hooks remain. Removal is separate from disconnect so the user can reconnect later without registering again.
## Agent-reported questions

When this actual Codex session is already connected, report an ordinary question immediately before asking the user:

```powershell
.\tools\ai-pet.ps1 -Action codex-event -State needs-user
```

The command uses `CODEX_THREAD_ID`, or an explicit `-Session`, and hashes it exactly as `codex-connect` does. It emits only a state event; it does not connect another session, change mappings, ask the question, or grant permission. After the user's reply, report `running` when resuming work. Use `started`, `finished` and `paused` only for states actually known to the Agent. `finished` means this turn ended, not that the whole objective succeeded.

This is explicitly **Agent-reported**, not a reliable host callback. It cannot observe a host approval that happens before the Agent can run the command, or a process crash. In automatic mode, report `running` after the answer so the attention state can clear without guessing from tool completions. Prefer verified native events when available. Never report a question on behalf of another session.

For read-only transport discovery, `tools/codex_desktop_probe.ps1 -CodexExecutable C:\absolute\codex.exe -Output C:\absolute\new-report.json` records sanitized process/transport metadata and checks the default control connection. It does not start a server or prove that an accessible server owns the existing desktop conversation.
