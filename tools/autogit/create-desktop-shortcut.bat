@echo off
setlocal
title Create Desktop Shortcut
set "HERE=%~dp0"
if "%HERE:~-1%"=="\" set "HERE=%HERE:~0,-1%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%HERE%\tools\create-shortcut.ps1" -AppDir "%HERE%"
echo.
pause
