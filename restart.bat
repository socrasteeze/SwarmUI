@echo off
setlocal ENABLEDELAYEDEXPANSION
cd /D "%~dp0"

rem --- Stop, pull, rebuild if needed, start. ---
rem Fork-owned file, kept separate from the stock launchers so upstream merges of those stay clean.

call "%~dp0stop.bat"

for /f "delims=" %%i in ('git rev-parse HEAD 2^>nul') do set BEFORE=%%i
if not defined BEFORE (
    echo.
    echo WARNING: this folder is not a git checkout. Skipping pull, starting with the code on disk.
    echo.
    goto launch
)

echo.
echo Pulling from origin main...
rem Explicit "origin main" rather than a bare "git pull", matching launch-windows.bat: this forces the pull to come
rem from this fork only, never from upstream, whatever the local branch tracking config happens to say.
rem --no-edit is not optional - without it a pull that cannot fast-forward opens git's editor, which in a launcher
rem window has nobody to answer it, and a cancelled window leaves MERGE_HEAD set so the next run fails too.
git pull --no-edit origin main
if errorlevel 1 (
    echo.
    echo WARNING: git pull failed. Continuing with the code already on disk.
    echo If this says you are mid-merge, run "git merge --abort" in this folder.
    echo.
)

for /f "delims=" %%i in ('git rev-parse HEAD') do set AFTER=%%i

if "!BEFORE!"=="!AFTER!" (
    echo   No new commits.
) else (
    echo   New commits pulled:
    git log --oneline !BEFORE!..!AFTER!
)

:launch
rem The rebuild decision is deliberately left to launch-windows.bat. It already compares HEAD against
rem src\bin\last_build and writes src\bin\must_rebuild itself, then rebuilds into src\bin\live_release with a
rem backup-and-restore path if the build fails. Repeating that check here would only create a second copy to
rem drift out of step with it.
echo.
call "%~dp0launch-fork.bat" %*
exit /b %ERRORLEVEL%
