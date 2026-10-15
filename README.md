# AI-PET

一个能自定义、能连接 AI 工具的 Windows 桌面宠物。

- **自定义**：使用预设动作，导入宠物主题，或通过创作空间和自己的 Agent 用照片、Prompt 制作动作。
- **连接 AI 工具**：统一五种状态——开始、进行中、结束、暂停、需要回答或确认；每种状态可绑定不同动作。
- **简单操作**：宠物和托盘使用相同右键菜单；自定义、工具连接与设置集中在一个管理窗口。
- **Agent 使用**：[AI-PET Skill](skills/ai-pet/SKILL.md) 与 PowerShell 命令可用于安装、启动和配置，无需模拟点击托盘。

当前为开发预览版。内置“小麦”是源码绘制的插画宠物，不使用私人参考照片或外部模型。桌宠运行和预设动作不需要 Python、GPU 或云服务。

## 安装和启动

Windows 10/11，需 .NET Framework 4.x 桌面组件。

下载 Release ZIP，解压后让 Agent 执行 `install.ps1`，或直接运行 `AIPetDesktop.exe`。安装器默认保留已有用户作品与偏好，运行中的旧程序需要先从托盘退出。

从源码运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\ai-pet.ps1 -Action build
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\ai-pet.ps1 -Action start
```

公开构建生成在 `runtime/public-publish`，并在缺少网页示例图时生成插画示例。现有照片不会被覆盖。`runtime/build.ps1` 的默认路径保留历史本机参考图回归；公开源码使用 `-Public`。

## 连接自己的工具

```powershell
.\tools\ai-pet.ps1 -Action connect -Tool my-agent -Session task-42
.\tools\ai-pet.ps1 -Action event -Tool my-agent -Session task-42 -State started
.\tools\ai-pet.ps1 -Action event -Tool my-agent -Session task-42 -State running
.\tools\ai-pet.ps1 -Action bind -State finished -Slot click
.\tools\ai-pet.ps1 -Action status
.\tools\ai-pet.ps1 -Action disconnect
```

五个状态标识是 `started`、`running`、`finished`、`paused`、`needs-user`。动作从 `status` 返回的 `actions` 中选择。可用 `-Executable` 指定安装位置、`-DataDirectory` 指定隔离数据目录。

工具适配器须发送真实生命周期事件；Agent 也可报告自己的任务状态。通用协议不等于已适配所有 AI 工具。界面提供实验性本机 Codex 会话选择；未提供的状态不会从沉默或普通日志中猜测，结束也不代表成功。见[状态协议](skills/ai-pet/references/tool-events.md)。

## 自定义照片和 Prompt

右键 → 自定义宠物和动作，在同一个窗口选择 1–4 张图片并填写 Prompt，点击“保存给 Agent 制作”。让自己的 Agent 使用 AI-PET Skill 完成请求，再点击“查看 Agent 生成的动作”预览使用。请求和图片留在本机；这个按钮不会自行启动后台模型。

Agent 用 `-Action requests` 查询本地请求，用 `-Action result -RequestId ... -Theme ...` 提交生成的主题。已有主题也可直接导入。Skill 的实际生成能力来自用户 Agent 可调用的图像或动画工具。

折叠的“使用本机眨眼、歪头模板”提供可选创作空间。当前本机生成模板主要支持眨眼和歪头；任意 Prompt 的新动作需要支持该动作的生成后端或用户 Agent 的图像/动画能力。多张照片可保存为参考，现有本机模板读取主照片。填写文字或保存角色卡本身不代表已生成动画。

可选 Creator 需要独立安装 `tools/creator-requirements.txt` 中的 Python 依赖。配置本地模型后才启用相应生成路线，公开包不含权重或私有环境。来自用户图片的主题在使用前仍需预览确认。

## 数据和开源

连接、偏好和作品默认保存在 `%LOCALAPPDATA%/AI Pet Studio`。数据目录与程序安装目录分开；五状态接口不传任务正文。源码导出使用显式文件清单，排除私人照片、作品、日志、模型和虚拟环境。

原始项目代码使用 [MIT](LICENSE)；外部模型和依赖保留各自许可证，见 [第三方说明](THIRD-PARTY-NOTICES.md)。[实施计划](IMPLEMENTATION-PLAN.md)列出当前完成项和后续工作。
