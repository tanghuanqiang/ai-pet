# Optional automatic generation

The default route hands a saved request to the user's existing Agent: **交给我的 Agent 制作** copies exact request instructions, and the user pastes them into their conversation. The accompanying `agent-instructions.txt` also remains in the request directory. The Agent reads the request, uses its available generation tools, packages the frames and submits `result`; the native manager detects the candidate for preview. This does not require configuring a runner or installing local models.

Use the following optional integration when the user has an existing command-line generation tool. Keep executable paths and model setup in the Agent workflow. A configured runner is independent of the five AI task states. Verify the selected Agent's actual generation tools before configuring automation; a task-state adapter or a CLI that accepts reference images does not alone prove generation capability.

## Native command protocol

Use the same `-Executable` and `-DataDirectory` consistently. First query `status`: `generationProtocolVersion: 1` identifies support for this workflow, and `generator` reports a configured provider. An older executable without that field must be upgraded or rebuilt from current source before using these commands. `configure-generation -GeneratorConfig FILE` validates and stores a local JSON configuration:

```json
{
  "version": 1,
  "name": "My animation generator",
  "executable": "C:\\absolute\\path\\python.exe",
  "workingDirectory": "C:\\absolute\\path\\backend",
  "arguments": ["C:\\absolute\\path\\backend\\generate.py", "--request", "{request}", "--output", "{output}", "--progress", "{progress}"],
  "timeoutSeconds": 3600,
  "maxReferences": 4,
  "dataHandling": "Explain which provider receives the images and Prompt"
}
```

Resolve paths from actual installed tools; example paths are placeholders. The user must be able to see an accurate provider/data-handling description before generation. Never label a cloud service local. No secrets belong in command arguments; let the provider use its own credential mechanism.

The runner invokes the executable directly, without a shell. `{request}`, `{output}` and `{progress}` are whole argument placeholders. Prompt text stays in request JSON; never interpolate it into commands. The provider must read every declared reference, verify the saved SHA-256 values, honor the user's Prompt, and return a valid RGBA `.lotheme` containing `idle` plus the requested motion slots. Output is only a candidate requiring preview and user selection. Write optional progress JSON atomically as `{"message":"Generating…"}`; on failure write `{"error":"Readable failure reason"}` and exit nonzero. A successful exit with invalid output is still rejected.

The native worker bounds duration and local logs. Cancel/timeout terminates the configured process tree, including locally owned model servers. Each retry uses a new attempt directory; preserve failed attempts. A remote provider must implement its service's cancellation separately: terminating a local client does not cancel a remote job. The built-in local adapter starts its own loopback server and does not interrupt an existing shared ComfyUI service.

Agent commands:

```powershell
.\tools\ai-pet.ps1 -Action configure-generation -GeneratorConfig C:\absolute\generator.json
.\tools\ai-pet.ps1 -Action create -CreationSpec C:\absolute\creation.json
.\tools\ai-pet.ps1 -Action generate -RequestId REQUEST_ID
.\tools\ai-pet.ps1 -Action generation-status -RequestId REQUEST_ID
.\tools\ai-pet.ps1 -Action cancel-generation -RequestId REQUEST_ID
```

Creation spec is `{"photos":["C:\\absolute\\photo.jpg"],"prompt":"Requested pet and motion"}`. `create` returns the request ID and uses the same photo validation and copy/hash logic as the native interface. `generate` launches asynchronously; query that same request until ready/failed/cancelled/interrupted. A polling timeout is not a terminal outcome. An interrupted native worker is detected from its process ID, start time and executable, not an old lock file. Do not retry a live request.

## Bundled local adapter

`tools/configure_local_generator.ps1` configures existing local model installations. Supply actual absolute paths for `-Python` (CUDA torch/torchvision, transformers, Pillow and BiRefNet dependencies), `-ComfyDirectory`, `-ComfyPython`, `-WanModelDirectory`, `-MattingModelDirectory`, and optionally `-QwenModelDirectory`; also use `-Executable` / `-DataDirectory` when needed. It checks the environments and model paths before configuring the native runner. User photos are not sent to a cloud provider.

The adapter requires Wan 2.2 TI2V-5B fp16, its UMT5 encoder and VAE, plus the local BiRefNet model. Multi-reference anchors also require Qwen Image Edit 2509 Q4_K_M, its encoder/VAE and ComfyUI-GGUF. Its one-image route segments the original photo; its multi-image route conditions Qwen on every reference and the user Prompt before Wan animation. No model downloads run automatically. Check model/dependency licenses before installation or redistribution; repository MIT does not relicense them.

Inspect the resulting animation for identity, anatomy, requested motion and alpha on light/dark backgrounds. A model finishing, a valid package or an animated silhouette does not prove that the Prompt was followed. Keep unsuccessful candidates available for review/retry and report their actual limitation. Never approve them automatically.
