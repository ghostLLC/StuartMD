$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$sourceDirectory = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'StuartMD'
$testDirectory = Join-Path $workspace ('tests/native-artifacts/providers-' + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path (Join-Path $testDirectory 'ai/keys') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $sourceDirectory 'settings.json') -Destination (Join-Path $testDirectory 'settings.json')
Copy-Item -LiteralPath (Join-Path $sourceDirectory 'ai/keys/deepseek.bin') -Destination (Join-Path $testDirectory 'ai/keys/deepseek.bin')
$previousDirectory = $env:STUART_DATA_DIR
$previousProvider = $env:STUART_PROVIDER_TEST
try {
    $env:STUART_DATA_DIR = $testDirectory
    $env:STUART_PROVIDER_TEST = 'deepseek'
    cargo test --manifest-path "$workspace/tauri/src-tauri/Cargo.toml" --locked ai::real_tests -- --ignored --test-threads=1
    if ($LASTEXITCODE -ne 0) { throw 'DeepSeek 实际接口验收失败' }
} finally {
    $env:STUART_DATA_DIR = $previousDirectory
    $env:STUART_PROVIDER_TEST = $previousProvider
}
