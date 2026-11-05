$ErrorActionPreference = 'Continue'
$Task = 'SpChannelProbe'
Write-Output "=== 任务定义 ==="
$t = Get-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue
if (-not $t) { Write-Output "COOKIE no-task"; exit 1 }
Write-Output ("state=" + $t.State + " triggers=" + @($t.Triggers).Count)
Write-Output ("principal=" + $t.Principal.UserId + " logon=" + $t.Principal.LogonType + " level=" + $t.Principal.RunLevel)
foreach ($tr in $t.Triggers) {
  Write-Output ("  trigger: type=" + $tr.GetType().Name + " start=" + $tr.StartBoundary + " rep=" + $tr.Repetition.Interval + " enabled=" + $tr.Enabled)
}
Write-Output "=== 设置（是否只在登录/交流电时才跑） ==="
$s = $t.Settings
Write-Output ("DisallowStartIfOnBatteries=" + $s.DisallowStartIfOnBatteries)
Write-Output ("StopIfGoingOnBatteries=" + $s.StopIfGoingOnBatteries)
Write-Output ("StartWhenAvailable=" + $s.StartWhenAvailable)
Write-Output ("ExecutionTimeLimit=" + $s.ExecutionTimeLimit)
Write-Output "=== 当前是否在跑（进程） ==="
$ps = Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -like '*spbox*' } |
      Select-Object ProcessId, Name, CreationDate
Write-Output ("spbox procs=" + @($ps).Count)
foreach ($p in $ps) { Write-Output ("  pid=" + $p.ProcessId + " " + $p.Name + " started=" + $p.CreationDate) }
Write-Output "=== 最后结果 ==="
$i = Get-ScheduledTaskInfo -TaskName $Task
Write-Output ("lastRun=" + $i.LastRunTime + " result=" + $i.LastTaskResult + " misses=" + $i.NumberOfMissedRuns)
Write-Output "COOKIE inspect done"
