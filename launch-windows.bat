@echo off
setlocal ENABLEDELAYEDEXPANSION

rem Ensure correct local path.
cd /D "%~dp0"

rem Microsoft borked the dotnet installer/path handler, so force x64 to be read first
set PATH=C:\Program Files\dotnet;%PATH%

set DOTNET_CLI_TELEMETRY_OPTOUT=1

rem Server settings option
rem Fork edit: explicit "origin main" rather than a bare "git pull" - forces every launch to pull only from
rem this fork (origin), never from upstream, regardless of local branch-tracking config (branch.master.remote/.merge).
rem Branch name updated 2026-08-13: origin's default branch was renamed from "master" to "main" (see AGENTS.md's
rem Fork Delta); the old hardcoded "origin master" started failing every launch with "couldn't find remote ref master".
rem --no-edit is not optional here: without it a pull that cannot fast-forward opens the merge-commit message
rem in git's editor, which in a launcher window has no one to answer it - the launch hangs, and a cancelled
rem window leaves MERGE_HEAD set so the next launch fails too. --no-edit takes the default message instead.
if not defined SWARM_SPOKE_LAUNCH if exist .\src\bin\always_pull (
    echo Pulling latest changes...
    git pull --no-edit origin main
    if errorlevel 1 (
        echo.
        echo WARNING: git pull failed. Continuing with the code already on disk.
        echo If this says you are mid-merge, run "git merge --abort" in this folder.
        echo.
    )
)

if not exist .git (
    echo.
    echo.
    echo WARNING: YOU DID NOT CLONE FROM GIT. THIS WILL BREAK SOME SYSTEMS. PLEASE INSTALL PER THE README.
    echo.
    echo.
    timeout 5
) else (
    for /f "delims=" %%i in ('git rev-parse HEAD') do set CUR_HEAD=%%i
    set /p BUILT_HEAD=<src/bin/last_build
    if not "!CUR_HEAD!"=="!BUILT_HEAD!" (
        echo.
        echo.
        echo WARNING: You did a git pull without building. Will now build for you...
        echo.
        echo.
        echo. 2>.\src\bin\must_rebuild
    )
)

if exist .\src\bin\must_rebuild (
    echo Rebuilding...
    if exist .\src\bin\live_release (
        rmdir /s /q .\src\bin\live_release_backup
        move .\src\bin\live_release .\src\bin\live_release_backup
    )
    rmdir /s /q .\src\bin\extensions
    del .\src\bin\must_rebuild
)

rem Build the program if it isn't already built
if not exist src\bin\live_release\SwarmUI.exe (
    rem For some reason Microsoft's nonsense is missing the official nuget source? So forcibly add that to be safe.
    dotnet nuget add source https://api.nuget.org/v3/index.json --name "NuGet official package source" >nul 2>&1

    dotnet build src/SwarmUI.csproj --configuration Release -o src/bin/live_release
    for /f "delims=" %%i in ('git rev-parse HEAD') do set CUR_HEAD2=%%i
    echo !CUR_HEAD2!> src/bin/last_build
)

if not exist src\bin\live_release\SwarmUI.exe if exist src\bin\live_release_backup\SwarmUI.exe (
    echo.
    echo.
    echo WARNING: BUILD FAILED? Restoring backup...
    echo.
    echo.
    timeout 5
    rmdir /s /q src\bin\live_release
    move src\bin\live_release_backup src\bin\live_release
)

rem Default env configuration, gets overwritten by the C# code's settings handler
set ASPNETCORE_ENVIRONMENT="Production"
set ASPNETCORE_URLS="http://*:7801"
set DOTNET_CLI_UI_LANGUAGE="en"

.\src\bin\live_release\SwarmUI.exe %*

rem Exit code 42 means restart, anything else = don't.
rem Fork edit: re-enter through launch-fork.bat when present, so an in-app restart stays inside the fork wrapper
rem rather than dropping back to the stock launcher. launch-fork.bat sees SWARM_FORK_CHECKED and skips its upstream
rem fetch on the way back through, so a restart costs no extra network round trip and shows no banner.
rem Also called by explicit path: cmd will not search the current directory when NoDefaultCurrentDirectoryInExePath
rem is set, and the bare name fails there with "not recognized".
if %ERRORLEVEL% EQU 42 (
    echo Restarting...
    if exist "%~dp0launch-fork.bat" (
        call "%~dp0launch-fork.bat" %*
    ) else (
        call "%~dp0launch-windows.bat" %*
    )
)

IF %ERRORLEVEL% NEQ 0 ( pause )
