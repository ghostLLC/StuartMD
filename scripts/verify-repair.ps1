param([Parameter(Mandatory)][ValidateSet('Core','Browser','Native','Models','Providers','Installer')][string]$Mode)
$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $workspace
node "$PSScriptRoot/validation-state.cjs" begin $Mode
if ($LASTEXITCODE -ne 0) { throw '创建实际验证记录失败' }
function Test-DocumentModules {
    npm test
    if ($LASTEXITCODE -ne 0) { throw '前端文档模块测试失败' }
    npm run test:companion
    if ($LASTEXITCODE -ne 0) { throw '伴读语法、实际文档渲染及来源协议检查失败' }
    npm run test:folder
    if ($LASTEXITCODE -ne 0) { throw '真实目录扫描与前端目录刷新检查失败' }
    & "$workspace/tests/verify-ai-configuration.ps1"
    if ($LASTEXITCODE -ne 0) { throw '模型配置、真实迁移及页面输入检查失败' }
    cargo test --manifest-path "$workspace/tauri/src-tauri/Cargo.toml" --locked -- --test-threads=1
    if ($LASTEXITCODE -ne 0) { throw 'Rust真实文件与数据库测试失败' }
    cargo test --manifest-path "$workspace/tests/native-documents/Cargo.toml" --locked -- --test-threads=1 --nocapture
    if ($LASTEXITCODE -ne 0) { throw '实际多进程、权限及异常恢复测试失败' }
    node "$workspace/tests/repair-companion-store.cjs"
    if ($LASTEXITCODE -ne 0) { throw '实际SQLite草稿的共享状态与身份迁移检查失败' }
}
try {
    switch ($Mode) {
        'Core' { Test-DocumentModules }
        'Browser' {
            node "$workspace/tests/repair-block-handle.cjs"
            if ($LASTEXITCODE -ne 0) { throw '块手柄实际鼠标悬浮与正文操作测试失败' }
            node "$workspace/tests/repair-mermaid-layout.cjs"
            if ($LASTEXITCODE -ne 0) { throw 'Mermaid实际浏览器测试失败' }
            node "$workspace/tests/repair-pdf-viewer.cjs"
            if ($LASTEXITCODE -ne 0) { throw 'PDF实际浏览器测试失败' }
        }
        'Native' {
            Test-DocumentModules
            node "$workspace/tests/native-ui/repair.cjs"
            if ($LASTEXITCODE -ne 0) { throw '原生界面测试失败' }
        }
        'Models' {
            $referencePython = Join-Path $workspace 'tests/native-artifacts/model-reference/Scripts/python.exe'
            if (-not (Test-Path -LiteralPath $referencePython)) { throw '实际模型验证需要独立Python环境和tests/model-reference-requirements.txt中的依赖' }
            & $referencePython "$workspace/tests/verify-model-reference.py"
            if ($LASTEXITCODE -ne 0) { throw '独立模型参考计算失败' }
            cargo test --manifest-path "$workspace/tauri/src-tauri/Cargo.toml" --locked rag::real_tests -- --ignored --test-threads=1
            if ($LASTEXITCODE -ne 0) { throw '真实模型与PDF测试失败' }
        }
        'Providers' {
            & "$PSScriptRoot/verify-providers.ps1"
            if ($LASTEXITCODE -ne 0) { throw 'DeepSeek实际接口测试失败' }
        }
        'Installer' {
            & "$PSScriptRoot/verify-installer.ps1"
            if ($LASTEXITCODE -ne 0) { throw '安装程序验收失败' }
        }
    }
} catch {
    node "$PSScriptRoot/validation-state.cjs" fail $Mode
    throw
}
node "$PSScriptRoot/validation-state.cjs" pass $Mode
if ($LASTEXITCODE -ne 0) { throw '本次验证期间软件源码发生变化' }
