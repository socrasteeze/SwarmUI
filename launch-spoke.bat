@echo off
setlocal
rem Spoke mode: this instance is a GPU worker for a hub. It owns no models.
rem Launch from an interactive desktop session. Mapped drives are per-session.

set SWARM_SPOKE_LAUNCH=1
set SWARM_FORK_CHECKED=1
call "%~dp0launch-fork.bat" --spoke true %*
exit /b %ERRORLEVEL%
