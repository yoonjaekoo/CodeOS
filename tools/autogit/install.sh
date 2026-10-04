#!/usr/bin/env bash
# ============================================================
#  AutoGit 전역 설치 (Linux / macOS)
#   - bin/autogit.js 에 실행 권한 부여
#   - PATH 에 autogit 실행 파일 생성
#       기본: /usr/local/bin  (쓰기 불가 시 ~/.local/bin)
#       PREFIX=/경로 ./install.sh 로 위치 지정 가능
# ============================================================
set -eu

APP_DIR="$(cd -- "$(dirname -- "$0")" && pwd -P)"
BIN_SRC="$APP_DIR/bin/autogit.js"

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js (>= 18) 가 필요합니다. https://nodejs.org" >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "[ERROR] Node.js 18 이상이 필요합니다. (현재: $(node -v))" >&2
  exit 1
fi

if [ -n "${PREFIX:-}" ]; then
  BIN_DIR="$PREFIX/bin"
elif [ -w /usr/local/bin ] 2>/dev/null; then
  BIN_DIR="/usr/local/bin"
else
  BIN_DIR="$HOME/.local/bin"
fi

mkdir -p "$BIN_DIR"
chmod +x "$BIN_SRC"
ln -sfn "$BIN_SRC" "$BIN_DIR/autogit"
echo "설치 완료: $BIN_DIR/autogit → $BIN_SRC"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo
    echo "PATH 에 $BIN_DIR 가 없습니다. 셸 설정에 추가하세요:"
    echo "  export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac

echo
echo "실행:"
echo "  autogit              현재 폴더 TUI"
echo "  autogit status       헤드리스 CLI"
echo "  autogit -h           도움말"
