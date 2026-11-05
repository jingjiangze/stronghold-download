$ErrorActionPreference='Continue'
foreach ($t in @('SpChannelProbe','SpDirectory')) {
  Write-Output "=== $t ==="
  $a = (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue).Actions
  foreach ($x in $a) { Write-Output ("  exe=" + $x.Execute + " args=" + $x.Arguments + " wd=" + $x.WorkingDirectory) }
}
Write-Output "=== D:\web\spbox exists? ==="
Test-Path 'D:\web\spbox'
