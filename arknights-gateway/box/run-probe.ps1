# Box-side channel probe launcher (windowless)
#
# Invoked by the scheduled task, do not double-click:
#   powershell -NoProfile -ExecutionPolicy Bypass -File D:\web\spbox\run-probe.ps1
#
# Runs probe.mjs every N seconds (default 300 = 5 minutes) and logs to spbox\logs\probe.log.
# probe.mjs 只读本机 127.0.0.1:3000 的 /healthz + 进程采样后回传；
# 不发任何外部请求、不调 Globalping（延迟已改为玩家浏览器自主探测）。

$ErrorActionPreference = 'Continue'

$Dir      = 'D:\web\spbox'
$Node     = 'C:\Program Files\nodejs\node.exe'
if (-not (Test-Path $Node)) { $Node = 'node' }
$Script   = Join-Path $Dir 'probe.mjs'
$LogDir   = Join-Path $Dir 'logs'
$Interval = 300
if ($env:SP_PROBE_INTERVAL_SEC) { $Interval = [int]$env:SP_PROBE_INTERVAL_SEC }

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

function Write-Log([string]$msg) {
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Add-Content -Path (Join-Path $LogDir 'probe.log') -Value $line -Encoding UTF8
}

Write-Log "start interval=$Interval node=$Node"

while ($true) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $out = Join-Path $LogDir "probe-$stamp.out.log"
  $err = Join-Path $LogDir "probe-$stamp.err.log"
  try {
    $p = Start-Process -FilePath $Node -ArgumentList @($Script) -WorkingDirectory $Dir `
           -NoNewWindow -Wait -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
    $code = $p.ExitCode
    if ($code -eq 0) {
      Write-Log "ok exit=0"
    } else {
      $tail = ''
      if (Test-Path $err) { $tail = (Get-Content $err -Tail 3 -ErrorAction SilentlyContinue) -join ' | ' }
      Write-Log "fail exit=$code err=$tail"
    }
  } catch {
    Write-Log "launch-failed $($_.Exception.Message)"
  }

  # Keep 3 days of per-run logs so they don't pile up forever.
  Get-ChildItem -Path $LogDir -Filter 'probe-*.log' -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-3) } |
    Remove-Item -Force -ErrorAction SilentlyContinue

  Start-Sleep -Seconds $Interval
}
