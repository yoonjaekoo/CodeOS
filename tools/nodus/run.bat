@echo off
setlocal
title Nodus  (api :8000 / web :5173)

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

echo.
echo   Nodus  -  both services in this one window
echo   =========================================

rem ---------------- prerequisites ----------------
if not exist "%ROOT%\backend\.venv\Scripts\python.exe" (
  echo [X] backend\.venv not found. Run once:
  echo       cd backend
  echo       python -m venv .venv
  echo       .venv\Scripts\python.exe -m pip install -r requirements.txt
  echo.
  pause
  exit /b 1
)
if not exist "%ROOT%\frontend\node_modules" (
  echo [X] frontend\node_modules not found. Run once:
  echo       cd frontend
  echo       npm install
  echo.
  pause
  exit /b 1
)

rem ---------------- api :8000  (background, shares this console) ----------------
call :listening 8000
if not errorlevel 1 (
  echo [=] api   already running on :8000  - not started again
) else (
  echo [^>] api   starting on :8000
  pushd "%ROOT%\backend"
  start "nodus-api" /b cmd /c ".venv\Scripts\python.exe -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000"
  popd

  call :waitport 8000 60
  if errorlevel 1 (
    echo.
    echo [!] api failed to start - the traceback is printed above.
    echo.
    pause
    exit /b 1
  )
)
echo [OK] api   http://localhost:8000/api/health

rem ---------------- browser opener (hidden) ----------------
rem waits for vite, then opens the app once
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "$end=[DateTime]::UtcNow.AddSeconds(120); while([DateTime]::UtcNow -lt $end){ try { $c=New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1',5173); $c.Close(); Start-Process 'http://localhost:5173'; exit } catch { Start-Sleep -Milliseconds 300 } }"

rem ---------------- web :5173  (foreground: this window is the log) ----------------
call :listening 5173
if not errorlevel 1 (
  echo [=] web   already running on :5173
  echo.
  echo     nothing to start. press any key to close.
  pause >nul
  exit /b 0
)

echo [^>] web   starting on :5173
echo.
echo     Ctrl+C or closing this window stops api and web together.
echo.
pushd "%ROOT%\frontend"
call npm run dev -- --clearScreen false
popd

echo.
echo web stopped.
pause
exit /b 0

rem ================= helpers =================

rem :listening <port>  -> errorlevel 0 if a socket is LISTENING on that port
:listening
netstat -ano -p tcp | findstr /r /c:"LISTENING" | findstr /r /c:":%~1 " >nul 2>&1
exit /b %errorlevel%

rem :waitport <port> <max_seconds>  -> errorlevel 0 once listening
:waitport
for /L %%i in (1,1,%~2) do (
  call :listening %~1
  if not errorlevel 1 exit /b 0
  ping -n 2 127.0.0.1 >nul
)
exit /b 1
