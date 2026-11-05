# Installs the windowless box channel-probe task (runs before anyone logs in).
#
# One ssh call:
#   ssh wbssh 'powershell -NoProfile -NonInteractive -Command -' < install-probe-task.ps1
#
# Task SpChannelProbe: BootTrigger + Repetition PT5M watchdog, S4U + Highest,
# launcher runs powershell -WindowStyle Hidden.
# The real cadence is Start-Sleep 300 inside run-probe.ps1.
#
# Why full XML + schtasks /Create instead of Register-ScheduledTask:
# this box is PS 5.1 / ScheduledTasks 1.0 -- New-ScheduledTaskTrigger has no
# -RepetitionInterval, -Daily's .Repetition is $null, CIM assignment works only
# sometimes, and Register-ScheduledTask -Xml rejects the exported XML.

$ErrorActionPreference = 'Continue'

$Dir    = 'D:\web\spbox'
$Runner = Join-Path $Dir 'run-probe.ps1'
$Task   = 'SpChannelProbe'

if (-not (Test-Path $Runner)) { Write-Output 'COOKIE missing-runner'; exit 1 }

$Ps  = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$Arg = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Runner`""

# UserId must be MACHINE\user (S4U fails silently with a bare user name).
# $env:USERNAME can be empty inside the ssh stdin pipe, so take it from the identity.
$User = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
if (-not $User) { $User = "$env:COMPUTERNAME\Administrator" }
Write-Output "principal=$User computer=$env:COMPUTERNAME"

$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>$User</Author>
    <Description>Stronghold Protocol channel probe (5 min, windowless)</Description>
  </RegistrationInfo>
  <Triggers>
    <BootTrigger>
      <Enabled>true</Enabled>
      <Repetition>
        <Interval>PT5M</Interval>
        <Duration>P1D</Duration>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </BootTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$User</UserId>
      <LogonType>S4U</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT5M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>$Ps</Command>
      <Arguments>$Arg</Arguments>
      <WorkingDirectory>$Dir</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@

$xmlPath = Join-Path $Dir 'task-probe.xml'
[IO.File]::WriteAllText($xmlPath, $xml, [Text.UnicodeEncoding]::new($false, $true))
$sch = & "$env:SystemRoot\System32\schtasks.exe" /Create /TN $Task /XML $xmlPath /F 2>&1
Write-Output ("create=" + ($sch -join ' | '))
Remove-Item $xmlPath -Force -ErrorAction SilentlyContinue

# Kill only the old loop processes for this runner (they hold whatever interval
# they started with). Never kill by process name -- other resident tasks live here.
Stop-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*run-probe.ps1*' } |
  ForEach-Object {
    Write-Output ("kill pid=" + $_.ProcessId)
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
Start-Sleep -Seconds 2

Start-ScheduledTask -TaskName $Task
Start-Sleep -Seconds 8

$t = Get-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue
Write-Output ("state=" + $t.State + " triggers=" + @($t.Triggers).Count)
foreach ($tr in $t.Triggers) {
  Write-Output ("trigger start=" + $tr.StartBoundary + " rep=" + $tr.Repetition.Interval)
}
$princ = (Get-ScheduledTask -TaskName $Task).Principal
Write-Output ("principal-user=" + $princ.UserId + " logon=" + $princ.LogonType)
$log = Join-Path $Dir 'logs\probe.log'
if (Test-Path $log) { Write-Output 'log-tail:'; Get-Content $log -Tail 4 }
Write-Output ("COOKIE " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' install-probe-task done')
