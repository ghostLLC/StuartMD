param([Parameter(Mandatory)][string]$Directory, [switch]$Deny)
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$root = Join-Path $workspace 'tests/native-artifacts'
$target = (Resolve-Path -LiteralPath $Directory).Path
if (-not $target.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw '权限测试目录必须位于工作区测试资料目录' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if ($Deny) { & icacls.exe $target /deny ('*' + $identity + ':(W)') | Out-Null }
else { & icacls.exe $target '/remove:d' ('*' + $identity) | Out-Null }
if ($LASTEXITCODE -ne 0) { throw '实际文件权限操作失败' }
