param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Programs\AI Pet Studio'),
    [string]$ShortcutRoot = (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\AI Pet Studio'),
    [switch]$NoShortcut, [switch]$Start
)
$ErrorActionPreference = 'Stop'
$packageRoot = $PSScriptRoot
$manifest = Get-Content -LiteralPath (Join-Path $packageRoot 'public-package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$destination = [IO.Path]::GetFullPath($InstallRoot)
if ($destination.TrimEnd('\') -eq [IO.Path]::GetPathRoot($destination).TrimEnd('\')) { throw '请选择应用安装目录。' }
$verified = @()
foreach ($file in $manifest.files) {
    $relative = [string]$file.path
    if ($relative -notmatch '\A[A-Za-z0-9_./ -]+\z' -or $relative.Split('/') -contains '..' -or [IO.Path]::IsPathRooted($relative)) { throw '安装清单路径无效。' }
    $source = Join-Path $packageRoot $relative
    if (-not (Test-Path -LiteralPath $source -PathType Leaf) -or (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256) { throw "安装文件校验失败：$relative" }
    $target = [IO.Path]::GetFullPath((Join-Path $destination $relative))
    if (-not $target.StartsWith($destination.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '安装目标越界。' }
    $verified += @{ Source = $source; Target = $target; Relative = $relative }
}
if (-not ($verified | Where-Object { $_.Relative -eq 'AIPetDesktop.exe' })) { throw '安装包缺少桌宠程序。' }
$running = Get-Process -Name AIPetDesktop -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq (Join-Path $destination 'AIPetDesktop.exe') }
if ($running) { throw '请先从托盘退出当前桌宠，再重新安装。你的宠物和动作会保留。' }
New-Item -ItemType Directory -Path $destination -Force | Out-Null
$existing = Join-Path $destination 'AIPetDesktop.exe'
if (Test-Path -LiteralPath $existing) { Copy-Item -LiteralPath $existing -Destination (Join-Path $destination 'AIPetDesktop.previous.exe') -Force }
foreach ($file in $verified) {
    New-Item -ItemType Directory -Path (Split-Path $file.Target -Parent) -Force | Out-Null
    Copy-Item -LiteralPath $file.Source -Destination $file.Target -Force
}
Copy-Item -LiteralPath (Join-Path $packageRoot 'public-package.json') -Destination (Join-Path $destination 'public-package.json') -Force
if (-not $NoShortcut) {
    New-Item -ItemType Directory -Path $ShortcutRoot -Force | Out-Null
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut((Join-Path $ShortcutRoot 'AI Pet Studio.lnk'))
    $shortcut.TargetPath = Join-Path $destination 'AIPetDesktop.exe'; $shortcut.WorkingDirectory = $destination; $shortcut.Save()
}
if ($Start) { Start-Process -FilePath (Join-Path $destination 'AIPetDesktop.exe') -WindowStyle Hidden }
Write-Output "Installed AI-PET $($manifest.version): $destination"
