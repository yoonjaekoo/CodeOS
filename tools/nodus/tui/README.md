# Nodus TUI — 터미널 하네스

웹 화면(React) 대신 터미널에서 Nodus를 쓰는 클라이언트입니다.
엔진(토론·지도·분기·샌드박스 실행)은 백엔드가 그대로 돌리고, 이 화면은
REST + SSE로 붙습니다. [Textual](https://textual.textualize.io/) 기반.

```
채팅(왼쪽, 토큰 실시간)                │ 지도 / 실행 / 가지 탭 (오른쪽)
──────────────────────────────────────┼────────────────────────────
 ● 실행 중  프로젝트 · 가지 3/50턴    │  (상태줄)
 > 메시지 입력 또는 /help             │  (입력줄)
```

## 준비 / 실행

```bash
cd tui
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
cd ..

./run.sh          # 백엔드(:8000)를 먼저 띄우고
./run-tui.sh     # 다른 창/나중에 TUI 실행
```

옵션:

```bash
./run-tui.sh --api http://pi-1:8000 --project 1     # NODUS_API / NODUS_PROJECT 환경변수도 같음
```

## 쓰는 법

- 입력줄에 그냥 글자를 치면 **사용자 메시지**가 토론에 들어갑니다 (AI 턴을 세지 않음).
- `/`로 시작하면 **명령**: `/start [턴수]`, `/stop`, `/conclude`, `/restart`, `/fork [노드]`,
  `/graph`, `/run [명령]`, `/test [명령]`, `/exec`, `/config`, `/branches`, `/use <번호>`,
  `/projects`, `/open <번호>`, `/new`, `/ls [경로]`, `/save [파일]`, `/status`, `/api [주소]`,
  `/clear`, `/help`, `/quit` — 전체 설명은 `/help`.
- 키: `ctrl+s` 시작 · `ctrl+t` 중지 · `ctrl+n` 결론 · `ctrl+g/r/b` 탭 전환 · `ctrl+o` 패널 접기 ·
  `ctrl+l` 화면 비우기 · `ctrl+q` 종료 (기록은 서버에 남음).
- 오른쪽 `실행` 행을 고르면 전체 출력이 채팅에 나오고, `가지` 행을 고르면 그 가지로 전환합니다.

## 참고

- 토론은 백엔드에서 돌기 때문에 TUI를 닫아도 멈추지 않습니다. 다시 열면 이어집니다.
- 코드 실행(`/run`, `/test`)은 백엔드에 **Docker**가 있어야 동작합니다(샌드박스 설계).
  Docker가 없으면 `/config`가 이유를 보여주고, 토론·지도·분기는 그대로 됩니다.
- 구조: `nodus_tui/api.py`(HTTP+SSE 클라이언트) · `nodus_tui/app.py`(화면·명령) ·
  `nodus_tui/nodus.tcss`(스타일) · `nodus_tui/__main__.py`(`python -m nodus_tui`).
