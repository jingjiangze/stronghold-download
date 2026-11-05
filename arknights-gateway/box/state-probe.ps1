$ErrorActionPreference = 'Continue'
# Read-only state probe. ASCII only (PS 5.1 mis-decodes UTF-8 files).
Write-Output '=== listening ports 2999-3010 ==='
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalPort -ge 2999 -and $_.LocalPort -le 3010 } |
  Select-Object LocalAddress, LocalPort, OwningProcess |
  Sort-Object LocalPort | Format-Table -AutoSize | Out-String -Width 120

Write-Output '=== local healthz on candidate ports ==='
foreach ($p in 3000, 3001, 3002, 3003) {
  try {
    $r = Invoke-WebRequest -Uri ("http://127.0.0.1:" + $p + "/healthz") -TimeoutSec 4 -UseBasicParsing
    $j = $r.Content | ConvertFrom-Json
    Write-Output ("  port=" + $p + " ok=" + $j.ok + " app=" + $j.app + " build=" + $j.build + " uptime=" + $j.uptimeSec + " humans=" + $j.humans)
  } catch {
    Write-Output ("  port=" + $p + " ERR " + $_.Exception.Message)
  }
}

Write-Output '=== node processes ==='
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  ForEach-Object {
    $cl = ($_.CommandLine -replace '\s+', ' ')
    if ($cl.Length -gt 160) { $cl = $cl.Substring(0, 160) }
    Write-Output ("  pid=" + $_.ProcessId + " " + $cl)
  }

Write-Output '=== Sp*/Stronghold scheduled tasks ==='
Get-ScheduledTask | Where-Object { $_.TaskName -match 'Sp|Stronghold|WbSsh' } |
  Select-Object TaskName, State | Format-Table -AutoSize | Out-String -Width 120

Write-Output '=== C:\aiwork ==='
if (Test-Path 'C:\aiwork') { Get-ChildItem 'C:\aiwork' -Recurse -File | Select-Object FullName, Length | Format-Table -AutoSize | Out-String -Width 160 } else { Write-Output '  (none)' }

Write-Output '=== D:\stronghold top ==='
if (Test-Path 'D:\stronghold') { Get-ChildItem 'D:\stronghold' | Select-Object Name, LastWriteTime | Format-Table -AutoSize | Out-String -Width 120 } else { Write-Output '  (none)' }

Write-Output '=== PAUSE_AUTOUPDATE ==='
foreach ($f in 'D:\stronghold\Stronghold-Protocol-cdn\update\PAUSE_AUTOUPDATE','D:\stronghold\Stronghold-Protocol\update\PAUSE_AUTOUPDATE') {
  Write-Output ("  " + $f + " exists=" + (Test-Path $f))
}

Write-Output '=== files modified in D:\stronghold in last 6h ==='
$cut = (Get-Date).AddHours(-6)
Get-ChildItem 'D:\stronghold' -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object { $_.LastWriteTime -gt $cut } |
  Select-Object -First 25 FullName, LastWriteTime |
  Format-Table -AutoSize | Out-String -Width 160

Write-Output 'COOKIE probe done'
