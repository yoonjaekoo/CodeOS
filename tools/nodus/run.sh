#!/usr/bin/env bash
# Nodus — one-shot launcher for Linux/macOS: api :8000 + web :5173 in this one terminal.
# Linux counterpart of run.bat. Ctrl+C (or closing the terminal) stops both.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_PORT="${NODUS_API_PORT:-8000}"
WEB_PORT="${NODUS_WEB_PORT:-5173}"

PY="$ROOT/backend/.venv/bin/python"
NPM="$(command -v npm || true)"
API_PID=""

echo
echo "  Nodus  -  both services in this one window"
echo "  ========================================="

# ---------------- prerequisites ----------------
if [ ! -x "$PY" ]; then
  echo "[X] backend/.venv not found. Run once:"
  echo "      cd backend"
  echo "      python3 -m venv .venv"
  echo "      .venv/bin/python -m pip install -r requirements.txt"
  echo
  exit 1
fi
if [ ! -d "$ROOT/frontend/node_modules" ]; then
  echo "[X] frontend/node_modules not found. Run once:"
  echo "      cd frontend"
  echo "      npm install"
  echo
  exit 1
fi
if [ -z "$NPM" ]; then
  echo "[X] npm not found on PATH. Install Node.js 18+ first."
  echo
  exit 1
fi

# :listening <port> -> 0 when a socket is listening on that local port
listening() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$1\$"
    return
  fi
  (exec 3<>"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1
}

wait_api() {
  i=0
  while [ "$i" -lt 60 ]; do
    if command -v curl >/dev/null 2>&1; then
      curl -fsS "http://127.0.0.1:$API_PORT/api/health" >/dev/null 2>&1 && return 0
    else
      (exec 3<>"/dev/tcp/127.0.0.1/$API_PORT") >/dev/null 2>&1 && return 0
    fi
    i=$((i + 1))
    sleep 1
  done
  return 1
}

cleanup() {
  if [ -n "$API_PID" ] && kill -0 "$API_PID" 2>/dev/null; then
    kill "$API_PID" 2>/dev/null
    wait "$API_PID" 2>/dev/null
  fi
}
trap cleanup EXIT INT TERM

# ---------------- api :8000 (background, shares this console) ----------------
if listening "$API_PORT"; then
  echo "[=] api   already running on :$API_PORT  - not started again"
else
  echo "[>] api   starting on :$API_PORT"
  ( cd "$ROOT/backend" && exec "$PY" -m uvicorn app.main:app --reload --host 127.0.0.1 --port "$API_PORT" ) &
  API_PID=$!

  if ! wait_api; then
    echo
    echo "[!] api failed to start - the traceback is printed above."
    echo
    exit 1
  fi
fi
echo "[OK] api   http://localhost:$API_PORT/api/health"

# ---------------- browser opener (desktop only; headless machines skip) ----------------
OPEN_CMD=""
if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && command -v xdg-open >/dev/null 2>&1; then
  OPEN_CMD="xdg-open"
elif [ "$(uname -s)" = "Darwin" ] && command -v open >/dev/null 2>&1; then
  OPEN_CMD="open"
fi
if [ -n "$OPEN_CMD" ]; then
  (
    i=0
    while [ "$i" -lt 120 ]; do
      if listening "$WEB_PORT"; then
        "$OPEN_CMD" "http://localhost:$WEB_PORT" >/dev/null 2>&1
        break
      fi
      i=$((i + 1))
      sleep 1
    done
  ) &
fi

# ---------------- web :5173 (foreground: this window is the log) ----------------
if listening "$WEB_PORT"; then
  echo "[=] web   already running on :$WEB_PORT"
  echo
  echo "    nothing to start. press Ctrl+C to close."
  exit 0
fi

echo "[>] web   starting on :$WEB_PORT"
echo
echo "    Ctrl+C stops api and web together."
echo "    open http://localhost:$WEB_PORT"
echo
cd "$ROOT/frontend"
"$NPM" run dev -- --clearScreen false

echo
echo "web stopped."
