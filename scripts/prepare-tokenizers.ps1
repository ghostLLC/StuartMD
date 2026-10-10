param([switch]$Offline)
$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content -LiteralPath (Join-Path $projectDirectory 'resources\tokenizers-manifest.json') -Raw | ConvertFrom-Json -AsHashtable
$resourceDirectory = Join-Path $projectDirectory 'resources\tokenizers'
$cacheDirectory = Join-Path $projectDirectory '.resource-cache\tokenizers'
New-Item -ItemType Directory -Path $resourceDirectory, $cacheDirectory -Force | Out-Null
foreach ($archive in $manifest.archives) {
    $archivePath = Join-Path $cacheDirectory ($archive.id + '.zip')
    if (-not (Test-Path -LiteralPath $archivePath)) {
        if ($Offline) { throw "分词资源压缩包不存在：$($archive.id)" }
        Invoke-WebRequest -Uri $archive.url -OutFile $archivePath
    }
    if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $archive.sha256) {
        throw "分词资源压缩包指纹不符：$($archive.id)"
    }
    $expandedDirectory = Join-Path $cacheDirectory ($archive.id + '-expanded')
    Expand-Archive -LiteralPath $archivePath -DestinationPath $expandedDirectory -Force
    $destinationDirectory = Join-Path $resourceDirectory $archive.id
    New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null
    foreach ($entry in $archive.files.GetEnumerator()) {
        $source = Join-Path (Join-Path $expandedDirectory $archive.directory) $entry.Key
        if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.Value) {
            throw "分词资源文件指纹不符：$($archive.id)/$($entry.Key)"
        }
        Copy-Item -LiteralPath $source -Destination (Join-Path $destinationDirectory $entry.Key) -Force
    }
    Write-Output "分词资源已验证：$($archive.id)"
}
