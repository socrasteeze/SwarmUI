<#
.SYNOPSIS
    Clone your SwarmUI fork to another drive and retain all your existing settings.

.DESCRIPTION
    Git-clones the fork (so you get all your code enhancements as clean tracked code),
    then copies your personal config from an existing install's Data\ folder (skipping
    regenerable temp files). Optionally brings Models/, dlbackend/, and Output/ across,
    can fix absolute paths inside the copied config, and can launch the new instance.

    The ONLY difference between the new instance and your original is the enhancements.

.EXAMPLE
    .\setup-test-instance.ps1 -SourceInstall "C:\SwarmUI" -TargetPath "D:\SwarmUI"

.EXAMPLE
    # Symlink Models (saves disk), fix paths, and launch on port 7802 when done:
    .\setup-test-instance.ps1 -SourceInstall "C:\SwarmUI" -TargetPath "D:\SwarmUI" `
        -LinkModels -FixPaths -Launch
#>

[CmdletBinding()]
param(
    # Path to your EXISTING SwarmUI install (the one whose settings you want to keep).
    [Parameter(Mandatory = $true)]
    [string]$SourceInstall,

    # Where to create the new clone, e.g. "D:\SwarmUI".
    [Parameter(Mandatory = $true)]
    [string]$TargetPath,

    # Your fork's git URL.
    [string]$RepoUrl = "https://github.com/socrasteeze/SwarmUI.git",

    # Branch to clone.
    [string]$Branch = "master",

    # Port for the new instance (keep different from the original if running both at once).
    [int]$Port = 7802,

    # Copy Models\ across (large). Omit to configure models later or use -LinkModels.
    [switch]$IncludeModels,

    # Symlink Models\ to the source instead of copying (needs Admin / Developer Mode). Saves disk.
    [switch]$LinkModels,

    # Copy dlbackend\ (the auto-downloaded ComfyUI) so it isn't re-downloaded.
    [switch]$IncludeBackend,

    # Copy Output\ (your generated image history).
    [switch]$IncludeOutput,

    # Rewrite absolute paths in the copied Settings.fds / Backends.fds from the source
    # base path to the target base path.
    [switch]$FixPaths,

    # Launch the new instance when setup finishes.
    [switch]$Launch
)

$ErrorActionPreference = "Stop"

function Write-Step($msg)  { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)    { Write-Host "    $msg"   -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "    ! $msg" -ForegroundColor Yellow }

# robocopy returns 0-7 on success (8+ = real error); wrap so it doesn't trip $ErrorActionPreference.
function Invoke-Robocopy($from, $to, [string[]]$extraArgs) {
    $args = @($from, $to, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NP") + $extraArgs
    robocopy @args | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($from -> $to), exit code $LASTEXITCODE" }
}

# --- Validate ---------------------------------------------------------------
Write-Step "Validating inputs"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "git is not installed or not on PATH. Install Git for Windows first."
}
$srcData = Join-Path $SourceInstall "Data"
if (-not (Test-Path $srcData)) {
    throw "No Data\ folder found under source install '$SourceInstall'. Point -SourceInstall at your existing SwarmUI folder."
}
if ((Test-Path $TargetPath) -and (Get-ChildItem -Force $TargetPath | Select-Object -First 1)) {
    throw "Target '$TargetPath' already exists and is not empty. Choose an empty/new path."
}
if ($LinkModels -and $IncludeModels) {
    throw "Use either -IncludeModels (copy) or -LinkModels (symlink), not both."
}
Write-Ok "git found; source Data\ found; target path is clear."

# --- Clone ------------------------------------------------------------------
Write-Step "Cloning $RepoUrl (branch: $Branch) -> $TargetPath"
git clone --branch $Branch --single-branch $RepoUrl $TargetPath
if ($LASTEXITCODE -ne 0) { throw "git clone failed." }
Write-Ok "Clone complete (this includes all your enhancements)."

# --- Copy Data\ (the config) ------------------------------------------------
Write-Step "Copying settings from Data\ (excluding regenerable temp files)"
$dstData = Join-Path $TargetPath "Data"
# /XD skips the temp + debug dirs that regenerate on their own.
Invoke-Robocopy $srcData $dstData @("/XD", (Join-Path $srcData "tmp"), (Join-Path $srcData "DebugNewAPIDocs"))
Write-Ok "Settings, backends, users, roles, presets copied."

# --- Optional: Models -------------------------------------------------------
if ($LinkModels) {
    Write-Step "Symlinking Models\ -> $SourceInstall\Models"
    $srcModels = Join-Path $SourceInstall "Models"
    if (-not (Test-Path $srcModels)) { Write-Warn2 "Source has no Models\ folder; skipping." }
    else {
        try {
            New-Item -ItemType SymbolicLink -Path (Join-Path $TargetPath "Models") -Target $srcModels | Out-Null
            Write-Ok "Symlink created (no disk duplicated)."
        } catch {
            Write-Warn2 "Symlink failed (run PowerShell as Administrator, or enable Developer Mode). Models not linked."
        }
    }
}
elseif ($IncludeModels) {
    Write-Step "Copying Models\ (this can be large / slow)"
    $srcModels = Join-Path $SourceInstall "Models"
    if (-not (Test-Path $srcModels)) { Write-Warn2 "Source has no Models\ folder; skipping." }
    else { Invoke-Robocopy $srcModels (Join-Path $TargetPath "Models") @(); Write-Ok "Models copied." }
}

# --- Optional: dlbackend ----------------------------------------------------
if ($IncludeBackend) {
    Write-Step "Copying dlbackend\ (bundled ComfyUI)"
    $srcBack = Join-Path $SourceInstall "dlbackend"
    if (-not (Test-Path $srcBack)) { Write-Warn2 "Source has no dlbackend\; it will re-download on first run." }
    else { Invoke-Robocopy $srcBack (Join-Path $TargetPath "dlbackend") @(); Write-Ok "Backend copied." }
}

# --- Optional: Output -------------------------------------------------------
if ($IncludeOutput) {
    Write-Step "Copying Output\ (image history)"
    $srcOut = Join-Path $SourceInstall "Output"
    if (-not (Test-Path $srcOut)) { Write-Warn2 "Source has no Output\; skipping." }
    else { Invoke-Robocopy $srcOut (Join-Path $TargetPath "Output") @(); Write-Ok "Output copied." }
}

# --- Optional: fix absolute paths in config ---------------------------------
if ($FixPaths) {
    Write-Step "Rewriting absolute paths in config (source base -> target base)"
    $srcFull = (Resolve-Path $SourceInstall).Path.TrimEnd('\')
    $dstFull = (Resolve-Path $TargetPath).Path.TrimEnd('\')
    # Match both slash styles that may appear in .fds files.
    $pairs = @(
        @($srcFull,                 $dstFull),
        @($srcFull.Replace('\','/'), $dstFull.Replace('\','/'))
    )
    foreach ($name in @("Settings.fds", "Backends.fds")) {
        $file = Join-Path $dstData $name
        if (-not (Test-Path $file)) { continue }
        $text = Get-Content $file -Raw
        $orig = $text
        foreach ($p in $pairs) {
            $text = $text.Replace($p[0], $p[1])
        }
        if ($text -ne $orig) {
            Set-Content -Path $file -Value $text -NoNewline
            Write-Ok "Fixed paths in $name."
        } else {
            Write-Ok "$name had no source-base paths (likely relative - nothing to fix)."
        }
    }
    Write-Warn2 "Still review Backends.fds by hand if your ComfyUI path was set outside the install folder."
}
else {
    Write-Warn2 "Skipped path-fixing. If your original used absolute paths (e.g. $SourceInstall\Models),"
    Write-Warn2 "open Data\Settings.fds and Data\Backends.fds and update them, or re-run with -FixPaths."
}

# --- Done / launch ----------------------------------------------------------
Write-Step "Setup complete"
Write-Ok "New instance ready at: $TargetPath"
Write-Ok "Launch with:  cd `"$TargetPath`"; .\launch-windows.bat --port $Port"

if ($Launch) {
    Write-Step "Launching on port $Port"
    Push-Location $TargetPath
    try { & .\launch-windows.bat --port $Port }
    finally { Pop-Location }
}
