# Third-party components and private reference assets

The MIT license in this repository applies to original project code. It does not relicense external models, dependencies, reference photographs, generated works, or vendored code.

- Windows desktop playback uses the installed .NET Framework WPF / Windows Forms components.
- The optional Creator uses Python dependencies listed in `tools/creator-requirements.txt` and `tools/matting-requirements.txt`; those dependencies retain their own licenses.
- BiRefNet, SAM2, LivePortrait Animals and their dependencies are optional generation backends. Consult each original project's model/code licenses before installing or distributing it. No weights or environments are included in the source release.
- The optional local generation adapter uses ComfyUI, Wan 2.2 TI2V-5B, and optionally Qwen Image Edit 2509 with ComfyUI-GGUF. They retain their upstream licenses. This repository ships adapter code only, without those tools, weights, custom nodes or Python environments.
- The local X-Pose route and experimental face-landmark models have non-commercial restrictions recorded in the local experiment documentation. They are not approved for commercial redistribution by this project's MIT license.
- Local cat photographs, inferred reference-cat themes, works and QA records are excluded from public exports. `runtime/build.ps1 -Public` generates an original illustration from project code; public source builds do not require these private reference assets.
