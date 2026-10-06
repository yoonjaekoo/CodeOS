#!/usr/bin/env bash
# Nodus TUI 실행 스크립트 — 백엔드(FastAPI)가 떠 있는 상태에서 실행한다.
#   ./run-tui.sh [--api http://localhost:8000] [--project <번호|id앞부분>]
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="$ROOT/tui/.venv/bin/python"

if [ ! -x "$PY" ]; then
  echo "[X] tui/.venv not found. Run once:"
  echo "      cd tui"
  echo "      python3 -m venv .venv"
  echo "      .venv/bin/python -m pip install -r requirements.txt"
  echo
  exit 1
fi

cd "$ROOT/tui"
exec "$PY" -m nodus_tui "$@"
