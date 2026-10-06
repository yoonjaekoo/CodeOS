@echo off
setlocal EnableExtensions
title Nodus - one-click launcher

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

echo.
echo   Nodus  -  one-click launcher
echo   ============================
echo   First run prepares the backend venv and frontend deps,
echo   then starts api :8000 + web :5173 in this window.
echo.

rem ---------------- python ----------------
set "PYEXE="
where py >nul 2>&1
if not errorlevel 1 set "PYEXE=py -3"
if not defined PYEXE (
  where python >nul 2>&1
  if not errorlevel 1 set "PYEXE=python"
)
if not defined PYEXE (
  echo [X] Python not found. Install Python 3.12+ from https://www.python.org/downloads/
  echo     and tick "Add python.exe to PATH" during setup.
  echo.
  pause
  exit /b 1
)

rem ---------------- backend venv ----------------
if not exist "%ROOT%\backend\.venv\Scripts\python.exe" (
  echo [^>] creating backend\.venv
  pushd "%ROOT%\backend"
  %PYEXE% -m venv .venv
  if errorlevel 1 (
    echo [X] failed to create backend\.venv
    popd
    pause
    exit /b 1
  )
  echo [^>] installing backend requirements
  ".venv\Scripts\python.exe" -m pip install --upgrade pip
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt
  if errorlevel 1 (
    echo [X] pip install failed
    popd
    pause
    exit /b 1
  )
  popd
) else (
  echo [=] backend\.venv ready
)

rem ---------------- env files ----------------
if not exist "%ROOT%\backend\.env" if exist "%ROOT%\backend\.env.example" (
  copy /y "%ROOT%\backend\.env.example" "%ROOT%\backend\.env" >nul
  echo [^>] created backend\.env from .env.example
)
if not exist "%ROOT%\frontend\.env" if exist "%ROOT%\frontend\.env.example" (
  copy /y "%ROOT%\frontend\.env.example" "%ROOT%\frontend\.env" >nul
  echo [^>] created frontend\.env from .env.example
)

rem ---------------- node / npm ----------------
where npm >nul 2>&1
if errorlevel 1 (
  echo [X] Node.js / npm not found. Install Node.js 18+ from https://nodejs.org/
  echo.
  pause
  exit /b 1
)

rem ---------------- frontend deps ----------------
if not exist "%ROOT%\frontend\node_modules" (
  echo [^>] installing frontend dependencies ^(npm install^)
  pushd "%ROOT%\frontend"
  call npm install
  if errorlevel 1 (
    echo [X] npm install failed
    popd
    pause
    exit /b 1
  )
  popd
) else (
  echo [=] frontend\node_modules ready
)

echo.
echo   setup complete  -  starting Nodus...
echo.
call "%ROOT%\run.bat"
exit /b %errorlevel%
