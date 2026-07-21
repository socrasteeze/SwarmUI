@echo off
setlocal ENABLEDELAYEDEXPANSION
cd /D "%~dp0"

rem --- Fork launcher wrapper: flags unmerged upstream commits, then delegates to launch-windows.bat ---
rem This is a new file, kept separate from launch-windows.bat so upstream merges of that file stay clean.

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

call launch-windows.bat %*
exit /b %ERRORLEVEL%
