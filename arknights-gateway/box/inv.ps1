$ErrorActionPreference='Continue'
Write-Output "=== D:\web ==="
if (Test-Path 'D:\web') { Get-ChildItem 'D:\web' | Select-Object Name,Length,LastWriteTime | Format-Table -AutoSize | Out-String -Width 160 } else { Write-Output "NO D:\web" }
Write-Output "=== C:\aiwork tree ==="
if (Test-Path 'C:\aiwork') { Get-ChildItem 'C:\aiwork' -Recurse -Depth 1 | Select-Object FullName | Format-Table -AutoSize | Out-String -Width 200 } else { Write-Output "NO C:\aiwork" }
Write-Output "=== drives ==="
Get-PSDrive -PSProvider FileSystem | Select-Object Name,Root,Used,Free | Format-Table -AutoSize | Out-String -Width 160
Write-Output "=== tasks ==="
Get-ScheduledTask | Where-Object { $_.TaskName -match 'Sp|Ark|Nyat|Probe|Collect' } | Select-Object TaskName,State | Format-Table -AutoSize | Out-String -Width 160
