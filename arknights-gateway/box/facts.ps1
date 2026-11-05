$ErrorActionPreference = 'Continue'
# Read-only facts probe (ASCII only).
Write-Output '=== active_slot.json ==='
Get-Content 'D:\stronghold\update\active_slot.json' -Raw -ErrorAction SilentlyContinue
Write-Output '=== sp_slots.json ==='
Get-Content 'D:\stronghold\update\sp_slots.json' -Raw -ErrorAction SilentlyContinue
Write-Output '=== nginx sp_current.conf ==='
Get-Content 'D:\stronghold\nginx\conf\sp_current.conf' -Raw -ErrorAction SilentlyContinue
Write-Output '=== deployed.json ==='
Get-Content 'D:\stronghold\update\deployed.json' -Raw -ErrorAction SilentlyContinue

$js = @'
const ports = [3000, 3001, 3002];
(async () => {
  for (const p of ports) {
    try {
      const r = await fetch('http://127.0.0.1:' + p + '/healthz', { signal: AbortSignal.timeout(4000) });
      const j = await r.json();
      console.log('  port=' + p + ' build=' + j.build + ' uptime=' + j.uptimeSec + ' humans=' + j.humans + ' app=' + j.app);
    } catch (e) {
      console.log('  port=' + p + ' ERR ' + e.message);
    }
  }
  for (const url of ['https://weishu.jiangjiangze.icu/healthz', 'https://www.u712507.nyat.app:45038/healthz']) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      console.log('  ' + url + ' -> build=' + j.build + ' uptime=' + j.uptimeSec + ' humans=' + j.humans + ' app=' + j.app);
    } catch (e) {
      console.log('  ' + url + ' ERR ' + e.message);
    }
  }
})();
'@
$tmp = Join-Path $env:TEMP 'sp_facts_hc.mjs'
[IO.File]::WriteAllText($tmp, $js)
& 'C:\Program Files\nodejs\node.exe' $tmp
Write-Output '=== tails ==='
foreach ($f in 'D:\stronghold\logs\autoupdate2.log', 'D:\stronghold\logs\guard.log', 'D:\stronghold\logs\update-zip.log') {
  Write-Output ('--- ' + $f)
  Get-Content $f -Tail 6 -ErrorAction SilentlyContinue
}
Write-Output 'COOKIE facts done'
