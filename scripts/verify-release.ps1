param([switch]$Publication)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
if ($Publication) { node "$PSScriptRoot/verify-release.cjs" --publication }
else { node "$PSScriptRoot/verify-release.cjs" }
if ($LASTEXITCODE -ne 0) { throw '版本与资源检查失败' }
