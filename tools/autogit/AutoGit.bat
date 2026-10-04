@echo off
setlocal enableextensions
title AutoGit

rem ============================================================
rem  AutoGit launcher (TUI)
rem   1) Double-click -> open this folder as the repository
rem   2) Drag a Git repo folder onto this file -> open that repo
rem ============================================================

set "APP_DIR=%~dp0"
if "%APP_DIR:~-1%"=="\" set "APP_DIR=%APP_DIR:~0,-1%"

set "REPO=%~1"
if "%REPO%"=="" set "REPO=%CD%"
if "%REPO:~-1%"=="\" set "REPO=%REPO:~0,-1%"

if not exist "%REPO%\" (
  echo [ERROR] Folder not found: %REPO%
  echo.
  echo Usage: double-click this file, or drag a Git repository folder onto it.
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is required. Install it from https://nodejs.org
  pause
  exit /b 1
)

cd /d "%REPO%"
node "%APP_DIR%\bin\autogit.js"
exit /b %errorlevel%
