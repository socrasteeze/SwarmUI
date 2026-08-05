@echo off
setlocal ENABLEDELAYEDEXPANSION
cd /D "%~dp0"

rem --- Fork launcher wrapper: flags unmerged upstream commits, then delegates to launch-windows.bat ---
rem This is a new file, kept separate from launch-windows.bat so upstream merges of that file stay clean.

rem An in-app restart (exit code 42) re-enters this script from launch-windows.bat's restart branch. The upstream
rem check already ran on the way in, so skip it on the way back through - otherwise every restart pays a network
rem fetch and can stall five seconds on the banner. The variable survives because `call` stays in this process.
if defined SWARM_FORK_CHECKED goto launch

rem Fetch upstream quietly; never fail the launch if the remote/network is unavailable.
git fetch upstream --quiet 2>nul

rem Count upstream/master commits not yet in HEAD (safe default 0 if the ref is missing).
set UPSTREAM_NEW=0
for /f "delims=" %%i in ('git rev-list --count HEAD..upstream/master 2^>nul') do set UPSTREAM_NEW=%%i
if "!UPSTREAM_NEW!"=="" set UPSTREAM_NEW=0

if !UPSTREAM_NEW! GTR 0 (
    echo.
    echo ============================================================
    echo   UPSTREAM UPDATE AVAILABLE
    echo   !UPSTREAM_NEW! new commit^(s^) on upstream/master not yet merged.
    echo.
    echo   Review:  git fetch upstream ^&^& git log HEAD..upstream/master --oneline
    echo   Merge:   git merge upstream/master
    echo ============================================================
    echo.
    timeout /t 5 /nobreak >nul
) else (
    echo Up to date with upstream.
)

:launch
set SWARM_FORK_CHECKED=1

rem Called by explicit path, not bare name: cmd does not search the current directory when
rem NoDefaultCurrentDirectoryInExePath is set, so a bare "call launch-windows.bat" dies with
rem "not recognized" even though cd /D above put us in the right folder.
call "%~dp0launch-windows.bat" %*
exit /b %ERRORLEVEL%
