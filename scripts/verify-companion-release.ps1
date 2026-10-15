$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $workspace
$logs = Join-Path $workspace 'tests/native-artifacts'
New-Item -ItemType Directory -Path $logs -Force | Out-Null
foreach ($mode in @('Core', 'Models', 'Providers')) {
    $log = Join-Path $logs ($mode.ToLowerInvariant() + '-3.5.12-final.log')
    Write-Output "正在执行 $mode 实际检查。"
    & pwsh -NoProfile -File "$PSScriptRoot/verify-repair.ps1" -Mode $mode *> $log
    if ($LASTEXITCODE -ne 0) { Get-Content -LiteralPath $log -Tail 45; throw "$mode 实际检查失败：$log" }
    Get-Content -LiteralPath $log -Tail 8
}
& node "$PSScriptRoot/verify-release.cjs"
if ($LASTEXITCODE -ne 0) { throw '版本及安装资源检查失败' }
foreach ($mode in @('Browser', 'Native', 'Installer')) {
    & node "$PSScriptRoot/validation-state.cjs" skip $mode
    if ($LASTEXITCODE -ne 0) { throw "$mode 跳过记录创建失败" }
}
