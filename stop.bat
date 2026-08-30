@echo off
setlocal ENABLEDELAYEDEXPANSION
cd /D "%~dp0"

rem --- Stops a running SwarmUI server and the ComfyUI backends it started. ---
rem Fork-owned file, kept separate from the stock launchers so upstream merges of those stay clean.

rem System utilities are called by absolute path throughout. A shell whose PATH front-loads GNU coreutils - Git
rem Bash, MSYS, Cygwin - shadows find.exe and timeout.exe with incompatible programs, and this script is otherwise
rem silently broken when run from one of those.
set SYS=%SystemRoot%\System32

echo Stopping SwarmUI...
rem taskkill's own exit code is the presence check: it returns non-zero when no matching process exists, so there
rem is no need to pipe tasklist through find first.
"%SYS%\taskkill.exe" /IM SwarmUI.exe /T /F >nul 2>&1
if errorlevel 1 (
    echo   SwarmUI was not running.
) else (
    echo   SwarmUI stopped.
)

rem SwarmUI's self-start ComfyUI backends do NOT die with the parent - they are launched through an intermediate
rem shell that exits immediately, so taskkill /T finds nothing left to walk. Left alone they keep holding VRAM and
rem keep ports 5809+ bound, and the next launch then fails to bind them. So they are cleaned up explicitly.
rem
rem The filter matches this folder's absolute dlbackend path in the command line, which is how SwarmUI invokes its
rem own backends. A separately-installed portable ComfyUI is invoked by a relative path (".\python_embeded\...")
rem and so can never match, even if it is running on this same machine.
echo Stopping SwarmUI-managed ComfyUI backends...
"%SYS%\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command ^
  "$root = '%~dp0'; $found = 0; Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'python.exe' -and $_.CommandLine -and $_.CommandLine -like ('*' + $root + 'dlbackend*') } | ForEach-Object { $found = 1; Write-Host ('  stopping backend PID ' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; if (-not $found) { Write-Host '  none running.' }"

rem Give the OS a moment to release the listen sockets, so an immediate restart does not race a lingering bind.
"%SYS%\timeout.exe" /t 2 /nobreak >nul 2>&1

echo Done.
exit /b 0
