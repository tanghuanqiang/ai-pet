# Five-state adapter contract

| State | Meaning |
| --- | --- |
| `started` | A task or explicitly identified turn has begun. |
| `running` | The tool reports ongoing execution or observed activity. |
| `finished` | The identified task/turn ended; this does not claim success. |
| `paused` | The tool explicitly paused or interrupted execution. |
| `needs-user` | The tool explicitly requests a reply, confirmation, or permission. |

Emit with `AIPetDesktop.exe --ai-event TOOL SESSION STATE` or the PowerShell wrapper. Call `--ai-connect TOOL SESSION` first. Configure slots with `--ai-bind STATE SLOT`; read `--ai-status ABSOLUTE_OUTPUT_JSON` for available slots and connection. Disconnect with `--ai-disconnect`.

The receiver accepts only matching tool/session IDs, unique event IDs and fresh timestamps (10 seconds). Each event is bounded local JSON under the configured data directory. Hidden pets and quiet hours suppress playback. An unavailable mapped action is reported as unavailable rather than replaced with another motion. Already-delivered events are not replayed merely because the pet becomes visible.

The built-in Codex watcher uses observed local lifecycle metadata. `task_started` can trigger started; observed tool activity can trigger running; an observed turn end is not success or proof that a larger goal finished. A Hook `Stop` alone remains unknown and is not promoted to successful task completion. PermissionRequest means a tool permission request, not every kind of user wait. Do not infer thinking, emotions, result quality or missing states from silence.

Other tools can use the same five states through their own lifecycle hooks or wrapper. Do not invent tool-specific hook event names or alter external tool configuration until its actual supported interface is known. User-defined animations are independent of these five states: the states select animations; they do not limit what animations users can create.
