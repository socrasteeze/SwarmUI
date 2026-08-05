# Starts the SwarmUI server if it is not already running, waits for it to answer, then opens the UI.
#
# Why this exists: this install has LaunchMode=none, so the server never opens a browser itself. That left two
# desktop icons that each did half the job - the launcher gave you a console with no UI, and the installed PWA
# shortcut gave you a blank window because nothing was listening. This does both, in the right order, and is
# idempotent: if the server is already up it just opens the UI.
#
# Invoked by Start_SwarmUI.bat. Run directly with -NoBrowser to start the server only.

param(
    [switch]$NoBrowser,
    [int]$TimeoutSeconds = 300
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# --- Which port is this install on? Read it rather than assuming 7801. ---
function Get-SwarmPort {
    $settings = Join-Path $PSScriptRoot 'Data\Settings.fds'
    if (Test-Path $settings) {
        # 'Port:' only - 'PortCanChange:' has no colon straight after "Port" so it cannot match.
        $hit = Select-String -Path $settings -Pattern '^\s*Port:\s*(\d+)\s*$' | Select-Object -First 1
        if ($hit) {
            return [int]$hit.Matches[0].Groups[1].Value
        }
    }
    return 7801
}

# --- Is something already listening? ---
function Test-SwarmUp {
    param([int]$Port, [int]$TimeoutMs = 500)
    $client = $null
    try {
        $client = New-Object Net.Sockets.TcpClient
        $task = $client.ConnectAsync('127.0.0.1', $Port)
        $completed = $task.Wait($TimeoutMs)
        return ($completed -and -not $task.IsFaulted -and $client.Connected)
    }
    catch {
        return $false
    }
    finally {
        if ($client) { $client.Close() }
    }
}

# --- Prefer the installed PWA window over a browser tab, but never hard-depend on it. ---
function Open-SwarmUI {
    param([int]$Port)
    $shell = New-Object -ComObject WScript.Shell
    foreach ($folder in @('Desktop', 'Programs')) {
        $dir = [Environment]::GetFolderPath($folder)
        if (-not $dir) { continue }
        $lnk = Join-Path $dir 'SwarmUI.lnk'
        if (-not (Test-Path $lnk)) { continue }
        $target = $shell.CreateShortcut($lnk).TargetPath
        # Only treat it as the PWA if it actually points at a browser. A shortcut named SwarmUI that points at a
        # .bat is somebody's launcher, and opening it here would start a second server.
        if ($target -match '(?i)(chrome_proxy|chrome|msedge|brave|firefox)\.exe$') {
            Write-Host "  Opening the installed app window..."
            Start-Process -FilePath $lnk
            return
        }
    }
    Write-Host "  Opening http://localhost:$Port ..."
    Start-Process "http://localhost:$Port"
}

$port = Get-SwarmPort
Write-Host ""
Write-Host "SwarmUI launcher - port $port"

if (Test-SwarmUp -Port $port) {
    Write-Host "  Server is already running."
    if (-not $NoBrowser) { Open-SwarmUI -Port $port }
    exit 0
}

$launcher = if (Test-Path (Join-Path $PSScriptRoot 'launch-fork.bat')) { 'launch-fork.bat' } else { 'launch-windows.bat' }
$launcherPath = Join-Path $PSScriptRoot $launcher
if (-not (Test-Path $launcherPath)) {
    Write-Host "  ERROR: no launcher found in $PSScriptRoot" -ForegroundColor Red
    exit 1
}

Write-Host "  Starting server via $launcher (first run after a git pull will rebuild, which takes a while)..."
# Launched by absolute path, not by name. cmd does not search the current directory when
# NoDefaultCurrentDirectoryInExePath is set, so 'cmd /c launch-fork.bat' fails with "not recognized" on a hardened
# machine even with the working directory set correctly. Starting the .bat directly also gives the server its own
# console window, so build output and errors stay visible.
Start-Process -FilePath $launcherPath -WorkingDirectory $PSScriptRoot

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$dots = 0
while ((Get-Date) -lt $deadline) {
    if (Test-SwarmUp -Port $port) {
        Write-Host ""
        Write-Host "  Server is up."
        if (-not $NoBrowser) { Open-SwarmUI -Port $port }
        exit 0
    }
    Start-Sleep -Milliseconds 1000
    $dots++
    if ($dots % 5 -eq 0) { Write-Host "  ...still waiting ($dots s)" }
}

Write-Host ""
Write-Host "  Gave up waiting after $TimeoutSeconds seconds." -ForegroundColor Yellow
Write-Host "  The server window is still open - check it for build errors, then open http://localhost:$port yourself."
exit 1
