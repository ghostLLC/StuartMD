param([string]$BaselineDirectory = $env:STUART_INSTALLER_BASELINE, [switch]$SkipStartup)
$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$releaseVersion = (Get-Content -LiteralPath (Join-Path $workspace 'package.json') -Raw | ConvertFrom-Json).version
$installDirectory = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'StuartMD'
$dataDirectory = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'StuartMD'
$application = Join-Path $installDirectory 'stuartmd.exe'
$builtApplication = Join-Path $workspace 'tauri/src-tauri/target/release/stuartmd.exe'
$installer = Join-Path $workspace "tauri/src-tauri/target/release/bundle/nsis/StuartMD_${releaseVersion}_x64-setup.exe"
$python = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'
$sevenZip = Join-Path $env:ProgramFiles '7-Zip/7z.exe'
$evidenceDirectory = Join-Path $workspace "docs/validation/$releaseVersion"
$artifactDirectory = Join-Path $workspace ('tests/native-artifacts/installer-' + [guid]::NewGuid().ToString())
$existing = Get-CimInstance Win32_Process -Filter "Name='stuartmd.exe'"
if ($existing) { throw 'StuartMD正在运行，请先完成当前文档保存与关闭；安装验收没有终止用户程序' }
foreach ($required in @($application, $builtApplication, $installer, $python, $sevenZip)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "安装验收缺少实际文件：$required" }
}
New-Item -ItemType Directory -Path $artifactDirectory -Force | Out-Null
$before = Join-Path $artifactDirectory 'before.json'
$after = Join-Path $artifactDirectory 'after.json'
$backup = Join-Path $artifactDirectory 'user-data-backup'
$startedWithVersion = (Get-Item -LiteralPath $application).VersionInfo.FileVersion
$previousVersion = $startedWithVersion
Copy-Item -LiteralPath $installDirectory -Destination (Join-Path $artifactDirectory 'installation-backup') -Recurse -Force
& $python "$workspace/tests/installer-data.py" snapshot --source $dataDirectory --output $before --backup $backup
if ($LASTEXITCODE -ne 0) { throw '升级前一致性备份失败' }
if ($BaselineDirectory) {
    $baseline = (Resolve-Path -LiteralPath $BaselineDirectory).Path
    $allowedBaselineRoot = (Resolve-Path -LiteralPath "$workspace/tests/native-artifacts").Path + [IO.Path]::DirectorySeparatorChar
    if (-not $baseline.StartsWith($allowedBaselineRoot, [StringComparison]::OrdinalIgnoreCase)) { throw '升级前备份必须位于本次实际验收目录' }
    $before = Join-Path $baseline 'before.json'
    $backup = Join-Path $baseline 'user-data-backup'
    $previousVersion = (Get-Item -LiteralPath (Join-Path $baseline 'installation-backup/stuartmd.exe')).VersionInfo.FileVersion
    if ($previousVersion -ne '3.5.10') { throw '实际升级前备份的程序版本不符合验收要求' }
}
$backupSnapshot = Join-Path $artifactDirectory 'backup-check.json'
& $python "$workspace/tests/installer-data.py" snapshot --source $backup --output $backupSnapshot
if ($LASTEXITCODE -ne 0) { throw '升级前备份完整性检查失败' }
& $python "$workspace/tests/installer-data.py" compare --before $before --after $backupSnapshot | Out-Null
if ($LASTEXITCODE -ne 0) { throw '升级前备份内容与实际用户资料不一致' }
$packageDirectory = Join-Path $artifactDirectory 'installer-contents'
& $sevenZip x $installer "-o$packageDirectory" -y -bso0 -bsp0
if ($LASTEXITCODE -ne 0) { throw '读取实际NSIS安装包内容失败' }
$packagedApplications = @(Get-ChildItem -LiteralPath $packageDirectory -Recurse -File -Filter 'stuartmd.exe')
if ($packagedApplications.Count -ne 1) { throw '实际安装包缺少唯一的StuartMD可执行程序' }
$installProcess = Start-Process -FilePath $installer -ArgumentList '/S' -WindowStyle Hidden -PassThru -Wait
if ($installProcess.ExitCode -ne 0) { throw "实际安装程序退出异常：$($installProcess.ExitCode)" }
$version = (Get-Item -LiteralPath $application).VersionInfo.FileVersion
if ($version -ne $releaseVersion) { throw "安装后的实际文件版本异常：$version" }
$applicationHash = (Get-FileHash -LiteralPath $application -Algorithm SHA256).Hash
if ($applicationHash -ne (Get-FileHash -LiteralPath $packagedApplications[0].FullName -Algorithm SHA256).Hash) { throw '安装后的可执行程序与实际安装包内容不一致' }
$resources = @('samples/示例文档.md', 'samples/欢迎使用 StuartMD.md', 'file-md.ico', 'file-pdf.ico', 'native-manifest.json', 'models/manifest.json', 'tokenizers-manifest.json', 'ai-model-catalog.json')
$nativeManifest = Get-Content -LiteralPath "$workspace/resources/native-manifest.json" -Raw | ConvertFrom-Json
foreach ($entry in $nativeManifest.files) { $resources += 'native/' + $entry.path }
$tokenizerManifest = Get-Content -LiteralPath "$workspace/resources/tokenizers-manifest.json" -Raw | ConvertFrom-Json
foreach ($archive in $tokenizerManifest.archives) {
    foreach ($entry in $archive.files.PSObject.Properties) { $resources += 'tokenizers/' + $archive.id + '/' + $entry.Name }
}
foreach ($relative in $resources) {
    $installed = Join-Path $installDirectory $relative
    $built = Join-Path (Split-Path -Parent $builtApplication) $relative
    if ((Get-FileHash -LiteralPath $installed -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $built -Algorithm SHA256).Hash) { throw "安装后的资源指纹异常：$relative" }
}
& $python "$workspace/tests/installer-data.py" snapshot --source $dataDirectory --output $after
if ($LASTEXITCODE -ne 0) { throw '升级后用户数据检查失败' }
$preservation = & $python "$workspace/tests/installer-data.py" compare --before $before --after $after
if ($LASTEXITCODE -ne 0) { throw '安装程序更改了原有用户数据' }
$runtimeVersion = $null
$startupStatus = 'SkippedByUser'
if (-not $SkipStartup) {
$startupData = Join-Path $artifactDirectory 'startup-data'
Copy-Item -LiteralPath $backup -Destination $startupData -Recurse -Force
$previousDataDirectory = $env:STUART_DATA_DIR
$startupProcess = $null
try {
    $env:STUART_DATA_DIR = $startupData
    $startupProcess = Start-Process -FilePath $application -WorkingDirectory $installDirectory -WindowStyle Hidden -RedirectStandardOutput (Join-Path $artifactDirectory 'startup.out') -RedirectStandardError (Join-Path $artifactDirectory 'startup.err') -PassThru
    Start-Sleep -Seconds 6
    $startupProcess.Refresh()
    if ($startupProcess.HasExited) { throw "安装后的程序启动异常：$($startupProcess.ExitCode)" }
    $nativeProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($startupProcess.Id)"
    if (-not $nativeProcess.ExecutablePath.Equals($application, [StringComparison]::OrdinalIgnoreCase)) { throw '启动程序的实际路径不一致' }
    $webviews = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($startupProcess.Id)" | Where-Object { $_.Name -eq 'msedgewebview2.exe' })
    if ($webviews.Count -eq 0) { throw '安装后的原生WebView2没有运行' }
    $runtimeVersion = (Get-Item -LiteralPath $webviews[0].ExecutablePath).VersionInfo.FileVersion
} finally {
    $env:STUART_DATA_DIR = $previousDataDirectory
    if ($startupProcess -and -not $startupProcess.HasExited) {
        $ownedProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($startupProcess.Id)"
        if ($ownedProcess.ExecutablePath.Equals($application, [StringComparison]::OrdinalIgnoreCase)) { Stop-Process -Id $startupProcess.Id }
    }
}
& $python "$workspace/tests/installer-data.py" snapshot --source $startupData --output (Join-Path $artifactDirectory 'startup.json')
if ($LASTEXITCODE -ne 0) { throw '原生启动后的数据库完整性检查失败' }
$startupStatus = 'Passed'
}
$result = [ordered]@{
    schemaVersion = 1
    previousVersion = $previousVersion
    startedWithVersion = $startedWithVersion
    installedVersion = $version
    applicationSha256 = $applicationHash.ToLowerInvariant()
    installerSha256 = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
    verifiedResources = $resources.Count
    userDataPreservation = $preservation | ConvertFrom-Json
    installedProcessStartup = $startupStatus
    webviewVersion = $runtimeVersion
    backupDirectory = $artifactDirectory
    upgradeBaselineDirectory = $BaselineDirectory
    isolatedWindowsUpgrade = 'NotVerified'
    nativeUiAcceptance = $(if ($SkipStartup) { 'SkippedByUser' } else { 'NotVerified' })
    completedAt = [DateTime]::UtcNow.ToString('o')
}
$result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $evidenceDirectory 'installer-results.json') -Encoding utf8
Write-Output "实际安装完成：$previousVersion → $version；原有用户数据和$($resources.Count)项资源检查通过；启动检查：$startupStatus。"
if (-not $SkipStartup) { throw '隔离Windows环境的升级和原生界面完整操作尚未验收，发布检查继续阻止公开发布' }
