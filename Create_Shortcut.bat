@echo off
setlocal ENABLEDELAYEDEXPANSION

rem Ensure correct local path.
cd /D "%~dp0"

rem --- Creates Desktop / Start Menu shortcuts for SwarmUI, any time after install. ---
rem The web installer only offers this once (Installation.MakeShortcut), and only for a fresh install. This does the
rem same job on demand, with three differences:
rem   1. It targets launch-fork.bat when present, which is the correct entry point on this fork.
rem   2. It writes a real .lnk rather than a .url, so the shortcut can be pinned to the taskbar or Start menu and
rem      carries an explicit working directory.
rem   3. It resolves the Desktop and Start Menu via the shell, so a OneDrive-redirected Desktop still works.
rem
rem Usage:  Create_Shortcut.bat [/desktop] [/startmenu] [/both] [/remove] [/force] [/launcher]
rem With no arguments it prompts.
rem   /force     overwrite a same-named shortcut that points somewhere else
rem   /launcher  target the plain launcher (skips Start_SwarmUI.bat's idempotency check; keeps its console visible)

rem Default target is Start_SwarmUI.bat, which starts the server if it isn't already running (idempotent, safe to
rem click twice). It does NOT open a browser or the installed PWA - the fork owner does not want a browser window
rem force-opened on every launch, and this install has LaunchMode=none so the server does not open one itself
rem either. The plain launcher (/launcher) gives you the same thing minus the idempotency check, plus a console.
set "SC_LAUNCHER=Start_SwarmUI.bat"
if not exist "%~dp0Start_SwarmUI.bat" set "SC_LAUNCHER=launch-fork.bat"
if not exist "%~dp0launch-fork.bat" if not exist "%~dp0Start_SwarmUI.bat" set "SC_LAUNCHER=launch-windows.bat"

if not exist "%~dp0!SC_LAUNCHER!" (
    echo.
    echo ERROR: Could not find a launcher next to this script.
    echo Expected launch-fork.bat or launch-windows.bat in:
    echo   %~dp0
    echo Run this from inside your SwarmUI folder.
    echo.
    pause
    exit /b 1
)

rem %~dp0 always ends in a backslash; trim it so the paths written into the shortcut are tidy.
set "SC_ROOT=%~dp0"
if "!SC_ROOT:~-1!"=="\" set "SC_ROOT=!SC_ROOT:~0,-1!"

set "SC_TARGET=!SC_ROOT!\!SC_LAUNCHER!"
set "SC_ICON=!SC_ROOT!\src\wwwroot\favicon.ico"
rem Deliberately NOT "SwarmUI". An installed PWA (Chrome/Edge/Brave "Install app") also creates a Desktop shortcut
rem called SwarmUI.lnk, pointing at the browser. That one opens the web UI against an already-running server; this
rem one starts the server. Both are useful and they are not interchangeable, so they get different names and this
rem script never touches a shortcut it did not create.
set "SC_NAME=Launch SwarmUI"
set "SC_DESC=Start the SwarmUI server (AI image generation)"

set "DO_DESKTOP="
set "DO_STARTMENU="
set "DO_REMOVE="
set "SC_FORCE="

:parseargs
if "%~1"=="" goto argsdone
if /I "%~1"=="/desktop"   set "DO_DESKTOP=1"
if /I "%~1"=="/startmenu" set "DO_STARTMENU=1"
if /I "%~1"=="/both"      ( set "DO_DESKTOP=1" & set "DO_STARTMENU=1" )
if /I "%~1"=="/remove"    set "DO_REMOVE=1"
if /I "%~1"=="/force"     set "SC_FORCE=1"
if /I "%~1"=="/launcher"  set "SC_RAW=1"
shift
goto parseargs
:argsdone

rem /launcher: target the plain launcher instead of the start-and-open wrapper.
if defined SC_RAW (
    set "SC_LAUNCHER=launch-fork.bat"
    if not exist "%~dp0launch-fork.bat" set "SC_LAUNCHER=launch-windows.bat"
    set "SC_TARGET=!SC_ROOT!\!SC_LAUNCHER!"
    set "SC_DESC=Start the SwarmUI server (console only)"
)

if defined DO_REMOVE goto run
if defined DO_DESKTOP goto run
if defined DO_STARTMENU goto run

