# Modeler launcher for Windows: installs, updates and starts the app on this PC.
#
# Each launch fetches the latest version from GitHub (when online), reinstalls packages if they
# changed, starts the local server and opens the app in the browser. The AI chat uses this PC's
# Claude Code (or Codex) login, the same as running `npm run dev` from a checkout.
#
#   modeler.ps1 -Install    first run: also adds a "Modeler" shortcut to the desktop
#   modeler.ps1             what the shortcut runs
#   -Root <dir>             where it lives (default %LOCALAPPDATA%\Modeler)
#   -NoLaunch               update only; don't start the app
#   -Port <n>               the local port (default 5173)
#
# Windows PowerShell 5.1 compatible. Started by "Install Modeler.cmd" (same folder).
param(
  [switch]$Install,
  [switch]$NoLaunch,
  [string]$Root = (Join-Path $env:LOCALAPPDATA 'Modeler'),
  [int]$Port = 5173
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # Invoke-WebRequest is very slow with its progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Repo = 'admolofto/new_modeler'
$Url = "http://localhost:$Port/"
$App = Join-Path $Root 'app'
$VersionFile = Join-Path $Root 'version.txt'
$LockHashFile = Join-Path $Root 'packages.txt'
$Log = Join-Path $Root 'modeler.log'

New-Item -ItemType Directory -Force -Path $Root | Out-Null
Add-Type -AssemblyName System.Windows.Forms

function Say([string]$text) {
  Write-Host $text
  Add-Content -Path $Log -Value ("{0:yyyy-MM-dd HH:mm:ss}  {1}" -f (Get-Date), $text)
}

function Tell([string]$text, [string]$icon = 'Information') {
  Say $text
  [void][System.Windows.Forms.MessageBox]::Show($text, 'Modeler', 'OK', $icon)
}

function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

function Ensure-Node {
  if (Get-Command node -ErrorAction SilentlyContinue) { return }
  Say 'Node.js is not installed; installing it.'
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    winget install --exact --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements | Out-Host
    Refresh-Path
  }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Start-Process 'https://nodejs.org/en/download'
    Tell "Modeler needs Node.js. The download page is open: install the Windows version, then double-click Modeler again." 'Warning'
    exit 1
  }
}

function Server-Up {
  try {
    Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2 | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Update-App {
  $current = ''
  if (Test-Path $VersionFile) { $current = (Get-Content $VersionFile -Raw).Trim() }
  try {
    $latest = (Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/commits/main" -Headers @{ Accept = 'application/vnd.github.sha' } -TimeoutSec 20).ToString().Trim()
  } catch {
    if (Test-Path $App) { Say "Couldn't check for updates (offline?); starting the version already here."; return }
    Tell "Modeler couldn't download. Check the internet connection and try again." 'Error'
    exit 1
  }
  if ($latest -eq $current -and (Test-Path $App)) { Say "Up to date ($($latest.Substring(0, 7)))."; return }

  Say "Downloading version $($latest.Substring(0, 7))..."
  $zip = Join-Path $env:TEMP "modeler-$latest.zip"
  $unzip = Join-Path $env:TEMP "modeler-$latest"
  Invoke-WebRequest -Uri "https://codeload.github.com/$Repo/zip/$latest" -OutFile $zip -UseBasicParsing
  if (Test-Path $unzip) { Remove-Item -Recurse -Force $unzip }
  Expand-Archive -Path $zip -DestinationPath $unzip -Force
  $source = (Get-ChildItem $unzip -Directory | Select-Object -First 1).FullName
  # Mirror the new version in; packages and local settings stay.
  robocopy $source $App /MIR /XD node_modules /XF .env.local /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { Tell "Modeler couldn't update its files (robocopy error $LASTEXITCODE)." 'Error'; exit 1 }
  Remove-Item -Recurse -Force $unzip, $zip -ErrorAction SilentlyContinue
  Set-Content -Path $VersionFile -Value $latest

  # The launcher updates itself too; the new copy runs next time.
  $launcher = Join-Path $App 'scripts\windows\modeler.ps1'
  if (Test-Path $launcher) { Copy-Item $launcher (Join-Path $Root 'modeler.ps1') -Force }
}

function Install-Packages {
  $hash = (Get-FileHash (Join-Path $App 'package-lock.json')).Hash
  $old = ''
  if (Test-Path $LockHashFile) { $old = (Get-Content $LockHashFile -Raw).Trim() }
  if ($hash -eq $old -and (Test-Path (Join-Path $App 'node_modules'))) { return }
  Say 'Installing packages (the first time takes a few minutes)...'
  Push-Location $App
  try {
    & npm.cmd ci --no-audit --no-fund | Out-Host
    if ($LASTEXITCODE -ne 0) { Tell "Modeler couldn't install its packages (npm error $LASTEXITCODE). Details: $Log" 'Error'; exit 1 }
  } finally {
    Pop-Location
  }
  Set-Content -Path $LockHashFile -Value $hash
}

function Add-Shortcut {
  $self = Join-Path $Root 'modeler.ps1'
  if ($PSCommandPath -ne $self) { Copy-Item $PSCommandPath $self -Force }
  $shell = New-Object -ComObject WScript.Shell
  $link = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Modeler.lnk'))
  $link.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $link.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Minimized -File `"$self`""
  $link.WorkingDirectory = $Root
  $link.IconLocation = (Join-Path $env:SystemRoot 'System32\shell32.dll') + ',41'
  $link.Description = 'Open Modeler'
  $link.Save()
  Say 'Added the Modeler shortcut to the desktop.'
}

if ($Install) { Add-Shortcut }

if (Server-Up) {
  # Already running (opened earlier): just show it.
  if (-not $NoLaunch) { Start-Process $Url }
  exit 0
}

Ensure-Node
Update-App
Install-Packages

if (-not (Get-Command claude -ErrorAction SilentlyContinue) -and -not (Get-Command codex -ErrorAction SilentlyContinue)) {
  Say 'Claude Code was not found; the AI chat will say so until it is installed and signed in.'
}

if ($NoLaunch) { exit 0 }

Say 'Starting Modeler...'
# The server runs in its own minimized window; closing that window stops Modeler.
Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', "title Modeler (close this window to stop Modeler) && npm.cmd run dev -- --port $Port" -WorkingDirectory $App -WindowStyle Minimized
for ($i = 0; $i -lt 60; $i++) {
  if (Server-Up) { Start-Process $Url; exit 0 }
  Start-Sleep -Seconds 1
}
Tell "Modeler didn't start. Details are in the Modeler window on the taskbar." 'Error'
exit 1
