$ErrorActionPreference = 'Continue'
# Audit: which scheduled tasks / services reference C:\aiwork (before removing the old copy).
Write-Output '=== tasks referencing aiwork ==='
foreach ($t in Get-ScheduledTask) {
  foreach ($a in @($t.Actions)) {
    $line = "$($a.Execute) $($a.Arguments) $($a.WorkingDirectory)"
    if ($line -like '*aiwork*') { Write-Output ("  " + $t.TaskName + " :: " + $line) }
  }
}
Write-Output '=== tasks referencing D:\web\spbox ==='
foreach ($t in Get-ScheduledTask) {
  foreach ($a in @($t.Actions)) {
    $line = "$($a.Execute) $($a.Arguments) $($a.WorkingDirectory)"
    if ($line -like '*spbox*') { Write-Output ("  " + $t.TaskName + " :: " + $line) }
  }
}
Write-Output '=== ssh-related tasks (must stay untouched) ==='
Get-ScheduledTask | Where-Object { $_.TaskName -like 'WbSsh*' } | ForEach-Object {
  $a = @($_.Actions)[0]
  Write-Output ("  " + $_.TaskName + " state=" + $_.State + " :: " + $a.Execute + " " + $a.Arguments)
}
Write-Output '=== running processes mentioning aiwork ==='
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*aiwork*' } |
  ForEach-Object { Write-Output ("  pid=" + $_.ProcessId + " " + ($_.CommandLine -replace '\s+',' ').Substring(0, [Math]::Min(150, ($_.CommandLine -replace '\s+',' ').Length))) }
Write-Output '=== old dir size ==='
if (Test-Path 'C:\aiwork\spbox') {
  $s = (Get-ChildItem 'C:\aiwork\spbox' -Recurse -File | Measure-Object -Property Length -Sum).Sum
  Write-Output ("  C:\aiwork\spbox bytes=" + $s)
}
Write-Output 'COOKIE audit done'
