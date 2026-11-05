$ErrorActionPreference = 'Continue'
$Dir = 'D:\web\spbox'
Write-Output "--- probe.log (tail) ---"
$log = Join-Path $Dir 'logs\probe.log'
if (Test-Path $log) { Get-Content $log -Tail 8 } else { Write-Output "(no log yet)" }
Write-Output "--- run logs ---"
Get-ChildItem -Path (Join-Path $Dir 'logs') -Filter 'probe-*.log' -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime | Select-Object -Last 3 | ForEach-Object { Write-Output $_.Name }
Write-Output "--- task info ---"
$info = Get-ScheduledTaskInfo -TaskName 'SpChannelProbe'
Write-Output ("lastRun=" + $info.LastRunTime + " result=" + $info.LastTaskResult + " nextRun=" + $info.NextRunTime)
Write-Output "--- node procs ---"
$p = Get-Process -Name node -ErrorAction SilentlyContinue | Select-Object -First 5 Id, StartTime
Write-Output ("node=" + (@($p).Count))
Write-Output "COOKIE status done"
