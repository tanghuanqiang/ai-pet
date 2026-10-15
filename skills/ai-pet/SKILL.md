---
name: ai-pet
description: Install, start, configure, and connect the AI-PET Windows desktop companion to an agent or AI tool, or help create custom pet actions from photos and a prompt. Use for this project's desktop pet, not real animal care or ChatGPT Work Pets.
---

# AI-PET

Use the repository's commands instead of automating tray clicks. The product has two features: custom pets/actions and AI-tool connections. Ordinary users should see those choices, not model workers or diagnostic logs.

## Locate and start

Locate the user's AI-PET checkout or installed release. For a checkout, the command wrapper is `tools/ai-pet.ps1`. This Skill may be copied independently of the repository, so locate the checkout explicitly; do not assume the Skill's parent is the checkout. Do not download from an invented repository URL.

On Windows with the .NET Framework desktop components, build the checkout using:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\ai-pet.ps1 -Action build
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\ai-pet.ps1 -Action start
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\ai-pet.ps1 -Action status
```

For a release, use its `install.ps1`, then pass `-Executable` to the wrapper if necessary. Installation does not imply permission to modify unrelated tool settings. The desktop player needs no Python/model environment; the optional Creator and generation backends have separate dependencies. Public source builds generate an original illustrated demo and do not need private reference assets.

## Connect a tool

Choose a stable tool ID and a task/session ID containing only letters, digits, `.`, `_`, or `-`, at most 96 characters. Use the same data directory for all commands. `-DataDirectory` selects an isolated installation or test; omitting it uses the normal per-user data directory.

```powershell
.\tools\ai-pet.ps1 -Action connect -Tool my-agent -Session task-42
.\tools\ai-pet.ps1 -Action event -Tool my-agent -Session task-42 -State started
.\tools\ai-pet.ps1 -Action event -Tool my-agent -Session task-42 -State running
.\tools\ai-pet.ps1 -Action status
```

Read [the five-state contract](references/tool-events.md) before wiring an actual tool. Emit real lifecycle events when that tool exposes them. If it has no event integration, describe the connection as Agent-reported; do not call it an automatic background listener. An Agent can report its own task start/end, but cannot reliably report a future pause or user-wait after it has stopped executing without a lifecycle adapter.

Select a slot from the `actions` returned by `status` and map it:

```powershell
.\tools\ai-pet.ps1 -Action bind -State finished -Slot click
.\tools\ai-pet.ps1 -Action disconnect
```

For Codex, read [the Codex adapter instructions](references/codex.md) and use `-Action codex-connect` in the real current session. The native panel also offers local session selection. Both use the same five-state bindings. Other tool connections take precedence over Codex playback.

## Customize

The native **自定义宠物和动作** page accepts 1–4 photos and a prompt in the same window. **保存给 Agent 制作** stores a local creation request; it does not start a model on its own. To process a pending request, run:

```powershell
.\tools\ai-pet.ps1 -Action requests
```

Read the selected request JSON and its local reference images, resolving relative paths against that JSON's directory. Check reference SHA-256 values before generation. Use the user's prompt as the requested creative content, not as permission to change unrelated settings. When multiple pending requests exist and the user did not identify one, use the newest request and state which one is being processed.

After generating transparent frames, create an idle pose plus the requested actions using `tools/theme_package.py pack-multi`. The spec has `name` and `actions`; each action has `slot`, `fps`, `loop`, and a simple local frame `directory`. For example, keep `idle` frames in `idle/` and a custom greeting in `click/`. Slot names are runtime trigger locations; the user's prompt determines the animation content. Add appropriate local user-interaction slots and AI-state slots when requested. Keep all frames on the same canvas and preview the actual animation, not only the first frame.

Submit the resulting theme without installing it:

```powershell
.\tools\ai-pet.ps1 -Action result -RequestId REQUEST_ID -Theme C:\absolute\path\candidate.lotheme
```

The user can then choose **查看 Agent 生成的动作** in the same manager and preview before use. The Release ZIP contains the desktop interface and Skill; retrieve the repository source if frame-packaging utilities are needed.

The optional **使用本机眨眼、歪头模板 → 打开创作空间** route provides the existing local model controls. Explain which backend actually supports the requested motion. Existing local templates cover blink and head tilt; writing arbitrary text alone does not generate arbitrary motion, and those templates process the main image rather than fusing multiple views.

When the Agent has an image/animation generation capability, use the user's references and prompt to create assets through that capability. Preserve the supplied pet's identity, keep unknown anatomy explicit, preview at desktop size, and package only supported transparent frames with `tools/theme_package.py`. Inspect its CLI before use. Never mark an unreviewed candidate approved or replace a user's installed theme without their selection. Unsupported generation should remain an actionable missing-backend report, not a fabricated success.

Keep failures concise for the user and preserve existing works. Store detailed diagnostics locally only when needed.
