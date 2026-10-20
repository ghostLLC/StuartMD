param([switch]$InspectOnly, [string]$BaselinePath)
$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$version = (Get-Content "$workspace/package.json" -Raw | ConvertFrom-Json).version
$installDirectory = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'StuartMD'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class StuartAssociationQuery {
    [DllImport("Shlwapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int AssocQueryStringW(uint flags, uint query, string association, string extra, StringBuilder output, ref uint length);
    public static string Read(string association, uint query) {
        uint length = 0;
        int result = AssocQueryStringW(0, query, association, null, null, ref length);
        if (result != 1 || length == 0) throw new InvalidOperationException("读取关联长度失败：" + result);
        var output = new StringBuilder(checked((int)length));
        result = AssocQueryStringW(0, query, association, null, output, ref length);
        if (result != 0) Marshal.ThrowExceptionForHR(result);
        return output.ToString();
    }
}
'@
$choice = Get-ItemProperty -LiteralPath 'HKCU:/Software/Microsoft/Windows/CurrentVersion/Explorer/FileExts/.md/UserChoice'
$actual = [ordered]@{
    version = $version
    progId = [StuartAssociationQuery]::Read('.md', 20)
    icon = [StuartAssociationQuery]::Read('.md', 15)
    executable = [StuartAssociationQuery]::Read('.md', 2)
    userChoice = $choice.ProgId
}
if ($InspectOnly) { $actual.userChoiceHash = $choice.Hash; $actual | ConvertTo-Json; exit 0 }
if ($BaselinePath) {
    $baseline = Get-Content -LiteralPath $BaselinePath -Raw | ConvertFrom-Json
    if ($actual.userChoice -ne $baseline.userChoice -or $choice.Hash -ne $baseline.userChoiceHash) { throw '升级改变了用户选择的默认打开方式' }
    $actual.userChoicePreserved = $true
}
$expectedIcon = '"' + (Join-Path $installDirectory 'file-md.ico') + '",0'
if ($actual.icon -ne $expectedIcon) { throw "Markdown 实际关联图标异常：$($actual.icon)" }
if ($actual.executable -ne (Join-Path $installDirectory 'stuartmd.exe')) { throw "Markdown 实际打开程序异常：$($actual.executable)" }
if ((Get-FileHash "$installDirectory/file-md.ico").Hash -ne (Get-FileHash "$workspace/assets/file-md.ico").Hash) { throw '安装后的 Markdown 图标与设计资源不同' }
$actual.status = 'Passed'
$actual.iconSha256 = (Get-FileHash "$installDirectory/file-md.ico").Hash.ToLowerInvariant()
$actual | ConvertTo-Json | Set-Content "$workspace/docs/validation/$version/file-icons.json" -Encoding utf8
$actual | ConvertTo-Json
