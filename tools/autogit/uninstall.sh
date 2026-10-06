#!/usr/bin/env bash
# AutoGit 전역 설치 제거 (Linux / macOS)
set -eu

removed=0
for dir in ${PREFIX:+"$PREFIX/bin"} /usr/local/bin "$HOME/.local/bin"; do
  link="$dir/autogit"
  if [ -L "$link" ] || [ -f "$link" ]; then
    rm -f "$link"
    echo "제거: $link"
    removed=1
  fi
done

if [ "$removed" -eq 0 ]; then
  echo "제거할 autogit 실행 파일을 찾지 못했습니다."
fi