echo.
echo   SwarmUI shortcut creator
echo   Launcher: !SC_LAUNCHER!
echo   Folder:   !SC_ROOT!
echo.
echo   [1] Desktop shortcut
echo   [2] Start Menu shortcut
echo   [3] Both
echo   [4] Remove existing SwarmUI shortcuts
echo   [5] Cancel
echo.
set "SC_CHOICE="
set /p SC_CHOICE="Choose (1-5, default 1): "
if "!SC_CHOICE!"=="" set "SC_CHOICE=1"
if "!SC_CHOICE!"=="1" set "DO_DESKTOP=1"
if "!SC_CHOICE!"=="2" set "DO_STARTMENU=1"
if "!SC_CHOICE!"=="3" ( set "DO_DESKTOP=1" & set "DO_STARTMENU=1" )
if "!SC_CHOICE!"=="4" set "DO_REMOVE=1"
if "!SC_CHOICE!"=="5" exit /b 0
if not defined DO_DESKTOP if not defined DO_STARTMENU if not defined DO_REMOVE (
    echo Not a valid choice, nothing done.
    pause
    exit /b 1
)

:run
echo.

if defined DO_REMOVE (
    call :Remove "Desktop"
    call :Remove "Programs"
    echo.
    if not defined DO_DESKTOP if not defined DO_STARTMENU (
        pause
        exit /b 0
    )
)

if defined DO_DESKTOP   call :Make "Desktop"  "Desktop"
if defined DO_STARTMENU call :Make "Programs" "Start Menu"

echo.
pause
exit /b 0


rem --- Make <shell folder id> <friendly name> ---
rem Values are handed to PowerShell through the environment rather than the command line, so paths containing
rem spaces, ampersands or parentheses need no quoting gymnastics between cmd and PowerShell.
:Make
set "SC_FOLDERID=%~1"
set "SC_FRIENDLY=%~2"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "try {" ^
  "  $dir = [Environment]::GetFolderPath($env:SC_FOLDERID);" ^
  "  if (-not $dir) { throw 'Could not resolve the ' + $env:SC_FRIENDLY + ' folder.' }" ^
  "  $path = Join-Path $dir ($env:SC_NAME + '.lnk');" ^
  "  $shell = New-Object -ComObject WScript.Shell;" ^
  "  if ((Test-Path $path) -and -not $env:SC_FORCE) {" ^
  "    $old = $shell.CreateShortcut($path);" ^
  "    if ($old.TargetPath -and $old.TargetPath -ne $env:SC_TARGET) {" ^
  "      Write-Host ('  SKIPPED (' + $env:SC_FRIENDLY + '): a different shortcut already uses that name.');" ^
  "      Write-Host ('    ' + $path);" ^
  "      Write-Host ('    points at: ' + $old.TargetPath);" ^
  "      Write-Host ('    Re-run with /force to replace it.');" ^
  "      exit 0" ^
  "    }" ^
  "  }" ^
  "  $s = $shell.CreateShortcut($path);" ^
  "  $s.TargetPath = $env:SC_TARGET;" ^
  "  $s.WorkingDirectory = $env:SC_ROOT;" ^
  "  $s.Description = $env:SC_DESC;" ^
  "  if (Test-Path $env:SC_ICON) { $s.IconLocation = $env:SC_ICON }" ^
  "  $s.Save();" ^
  "  Write-Host ('  Created: ' + $path)" ^
  "} catch { Write-Host ('  FAILED (' + $env:SC_FRIENDLY + '): ' + $_.Exception.Message); exit 1 }"
if errorlevel 1 (
    echo   ^(Shortcut creation failed - see the message above.^)
)
exit /b 0


rem --- Remove <shell folder id> ---
:Remove
set "SC_FOLDERID=%~1"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$dir = [Environment]::GetFolderPath($env:SC_FOLDERID);" ^
  "if ($dir) {" ^
  "  $shell = New-Object -ComObject WScript.Shell;" ^
  "  $p = Join-Path $dir ($env:SC_NAME + '.lnk');" ^
  "  if (Test-Path $p) {" ^
  "    $t = $shell.CreateShortcut($p).TargetPath;" ^
  "    if ($t -eq $env:SC_TARGET) { Remove-Item $p -Force; Write-Host ('  Removed: ' + $p) }" ^
  "    else { Write-Host ('  Left alone (not ours): ' + $p) }" ^
  "  }" ^
  "}"
exit /b 0
