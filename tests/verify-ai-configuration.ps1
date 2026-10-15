$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$sourceDirectory = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'StuartMD'
$testDirectory = Join-Path $workspace ('tests/native-artifacts/ai-configuration-' + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path (Join-Path $testDirectory 'ai/keys') -Force | Out-Null
$sourceSettings = Join-Path $sourceDirectory 'settings.json'
$sourceHash = (Get-FileHash -LiteralPath $sourceSettings -Algorithm SHA256).Hash
Copy-Item -LiteralPath $sourceSettings -Destination (Join-Path $testDirectory 'settings.json')
Get-ChildItem -LiteralPath (Join-Path $sourceDirectory 'ai/keys') -File | Copy-Item -Destination (Join-Path $testDirectory 'ai/keys')
$original = Get-Content -LiteralPath $sourceSettings -Raw | ConvertFrom-Json
$keyHashes = Get-ChildItem -LiteralPath (Join-Path $testDirectory 'ai/keys') -File | Get-FileHash -Algorithm SHA256
$previousDirectory = $env:STUART_DATA_DIR
try {
    $env:STUART_DATA_DIR = $testDirectory
    cargo test --manifest-path "$workspace/tauri/src-tauri/Cargo.toml" --locked ai::configuration::checks::settings_file_probe -- --ignored --test-threads=1
    if ($LASTEXITCODE -ne 0) { throw '实际配置首次迁移失败' }
    $first = Get-Content -LiteralPath (Join-Path $testDirectory 'configuration-result.json') -Raw | ConvertFrom-Json
    $firstSettings = (Get-FileHash -LiteralPath (Join-Path $testDirectory 'settings.json') -Algorithm SHA256).Hash
    cargo test --manifest-path "$workspace/tauri/src-tauri/Cargo.toml" --locked ai::configuration::checks::settings_file_probe -- --ignored --test-threads=1
    if ($LASTEXITCODE -ne 0) { throw '实际配置重新启动读取失败' }
    $second = Get-Content -LiteralPath (Join-Path $testDirectory 'configuration-result.json') -Raw | ConvertFrom-Json
    if ($firstSettings -ne (Get-FileHash -LiteralPath (Join-Path $testDirectory 'settings.json') -Algorithm SHA256).Hash) { throw '重新启动改写已有模型配置' }
    if ($first.settingsRevision -ne $second.settingsRevision) { throw '重新启动配置版本变化' }
    if ($original.schema_version -lt 6) {
        foreach ($provider in $original.ai.providers) {
            if (-not $provider.model) { continue }
            $saved = @($first.ai.models | Where-Object { $_.provider_id -eq $provider.id -and $_.model_id -eq $provider.model })
            if ($saved.Count -ne 1) { throw '原有型号没有唯一保留' }
            if ($saved[0].max_output_tokens -ne $original.ai.max_output_tokens) { throw '原有输出预算没有保留' }
            if (($saved[0].token_counting | ConvertTo-Json -Depth 30 -Compress) -ne ($provider.token_counting | ConvertTo-Json -Depth 30 -Compress)) { throw '原有计数覆盖项变化' }
        }
    }
    foreach ($entry in $keyHashes) { if ($entry.Hash -ne (Get-FileHash -LiteralPath $entry.Path -Algorithm SHA256).Hash) { throw '迁移改写密钥密文' } }
    if ($sourceHash -ne (Get-FileHash -LiteralPath $sourceSettings -Algorithm SHA256).Hash) { throw '真实用户设置被修改' }
    Write-Output "实际配置迁移及进程重新启动检查通过，保留 $($first.ai.models.Count) 个模型。独立目录：$testDirectory"
} finally { $env:STUART_DATA_DIR = $previousDirectory }
