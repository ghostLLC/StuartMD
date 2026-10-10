param([Parameter(Mandatory)][int]$DriverProcessId, [Parameter(Mandatory)][string]$ApplicationPath)
$ErrorActionPreference = 'Stop'
$taskApplication = (Resolve-Path -LiteralPath $ApplicationPath).Path
$taskProcesses = Get-CimInstance Win32_Process -Filter "ParentProcessId=$DriverProcessId"
foreach ($taskProcess in $taskProcesses) {
    if ($taskProcess.ExecutablePath -and $taskProcess.ExecutablePath.Equals($taskApplication, [StringComparison]::OrdinalIgnoreCase)) {
        Stop-Process -Id $taskProcess.ProcessId -ErrorAction Stop
    }
}
