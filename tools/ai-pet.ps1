param(
    [ValidateSet('start','status','connect','disconnect','event','bind','build','requests','result')][string]$Action = 'status',
    [string]$Tool, [string]$Session, [string]$State, [string]$Slot,
    [string]$Executable, [string]$DataDirectory, [string]$RequestId, [string]$Theme
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
if ($Action -eq 'build') {
    & (Join-Path $projectRoot 'runtime\build.ps1') -Public
    exit $LASTEXITCODE
}
if (-not $Executable) {
    $candidates = @((Join-Path $projectRoot 'AIPetDesktop.exe'), (Join-Path $projectRoot 'runtime\public-publish\AIPetDesktop.exe'), (Join-Path $projectRoot 'runtime\publish\AIPetDesktop.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\AI Pet Studio\AIPetDesktop.exe'))
    $Executable = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}
if (-not $Executable -or -not (Test-Path -LiteralPath $Executable -PathType Leaf)) { throw '未找到桌宠程序，请先构建或安装。' }
$Executable = [IO.Path]::GetFullPath($Executable)
$previousDataDirectory = $env:AI_PET_DATA_DIR
try {
    if ($DataDirectory) {
        if (-not [IO.Path]::IsPathRooted($DataDirectory)) { throw '数据目录必须是绝对路径。' }
        $env:AI_PET_DATA_DIR = $DataDirectory
    }
    if ($Action -eq 'start') {
        Start-Process -FilePath $Executable -WorkingDirectory (Split-Path $Executable -Parent) -WindowStyle Hidden | Out-Null
        Write-Output '已发送启动请求；用 status 查询能力和连接。'
        exit 0
    }
    $arguments = @()
    if ($Action -eq 'connect') { $arguments = @('--ai-connect', $Tool, $Session) }
    elseif ($Action -eq 'disconnect') { $arguments = @('--ai-disconnect') }
    elseif ($Action -eq 'event') { $arguments = @('--ai-event', $Tool, $Session, $State) }
    elseif ($Action -eq 'bind') { $arguments = @('--ai-bind', $State, $Slot) }
    elseif ($Action -eq 'result') {
        if ($RequestId -notmatch '\A[a-f0-9]{32}\z' -or -not (Test-Path -LiteralPath $Theme -PathType Leaf)) { throw '请提供创作编号和生成的主题包。' }
        $arguments = @('--ai-result', $RequestId, ('"' + [IO.Path]::GetFullPath($Theme) + '"'))
    }
    $statusFile = $null
    if ($Action -eq 'status' -or $Action -eq 'requests') {
        $statusFile = Join-Path ([IO.Path]::GetTempPath()) ('ai-pet-status-' + [Guid]::NewGuid().ToString('N') + '.json')
        $command = if ($Action -eq 'requests') { '--ai-requests' } else { '--ai-status' }
        $arguments = @($command, ('"' + $statusFile + '"'))
    } elseif ($Action -ne 'result') {
        foreach ($value in $arguments | Select-Object -Skip 1) {
            if ($value -notmatch '\A[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}\z') { throw '请提供合法的工具、会话、状态或动作标识。' }
        }
    }
    $process = Start-Process -FilePath $Executable -ArgumentList $arguments -Wait -PassThru -WindowStyle Hidden
    if ($process.ExitCode -ne 0) { throw "桌宠命令失败，退出码 $($process.ExitCode)。" }
    if ($statusFile) {
        Get-Content -LiteralPath $statusFile -Raw -Encoding UTF8
        Remove-Item -LiteralPath $statusFile
    } elseif ($Action -eq 'result') { Write-Output '候选已提交，请在桌宠中预览并选择使用。' }
    elseif ($Action -eq 'event') { Write-Output '已发送；仅由匹配工具和会话的运行中桌宠接收。' }
    else { Write-Output '配置已保存。' }
} finally { $env:AI_PET_DATA_DIR = $previousDataDirectory }
