param([string]$Root = "$env:ProgramData\DoubaoWorkshopUpdates", [string]$ListenAddress = '10.1.11.88', [int]$Port = 17824)
$ErrorActionPreference = 'Stop'
$nodeExe = (Get-Command node.exe).Source
$taskName = 'DoubaoWorkshopUpdates'
if (-not (Test-Path -LiteralPath (Join-Path $Root 'update-server.cjs'))) { throw 'Upload update-server.cjs before installing the service.' }
New-Item -ItemType Directory -Path (Join-Path $Root 'public') -Force | Out-Null
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) { Stop-ScheduledTask -TaskName $taskName }
$action = New-ScheduledTaskAction -Execute $nodeExe -Argument "`"$Root\update-server.cjs`" --root `"$Root\public`" --host $ListenAddress --port $Port"
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 100 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -User 'SYSTEM' -RunLevel Highest -Force | Out-Null
if (-not (Get-NetFirewallRule -Name $taskName -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -Name $taskName -DisplayName 'Doubao Workshop LAN updates' -Direction Inbound -Action Allow -Protocol TCP -LocalAddress $ListenAddress -LocalPort $Port -RemoteAddress LocalSubnet -Program $nodeExe -Profile Any | Out-Null
}
Start-ScheduledTask -TaskName $taskName
Write-Output "Update service installed: http://${ListenAddress}:${Port}/latest.json"
