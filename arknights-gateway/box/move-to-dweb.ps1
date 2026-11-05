$ErrorActionPreference = 'Continue'
# Move the box-side project from C:\aiwork\spbox to D:\web\spbox.
# C: has only 5 GB free, D: has 400+ GB. robocopy /E keeps structure and timestamps.
# Copy first (no /MOVE): the scheduled tasks still point at C: until reinstalled.
$src = 'C:\aiwork\spbox'
$dst = 'D:\web\spbox'

if (-not (Test-Path $src)) { Write-Output 'NO-SRC'; exit 1 }
if (-not (Test-Path 'D:\web')) { New-Item -ItemType Directory -Path 'D:\web' -Force | Out-Null }

robocopy $src $dst /E /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null
Write-Output ("robocopy-exit=" + $LASTEXITCODE)

Write-Output '=== D:\web\spbox ==='
Get-ChildItem $dst | Select-Object Name, Length | Format-Table -AutoSize | Out-String -Width 140
Write-Output '=== logs ==='
if (Test-Path (Join-Path $dst 'logs')) { Get-ChildItem (Join-Path $dst 'logs') | Select-Object Name, Length | Format-Table -AutoSize | Out-String -Width 140 }
Write-Output 'COOKIE move done'
