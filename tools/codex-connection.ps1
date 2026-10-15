param(
    [ValidateSet('install','remove','status')][string]$Action = 'status',
    [Parameter(Mandatory=$true)][string]$Executable,
    [string]$DataDirectory = (Join-Path $env:LOCALAPPDATA 'AI Pet Studio'),
    [string]$CodexHome
)
$ErrorActionPreference = 'Stop'
if (-not $CodexHome) { $CodexHome = $env:CODEX_HOME }
if (-not $CodexHome) { $CodexHome = Join-Path $env:USERPROFILE '.codex' }
foreach ($value in @($Executable, $DataDirectory, $CodexHome)) {
    if (-not [IO.Path]::IsPathRooted($value)) { throw '程序、数据和 Codex 目录必须使用绝对路径。' }
}
$Executable = [IO.Path]::GetFullPath($Executable)
$DataDirectory = [IO.Path]::GetFullPath($DataDirectory)
$CodexHome = [IO.Path]::GetFullPath($CodexHome)
$hookPath = Join-Path $CodexHome 'hooks.json'
$markerPath = Join-Path $DataDirectory 'codex-connection-registration.json'
$events = @('UserPromptSubmit','PreToolUse','PostToolUse','PermissionRequest','Stop','Interrupt')
$utf8 = New-Object Text.UTF8Encoding($false)
function Read-Object([string]$Path) {
    $object = [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8) | ConvertFrom-Json
    if ($object -isnot [pscustomobject]) { throw "配置必须是 JSON 对象：$Path" }
    return $object
}
function Write-Object([string]$Path, [object]$Value) {
    $temporary = $Path + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 100), $utf8)
        if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($temporary, $Path, ($Path + '.ai-pet-' + [guid]::NewGuid().ToString('N') + '.bak')) }
        else { [IO.File]::Move($temporary, $Path) }
    } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
}
function Remove-Owned([object]$Config, [string]$Command) {
    if ($null -eq $Config.PSObject.Properties['hooks']) { return }
    foreach ($eventName in $events) {
        $property = $Config.hooks.PSObject.Properties[$eventName]
        if ($null -eq $property) { continue }
        [object[]]$kept = @()
        foreach ($group in @($property.Value)) {
            [object[]]$handlers = @($group.hooks)
            if ($handlers.Count -eq 1 -and $handlers[0].type -ceq 'command' -and
                $handlers[0].command -ceq $Command -and $handlers[0].commandWindows -ceq $Command) { continue }
            $kept += $group
        }
        if ($kept.Count) { $property.Value = $kept }
        else { $Config.hooks.PSObject.Properties.Remove($eventName) }
    }
}
$marker = if (Test-Path -LiteralPath $markerPath) { Read-Object $markerPath } else { $null }
if ($marker -and ($marker.productId -cne 'ai-pet.codex' -or $marker.version -ne 1 -or $marker.codexHome -ine $CodexHome)) {
    throw '已有登记不属于此 Codex 目录，拒绝修改。'
}
if ($Action -eq 'status') {
    $registered = $false
    if ($marker -and (Test-Path -LiteralPath $hookPath)) {
        $config = Read-Object $hookPath
        $registered = $true
        foreach ($eventName in $events) {
            $found = $false
            foreach ($group in @($config.hooks.$eventName)) {
                foreach ($handler in @($group.hooks)) {
                    if ($handler.command -ceq $marker.command -and $handler.commandWindows -ceq $marker.command) { $found = $true }
                }
            }
            if (-not $found) { $registered = $false }
        }
    }
    [pscustomobject]@{ registered = $registered; trust = 'managed-by-codex'; hooksPath = $hookPath; dataDirectory = $DataDirectory } | ConvertTo-Json
    return
}
if ($Action -eq 'remove' -and -not $marker) { Write-Output '没有本适配器登记。'; return }
if ($Action -eq 'install' -and -not (Test-Path -LiteralPath $Executable -PathType Leaf)) { throw '桌宠程序不存在。' }
New-Item -ItemType Directory -Path $CodexHome, $DataDirectory -Force | Out-Null
# Serialize this adapter's edits; preserve every unrelated hook and configuration field.
$registrationLock = [IO.File]::Open((Join-Path $CodexHome '.ai-pet-registration.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
try {
    $config = if (Test-Path -LiteralPath $hookPath) { Read-Object $hookPath } else { [pscustomobject]@{ hooks = [pscustomobject]@{} } }
    if ($null -eq $config.PSObject.Properties['hooks']) { $config | Add-Member -NotePropertyName hooks -NotePropertyValue ([pscustomobject]@{}) }
    if ($config.hooks -isnot [pscustomobject]) { throw '现有 hooks 字段无效。' }
    if ($marker) { Remove-Owned $config $marker.command }
    if ($Action -eq 'install') {
        $script = "`$env:AI_PET_DATA_DIR = '" + $DataDirectory.Replace("'", "''") + "'; & '" + $Executable.Replace("'", "''") + "' --ai-codex-hook"
        $command = 'powershell.exe -NoProfile -NonInteractive -EncodedCommand ' + [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
        foreach ($eventName in $events) {
            $property = $config.hooks.PSObject.Properties[$eventName]
            [object[]]$groups = if ($null -eq $property) { @() } else { @($property.Value) }
            $groups += [pscustomobject]@{ hooks = @([pscustomobject]@{ type = 'command'; command = $command; commandWindows = $command; timeout = 3 }) }
            if ($null -eq $property) { $config.hooks | Add-Member -NotePropertyName $eventName -NotePropertyValue $groups }
            else { $property.Value = $groups }
        }
        Write-Object $markerPath ([pscustomobject]@{ productId = 'ai-pet.codex'; version = 1; codexHome = $CodexHome; command = $command })
    }
    Write-Object $hookPath $config
    if ($Action -eq 'remove') { Remove-Item -LiteralPath $markerPath -Force; Write-Output '已移除本适配器，其他 Hooks 保留。' }
    else { Write-Output '已配置 Codex 状态观察。请在 Codex 中审核并信任 Hooks；CLI 使用 /hooks。绑定会话后才会响应。' }
} finally { $registrationLock.Dispose() }
