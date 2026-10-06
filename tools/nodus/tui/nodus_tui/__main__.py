"""Nodus TUI 실행 진입점.

사용법:
  python -m nodus_tui [--api http://localhost:8000] [--project <번호|id앞부분>]

백엔드가 먼저 떠 있어야 한다: ./run.sh  (또는 uvicorn app.main:app)
"""

from __future__ import annotations

import argparse
import os

from .app import NodusTUI


def main() -> None:
    parser = argparse.ArgumentParser(prog="nodus-tui", description="Nodus 터미널 하네스 (TUI)")
    parser.add_argument(
        "--api",
        default=os.environ.get("NODUS_API", "http://localhost:8000"),
        help="Nodus 백엔드 주소 (기본 http://localhost:8000, 환경변수 NODUS_API)",
    )
    parser.add_argument(
        "--project",
        default=os.environ.get("NODUS_PROJECT"),
        help="시작할 프로젝트 (목록 번호 또는 id 앞부분)",
    )
    args = parser.parse_args()
    NodusTUI(api_url=args.api, initial_project=args.project).run()


if __name__ == "__main__":
    main()
