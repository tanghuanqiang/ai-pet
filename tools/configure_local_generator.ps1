param(
    [Parameter(Mandatory=$true)][string]$Python,
    [Parameter(Mandatory=$true)][string]$ComfyDirectory,
    [Parameter(Mandatory=$true)][string]$ComfyPython,
    [Parameter(Mandatory=$true)][string]$WanModelDirectory,
    [Parameter(Mandatory=$true)][string]$MattingModelDirectory,
    [string]$QwenModelDirectory, [string]$DataDirectory, [string]$Executable
)
$ErrorActionPreference = 'Stop'
if (-not $DataDirectory) { $DataDirectory = $env:AI_PET_DATA_DIR }
if (-not $DataDirectory) { $DataDirectory = Join-Path $env:LOCALAPPDATA 'AI Pet Studio' }
foreach ($path in @($Python,$ComfyDirectory,$ComfyPython,$WanModelDirectory,$MattingModelDirectory,$DataDirectory)) {
    if (-not [IO.Path]::IsPathRooted($path)) { throw '请提供程序和模型的绝对路径。' }
}
foreach ($file in @($Python,$ComfyPython,(Join-Path $ComfyDirectory 'main.py'),(Join-Path $MattingModelDirectory 'config.json'))) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "缺少本地依赖：$file" }
}
foreach ($name in @('wan2.2_ti2v_5B_fp16.safetensors','umt5_xxl_fp8_e4m3fn_scaled.safetensors','wan2.2_vae.safetensors')) {
    if (-not (Test-Path -LiteralPath (Join-Path $WanModelDirectory $name) -PathType Leaf)) { throw "缺少本地模型：$name" }
}
$maxReferences = 1
if ($QwenModelDirectory) {
    if (-not [IO.Path]::IsPathRooted($QwenModelDirectory)) { throw 'Qwen 模型目录必须使用绝对路径。' }
    foreach ($name in @('qwen-image-edit-2509-Q4_K_M.gguf','qwen_2.5_vl_7b_fp8_scaled.safetensors','qwen_image_vae.safetensors')) {
        $found = @(Get-ChildItem -LiteralPath $QwenModelDirectory -Recurse -File -Filter $name)
        if ($found.Count -ne 1) { throw "Qwen 模型缺失或重复：$name" }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $ComfyDirectory 'custom_nodes\ComfyUI-GGUF') -PathType Container)) { throw '多图生成需要本机已有的 ComfyUI-GGUF。' }
    $maxReferences = 3
}
& $Python -c "import torch, torchvision, transformers, PIL; assert torch.cuda.is_available(), 'CUDA unavailable'; print('Local matting runtime ready')"
if ($LASTEXITCODE -ne 0) { throw '生成器 Python 环境缺少 GPU 抠图依赖。' }
& $ComfyPython -c "import torch; assert torch.cuda.is_available(), 'CUDA unavailable'; print('Local animation runtime ready')"
if ($LASTEXITCODE -ne 0) { throw 'ComfyUI Python 环境不可用。' }
New-Item -ItemType Directory -Path $DataDirectory -Force | Out-Null
$utf8 = New-Object Text.UTF8Encoding($false)
$backendPath = Join-Path ([IO.Path]::GetFullPath($DataDirectory)) 'local-generation-models.json'
if (Test-Path -LiteralPath $backendPath) { Copy-Item -LiteralPath $backendPath -Destination ($backendPath + '.' + [guid]::NewGuid().ToString('N') + '.bak') }
$backend = @{ comfyDirectory=[IO.Path]::GetFullPath($ComfyDirectory); comfyPython=[IO.Path]::GetFullPath($ComfyPython);
    wanModelDirectory=[IO.Path]::GetFullPath($WanModelDirectory); mattingModelDirectory=[IO.Path]::GetFullPath($MattingModelDirectory); frames=49; steps=24 }
if ($QwenModelDirectory) { $backend.qwenModelDirectory = [IO.Path]::GetFullPath($QwenModelDirectory) }
[IO.File]::WriteAllText($backendPath, ($backend | ConvertTo-Json), $utf8)
$config = @{ version=1; name='Wan 本地动画'; executable=[IO.Path]::GetFullPath($Python); workingDirectory=$PSScriptRoot;
    arguments=@((Join-Path $PSScriptRoot 'generate_pet_comfy.py'),'--request','{request}','--output','{output}','--progress','{progress}','--config',$backendPath);
    timeoutSeconds=3600; maxReferences=$maxReferences; dataHandling='图片与描述仅在本机模型中处理' }
$temporary = Join-Path $DataDirectory ('generator-setup-' + [guid]::NewGuid().ToString('N') + '.json')
try {
    [IO.File]::WriteAllText($temporary, ($config | ConvertTo-Json -Depth 5), $utf8)
    $options = @{ Action='configure-generation'; GeneratorConfig=$temporary; DataDirectory=$DataDirectory }
    if ($Executable) { $options.Executable=$Executable }
    & (Join-Path $PSScriptRoot 'ai-pet.ps1') @options
} finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary } }
Write-Output "本地生成器已配置，支持 $maxReferences 张参考图片。回到自定义页面即可生成。"
