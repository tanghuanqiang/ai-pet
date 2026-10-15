param([string]$Executable, [string]$OutputRoot = (Join-Path (Split-Path $PSScriptRoot -Parent) 'generated\simple-experience-qa-20261016\live-v1'))
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$exe = if ($Executable) { [IO.Path]::GetFullPath($Executable) } else { Join-Path $projectRoot 'runtime\publish\AIPetDesktop.exe' }
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
$dataRoot = Join-Path $OutputRoot 'user-data'
New-Item -ItemType Directory -Path $dataRoot -Force | Out-Null
$previousDirectory = $env:AI_PET_DATA_DIR
$env:AI_PET_DATA_DIR = $dataRoot
$runtime = $null
$wrapper = Join-Path $PSScriptRoot 'ai-pet.ps1'
function Wait-PetState([string]$Expected) {
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        $path = Join-Path $dataRoot 'ai-status.json'
        if (Test-Path -LiteralPath $path) {
            try {
                $snapshot = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
                if ($snapshot.lastState -eq $Expected -and $snapshot.lastOutcome -eq 'played') { return $snapshot }
            } catch { }
        }
        if ($runtime.HasExited) { throw "桌宠提前退出：$($runtime.ExitCode)" }
        Start-Sleep -Milliseconds 100
    }
    throw "未观察到状态 $Expected 的实际播放。"
}
try {
    & $wrapper -Executable $exe -Action connect -Tool qa-agent -Session qa-task | Out-Null
    $runtime = Start-Process -FilePath $exe -WindowStyle Hidden -PassThru
    $reports = @()
    foreach ($state in @('started','running','finished','paused','needs-user')) {
        & $wrapper -Executable $exe -Action event -Tool qa-agent -Session qa-task -State $state | Out-Null
        $reports += Wait-PetState $state
    }
    & $wrapper -Executable $exe -Action bind -State finished -Slot click | Out-Null
    & $wrapper -Executable $exe -Action event -Tool qa-agent -Session qa-task -State finished | Out-Null
    $mapped = Wait-PetState 'finished'
    if ($mapped.bindings.finished -ne 'click') { throw '自定义状态映射未生效。' }
    & $wrapper -Executable $exe -Action status | Set-Content -LiteralPath (Join-Path $OutputRoot 'agent-status.json') -Encoding UTF8
    $queried = Get-Content -LiteralPath (Join-Path $OutputRoot 'agent-status.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($queried.pid -ne $runtime.Id -or $queried.lastState -ne 'finished') { throw 'Agent 未读到真实运行实例的状态。' }
    & $wrapper -Executable $exe -Action event -Tool qa-agent -Session another-task -State needs-user | Out-Null
    Start-Sleep -Milliseconds 700
    $isolated = Get-Content -LiteralPath (Join-Path $dataRoot 'ai-status.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($isolated.lastState -ne 'finished') { throw '其他会话影响了桌宠。' }
    & $wrapper -Executable $exe -Action disconnect | Out-Null
    & $wrapper -Executable $exe -Action event -Tool qa-agent -Session qa-task -State running | Out-Null
    Start-Sleep -Milliseconds 700
    & $wrapper -Executable $exe -Action status | Set-Content -LiteralPath (Join-Path $OutputRoot 'disconnected.json') -Encoding UTF8
    $disconnected = Get-Content -LiteralPath (Join-Path $OutputRoot 'disconnected.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($null -ne $disconnected.tool) { throw '断开连接未生效。' }
    $report = @{ passed = $true; runtimePid = $runtime.Id; fiveStates = $reports; customMapping = $mapped;
        otherSessionIgnored = $true; disconnected = $true; agentReadLiveInstance = $true }
    $report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $OutputRoot 'result.json') -Encoding UTF8
    Write-Output "Live five-state integration passed: $OutputRoot"
} finally {
    if ($runtime -and -not $runtime.HasExited) { $runtime.Kill(); $runtime.WaitForExit() }
    $env:AI_PET_DATA_DIR = $previousDirectory
}
