@echo off
rem Starts the SwarmUI server if it is not already running. Does NOT open a browser or the installed PWA -
rem see Start_SwarmUI.ps1 for why (fork owner does not want the browser force-opened on every launch/restart).
rem Pass -OpenBrowser (forwarded via %*) to also open the UI once the server answers.
rem Thin wrapper - the logic lives in Start_SwarmUI.ps1, which is easier to read and maintain than the equivalent
rem batch. -ExecutionPolicy Bypass so this works on a default machine without changing any machine-wide policy.
cd /D "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start_SwarmUI.ps1" %*
if %ERRORLEVEL% NEQ 0 pause
