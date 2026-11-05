$ErrorActionPreference = 'Continue'
# Read-only slot/nginx facts (ASCII only).
Write-Output '=== who owns 3000/3001/3002 ==='
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalPort -ge 3000 -and $_.LocalPort -le 3002 } |
  ForEach-Object {
    $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue
    Write-Output ("  port=" + $_.LocalPort + " pid=" + $_.OwningProcess + " name=" + $p.ProcessName + " started=" + $p.StartTime)
  }

Write-Output '=== nginx conf dir ==='
Get-ChildItem 'D:\stronghold\nginx\conf' -Recurse -ErrorAction SilentlyContinue |
  Select-Object FullName, LastWriteTime, Length | Format-Table -AutoSize | Out-String -Width 160

Write-Output '=== nginx RUNNING config (upstream refs) ==='
$out = & 'D:\stronghold\nginx\nginx.exe' -T -p 'D:\stronghold\nginx' 2>&1
$out | Select-String -Pattern 'upstream|proxy_pass|server 127|include' | Select-Object -First 30 | ForEach-Object { Write-Output ('  ' + $_.Line.Trim()) }

Write-Output '=== box -> public weishu healthz ==='
$js = @'
(async () => {
  try {
    const r = await fetch('https://weishu.jiangjiangze.icu/healthz', { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    console.log('  public build=' + j.build + ' uptime=' + j.uptimeSec + ' humans=' + j.humans);
  } catch (e) { console.log('  public ERR ' + e.message); }
  for (const p of [3000, 3001, 3002]) {
    try {
      const r = await fetch('http://127.0.0.1:' + p + '/healthz', { signal: AbortSignal.timeout(4000) });
      const j = await r.json();
      console.log('  local ' + p + ' build=' + j.build + ' uptime=' + j.uptimeSec + ' humans=' + j.humans + ' matches=' + j.matches);
    } catch (e) { console.log('  local ' + p + ' ERR ' + e.message); }
  }
})();
'@
$tmp = Join-Path $env:TEMP 'sp_slot_check.mjs'
[IO.File]::WriteAllText($tmp, $js)
& 'C:\Program Files\nodejs\node.exe' $tmp

Write-Output '=== active_slot.json mtime ==='
Get-Item 'D:\stronghold\update\active_slot.json','D:\stronghold\update\sp_slots.json','D:\stronghold\nginx\conf\sp_current.conf' -ErrorAction SilentlyContinue |
  Select-Object Name, LastWriteTime | Format-Table -AutoSize | Out-String -Width 120
Write-Output 'COOKIE slot done'
