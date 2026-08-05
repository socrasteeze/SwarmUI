@echo off
rem Starts the SwarmUI server if it is not already running, then opens the UI.
rem Thin wrapper - the logic lives in Start_SwarmUI.ps1, which is easier to read and maintain than the equivalent
rem batch. -ExecutionPolicy Bypass so this works on a default machine without changing any machine-wide policy.
cd /D "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start_SwarmUI.ps1" %*
if %ERRORLEVEL% NEQ 0 pause
