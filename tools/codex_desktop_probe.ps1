param([Parameter(Mandatory=$true)][string]$CodexExecutable, [Parameter(Mandatory=$true)][string]$Output)
$ErrorActionPreference = 'Stop'
if (-not [IO.Path]::IsPathRooted($Output) -or (Test-Path -LiteralPath $Output)) { throw '请选择新的绝对输出路径。' }
if (-not (Test-Path -LiteralPath $CodexExecutable -PathType Leaf)) { throw 'Codex executable missing.' }
$processes = @(Get-CimInstance Win32_Process)
$desktopIds = @($processes | Where-Object { $_.Name -in @('ChatGPT.exe','Codex.exe') -and $_.ExecutablePath -match '\\WindowsApps\\OpenAI\.' } | ForEach-Object { $_.ProcessId })
$bridges = @($processes | Where-Object { $_.Name -eq 'codex.exe' -and $_.ParentProcessId -in $desktopIds } | ForEach-Object {
    $remote = [regex]::Match($_.CommandLine, '--remote(?:=|\s+)(?:"([^"]+)"|(\S+))')
    $value = if ($remote.Groups[1].Success) { $remote.Groups[1].Value } else { $remote.Groups[2].Value }
    $kind = 'not-established'
    if ($value) {
        $uri = $null
        if ([uri]::TryCreate($value,[UriKind]::Absolute,[ref]$uri)) {
            $kind = if ($uri.Scheme -in @('https','wss')) { 'remote-host' } elseif ($uri.Scheme -eq 'unix' -or $uri.IsLoopback) { 'local-endpoint' } else { 'other' }
        }
    }
    $isServer = $_.CommandLine -match '\bapp-server\b'
    if ($isServer -and $kind -eq 'not-established' -and $_.CommandLine -notmatch '--listen') { $kind = 'stdio-default' }
    [ordered]@{ pid=$_.ProcessId; desktopParent=$_.ParentProcessId; transportKind=$kind; appServerArgument=$isServer }
})
$start = New-Object Diagnostics.ProcessStartInfo
$start.FileName = [IO.Path]::GetFullPath($CodexExecutable)
$start.Arguments = 'app-server daemon version'
$start.UseShellExecute = $false; $start.CreateNoWindow = $true
$start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
$probe = [Diagnostics.Process]::Start($start)
if (-not $probe.WaitForExit(5000)) { $probe.Kill(); $probe.WaitForExit() }
# Discard raw diagnostics: no commands, tokens, endpoint paths, transcripts or question text in evidence.
$null = $probe.StandardOutput.ReadToEnd(); $null = $probe.StandardError.ReadToEnd()
$report = [ordered]@{
    version=1; observedAtUtc=[DateTime]::UtcNow.ToString('o'); desktopBridges=$bridges
    localDefaultControlConnected=($probe.ExitCode -eq 0)
    existingDesktopSubscriptionVerified=$false
    approvalCoverage='not-verified'; questionResolutionCoverage='not-verified'
    configurationChanged=$false; replacementServerStarted=$false; credentialFilesRead=$false
    note='Discovery only. A reachable daemon does not prove it owns the current desktop session.'
}
$parent = Split-Path ([IO.Path]::GetFullPath($Output)) -Parent
New-Item -ItemType Directory -Path $parent -Force | Out-Null
$json = $report | ConvertTo-Json -Depth 6
[IO.File]::WriteAllText($Output,$json,(New-Object Text.UTF8Encoding($false)))
$json
