# Sample the LIVE game-server process: working set (MB) + CPU percent over ~1.2s.
#
# Why a helper: /healthz does not report memory or CPU, so the box-side probe has to
# read the OS. The active slot port comes from the blue/green bookkeeping file
# (D:\stronghold\update\active_slot.json, written by sp_update2); port 3000 is only the
# nginx shim, so sampling the nginx PID would be meaningless.
#
# Output: one JSON line on stdout. Never throws -- callers fall back to null values.
# ASCII only: PS 5.1 mis-decodes UTF-8 files without BOM.

$ErrorActionPreference = 'Continue'

$slotFile = 'D:\stronghold\update\active_slot.json'
$port = $null
try {
  $slot = Get-Content $slotFile -Raw -ErrorAction Stop | ConvertFrom-Json
  $port = [int]$slot.port
} catch {
  Write-Output '{"ok":false,"error":"active_slot unreadable"}'
  exit 0
}
if (-not $port) {
  Write-Output '{"ok":false,"error":"active_slot has no port"}'
  exit 0
}

$conn = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $conn) {
  Write-Output ('{"ok":false,"error":"no listener on port ' + $port + '"}')
  exit 0
}
$procId = [int]$conn.OwningProcess

$proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
if (-not $proc) {
  Write-Output ('{"ok":false,"error":"process ' + $procId + ' gone"}')
  exit 0
}

# CPU percent = (user+kernel time delta) / (wall time delta), as % of ONE core.
# Win32_PerfFormattedData is noisy for short windows; diffing raw 100ns counters is exact.
$p1 = Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction SilentlyContinue
if (-not $p1) {
  Write-Output ('{"ok":false,"error":"cim1 gone"}')
  exit 0
}
$t1 = [int64]$p1.UserModeTime + [int64]$p1.KernelModeTime
$w1 = Get-Date
Start-Sleep -Milliseconds 1200
$p2 = Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction SilentlyContinue
if (-not $p2) {
  Write-Output ('{"ok":false,"error":"cim2 gone"}')
  exit 0
}
$t2 = [int64]$p2.UserModeTime + [int64]$p2.KernelModeTime
$w2 = Get-Date

$wallMs = [double]($w2 - $w1).TotalMilliseconds
$cpuMs = [double]($t2 - $t1) / 10000.0
$cpuPct = 0.0
if ($wallMs -gt 0) { $cpuPct = [math]::Round($cpuMs / $wallMs * 100, 1) }
$rssMb = [math]::Round($proc.WorkingSet64 / 1MB, 1)

$out = [ordered]@{ ok = $true; port = $port; pid = $procId; rssMb = $rssMb; cpuPct = $cpuPct }
Write-Output ($out | ConvertTo-Json -Compress)
