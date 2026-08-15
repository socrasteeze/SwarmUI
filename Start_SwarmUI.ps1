# Starts the SwarmUI server if it is not already running, then waits for it to answer. Idempotent: if the
# server is already up this is a no-op.
#
# Fork edit (2026-08): this used to also open a browser tab / the installed PWA once the server answered.
# That default is gone - the fork owner does not want a browser window forced open on every launch, restart,
# or (previously) in-app restart that happened to route back through this script. Opening the UI is now
# strictly opt-in via -OpenBrowser; every normal invocation (Start_SwarmUI.bat, the Desktop/Start Menu/Startup
# shortcuts, this script run bare) starts the server and nothing else.
#
# Invoked by Start_SwarmUI.bat. Run directly with -OpenBrowser to also open the UI once it's up.

param(
    [switch]$OpenBrowser,
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

# --- Is a server from THIS install already running, listening or not? ---
# The port probe above only sees a server that has finished starting. On a large library (tens of thousands of
# LoRAs) Swarm can take minutes to bind its port, and every launch during that window sails straight past the
# probe and starts a second server. The second one dies on the Data\Users.ldb exclusive lock, but by then it
# has already spawned its own ComfyUI child, which survives as an orphan holding several GB of VRAM.
# Matching on the process gives the check something true from the first second of startup.
function Get-SwarmProcess {
    foreach ($proc in @(Get-Process -Name SwarmUI -ErrorAction SilentlyContinue)) {
        try {
            # Scoped to this folder so a second Swarm install elsewhere is not mistaken for this one.
            if ($proc.Path -and $proc.Path.StartsWith($PSScriptRoot, [StringComparison]::OrdinalIgnoreCase)) {
                return $proc
            }
        }
        catch {
            # Path can be unreadable for a process we cannot open; treat it as not ours rather than guessing.
        }
    }
    return $null
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
    if ($OpenBrowser) { Open-SwarmUI -Port $port }
    exit 0
}

# --- Only one launcher may be in the "start it" phase at a time. ---
# The port probe and the process check together still leave a hole: launch-fork.bat does a git fetch and a
# build check before SwarmUI.exe exists at all, so for several seconds there is nothing listening AND no
# process to find. Two launches inside that hole - the login entry and an impatient click on the desktop
# shortcut - both decide the server is down and both start one. The loser dies on the Data\Users.ldb lock
# having already spawned a ComfyUI child, which is then orphaned and keeps its VRAM.
# The mutex name is tied to the install folder so two separate Swarm installs do not block each other.
$mutexName = 'Local\SwarmUI_Launcher_' + ($PSScriptRoot -replace '[^A-Za-z0-9]', '_')
$mutex = New-Object System.Threading.Mutex($false, $mutexName)
$ownsMutex = $false
try {
    try {
        $ownsMutex = $mutex.WaitOne(0)
    }
    catch [System.Threading.AbandonedMutexException] {
        # A previous launcher died holding it. The mutex is ours now.
        $ownsMutex = $true
    }

    if (-not $ownsMutex) {
        Write-Host "  Another launcher is already starting the server - waiting for it rather than starting a second."
    }
    else {
        $starting = Get-SwarmProcess
        if ($starting) {
            Write-Host "  A SwarmUI server (PID $($starting.Id)) is already starting - waiting for it instead of starting another."
        }
        else {
            $launcher = if (Test-Path (Join-Path $PSScriptRoot 'launch-fork.bat')) { 'launch-fork.bat' } else { 'launch-windows.bat' }
            $launcherPath = Join-Path $PSScriptRoot $launcher
            if (-not (Test-Path $launcherPath)) {
                Write-Host "  ERROR: no launcher found in $PSScriptRoot" -ForegroundColor Red
                exit 1
            }

            Write-Host "  Starting server via $launcher (first run after a git pull will rebuild, which takes a while)..."
            # Launched by absolute path, not by name. cmd does not search the current directory when
            # NoDefaultCurrentDirectoryInExePath is set, so 'cmd /c launch-fork.bat' fails with "not recognized" on a
            # hardened machine even with the working directory set correctly. Starting the .bat directly also gives the
            # server its own console window, so build output and errors stay visible.
            Start-Process -FilePath $launcherPath -WorkingDirectory $PSScriptRoot
        }
    }

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $dots = 0
    while ((Get-Date) -lt $deadline) {
        if (Test-SwarmUp -Port $port) {
            Write-Host ""
            Write-Host "  Server is up."
            if ($OpenBrowser) { Open-SwarmUI -Port $port }
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
}
finally {
    if ($ownsMutex) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
