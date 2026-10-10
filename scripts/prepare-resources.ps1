param([switch]$VerifyOnly)
$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content -LiteralPath (Join-Path $workspace 'resources/native-manifest.json') -Raw | ConvertFrom-Json
$native = Join-Path $workspace 'resources/native'
$package = Join-Path $workspace 'node_modules/pdfjs-dist'
$pdfMetadata = Get-Content -LiteralPath (Join-Path $package 'package.json') -Raw | ConvertFrom-Json
if ($pdfMetadata.version -ne $manifest.pdfJsVersion) { throw 'PDF.js版本不符合资源清单' }
if (-not $VerifyOnly) {
    $pdfDestination = Join-Path $workspace 'web/libs/pdfjs'
    New-Item -ItemType Directory -Force -Path $pdfDestination, $native | Out-Null
    Copy-Item -LiteralPath (Join-Path $package 'cmaps') -Destination $pdfDestination -Recurse -Force
    Copy-Item -LiteralPath (Join-Path $package 'standard_fonts') -Destination $pdfDestination -Recurse -Force
    Copy-Item -LiteralPath (Join-Path $package 'build/pdf.worker.min.js') -Destination (Join-Path $workspace 'web/libs/pdf.worker.min.js') -Force
    Copy-Item -LiteralPath (Join-Path $package 'build/pdf.min.js') -Destination (Join-Path $workspace 'web/libs/pdf.min.js') -Force
    Copy-Item -LiteralPath (Join-Path $package 'LICENSE') -Destination (Join-Path $pdfDestination 'LICENSE') -Force
    $cache = Join-Path $env:LOCALAPPDATA 'StuartMD/resource-downloads'
    New-Item -ItemType Directory -Force -Path $cache | Out-Null
    foreach ($archive in $manifest.archives) {
        $download = Join-Path $cache $archive.name
        if (-not (Test-Path -LiteralPath $download)) { Invoke-WebRequest -Uri $archive.url -OutFile $download }
        if ((Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash.ToLowerInvariant() -ne $archive.sha256) { throw ('原生资源下载指纹不匹配：' + $archive.name) }
        $unpacked = Join-Path $cache ($archive.kind + '-unpacked')
        New-Item -ItemType Directory -Force -Path $unpacked | Out-Null
        if ($archive.kind -eq 'pdfium') {
            & tar -xzf $download -C $unpacked
            if ($LASTEXITCODE -ne 0) { throw '解压PDFium失败' }
            Copy-Item -LiteralPath (Join-Path $unpacked 'bin') -Destination $native -Recurse -Force
            Copy-Item -LiteralPath (Join-Path $unpacked 'LICENSE') -Destination (Join-Path $native 'PDFium-LICENSE') -Force
        } elseif ($archive.kind -eq 'tesseract') {
            $sevenZip = Join-Path $env:ProgramFiles '7-Zip/7z.exe'
            if (-not (Test-Path -LiteralPath $sevenZip)) { throw '资源准备需要安装7-Zip来读取官方Tesseract安装包' }
            & $sevenZip x '-y' ('-o' + $unpacked) $download | Out-Null
            if ($LASTEXITCODE -gt 1) { throw '解压Tesseract失败' }
            $destination = Join-Path $native 'tesseract'
            New-Item -ItemType Directory -Force -Path (Join-Path $destination 'tessdata') | Out-Null
            Copy-Item -LiteralPath (Join-Path $unpacked 'tesseract.exe') -Destination $destination -Force
            Get-ChildItem -LiteralPath $unpacked -Filter '*.dll' | Copy-Item -Destination $destination -Force
            Copy-Item -LiteralPath (Join-Path $unpacked 'doc/LICENSE') -Destination (Join-Path $destination 'LICENSE') -Force
            Copy-Item -LiteralPath (Join-Path $unpacked 'tessdata/configs') -Destination (Join-Path $destination 'tessdata') -Recurse -Force
        } elseif ($archive.kind -eq 'onnxruntime') {
            Expand-Archive -LiteralPath $download -DestinationPath $unpacked -Force
            $source = Join-Path $unpacked ('onnxruntime-win-x64-' + $manifest.onnxRuntimeVersion)
            $destination = Join-Path $native 'onnxruntime'
            New-Item -ItemType Directory -Force -Path $destination | Out-Null
            Copy-Item -LiteralPath (Join-Path $source 'lib/onnxruntime.dll') -Destination $destination -Force
            Copy-Item -LiteralPath (Join-Path $source 'LICENSE') -Destination $destination -Force
            Copy-Item -LiteralPath (Join-Path $source 'ThirdPartyNotices.txt') -Destination $destination -Force
        } else {
            throw ('原生资源类型未注册：' + $archive.kind)
        }
    }
    foreach ($language in $manifest.ocrLanguages) {
        $target = Join-Path $native ('tesseract/tessdata/' + $language + '.traineddata')
        if (-not (Test-Path -LiteralPath $target)) {
            Invoke-WebRequest -Uri ('https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/' + $manifest.languageRevision + '/' + $language + '.traineddata') -OutFile $target
        }
    }
    Copy-Item -LiteralPath (Join-Path $native 'tesseract/LICENSE') -Destination (Join-Path $native 'tesseract/tessdata/LICENSE') -Force
}
foreach ($file in $manifest.files) {
    $path = Join-Path $native $file.path
    if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256) { throw ('原生文件指纹不匹配：' + $file.path) }
}
$cmaps = Get-ChildItem -LiteralPath (Join-Path $workspace 'web/libs/pdfjs/cmaps') -Filter '*.bcmap'
$fonts = Get-ChildItem -LiteralPath (Join-Path $workspace 'web/libs/pdfjs/standard_fonts') -File
if ($cmaps.Count -ne $manifest.pdfJsCmapCount -or $fonts.Count -ne $manifest.pdfJsFontCount) { throw 'PDF.js资源数量不符合清单' }
foreach ($folder in @('cmaps', 'standard_fonts')) {
    foreach ($source in Get-ChildItem -LiteralPath (Join-Path $package $folder) -File) {
        $target = Join-Path $workspace ('web/libs/pdfjs/' + $folder + '/' + $source.Name)
        if ((Get-FileHash -LiteralPath $source.FullName -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash) { throw ('PDF.js资源内容不一致：' + $source.Name) }
    }
}
foreach ($file in @('pdf.min.js', 'pdf.worker.min.js')) {
    if ((Get-FileHash -LiteralPath (Join-Path $package ('build/' + $file)) -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath (Join-Path $workspace ('web/libs/' + $file)) -Algorithm SHA256).Hash) { throw ('PDF.js主程序内容不一致：' + $file) }
}
Write-Output ('资源验证通过：PDF.js ' + $manifest.pdfJsVersion + '，CMaps ' + $cmaps.Count + '，fonts ' + $fonts.Count + '，PDFium ' + $manifest.pdfiumApi + '，Tesseract ' + $manifest.tesseractVersion)
