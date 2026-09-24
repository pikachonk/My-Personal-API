param([Parameter(Mandatory=$true)][string]$Config)
$ErrorActionPreference = 'Stop'
$configPath = (Resolve-Path -LiteralPath $Config).Path
$pairing = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
if ($pairing.platform -ne 'windows') { throw 'Create a Windows device pairing in the dashboard.' }
$pythonCommand = Get-Command python.exe -ErrorAction Stop
$pythonExe = & $pythonCommand.Source -c 'import sys; print(sys.executable)'
if ($LASTEXITCODE -ne 0) { throw 'Install Python 3.12 or newer first.' }
$pythonWindowless = Join-Path (Split-Path $pythonExe) 'pythonw.exe'
if (-not (Test-Path -LiteralPath $pythonWindowless)) { throw 'pythonw.exe was not found beside Python.' }
$installDir = Join-Path $env:LOCALAPPDATA 'Daybook\collector'
New-Item -ItemType Directory -Path $installDir -Force | Out-Null
foreach ($name in @('windows_screen.py', 'sync_client.py')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $installDir $name) -Force
}
$installedConfig = Join-Path $installDir 'device.json'
Copy-Item -LiteralPath $configPath -Destination $installedConfig -Force
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $installedConfig /inheritance:r /grant:r "${identity}:(F)" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not restrict access to the pairing key.' }
$startupDir = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startupDir 'SimonSealsAPI Screen Time.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $pythonWindowless
$shortcut.Arguments = '"' + (Join-Path $installDir 'windows_screen.py') + '" --config "' + $installedConfig + '"'
$shortcut.WorkingDirectory = $installDir
$shortcut.WindowStyle = 7
$shortcut.Save()
$legacyShortcutPath = Join-Path $startupDir 'Daybook Screen Time.lnk'
if (Test-Path -LiteralPath $legacyShortcutPath) {
    $legacyShortcut = $shell.CreateShortcut($legacyShortcutPath)
    if ($legacyShortcut.TargetPath -eq $shortcut.TargetPath -and $legacyShortcut.Arguments -eq $shortcut.Arguments) {
        Remove-Item -LiteralPath $legacyShortcutPath
    }
}
Start-Process -FilePath $pythonWindowless -ArgumentList $shortcut.Arguments -WorkingDirectory $installDir -WindowStyle Hidden
Write-Output 'SimonSealsAPI is collecting automatically and will start at sign-in.'
Write-Output 'To stop syncing, revoke this device in the dashboard. Remove the SimonSealsAPI Screen Time startup shortcut to disable future collection.'
