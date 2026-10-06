# AutoGit

터미널 Git 도구. **의존성 없는 TUI + 헤드리스 CLI**로, AI 없이 규칙 기반 커밋 메시지를
생성하고 스냅샷 기반 "시간 되돌리기"와 GitHub 연동을 제공합니다.

## 특징

- **런타임 의존성 0** — Node.js 내장 모듈만 사용 (Node >= 18).
- **TUI + 헤드리스 CLI 동시 제공** — TTY면 TUI, TTY가 없으면 자동으로 CLI.
- **규칙 기반 커밋 메시지 생성** — Conventional Commits 스타일(`feat:`, `docs:` …)을
  파일 분류와 diff 시그널로 결정. AI/네트워크 불필요.
- **시간 되돌리기** — 모든 변경 전에 자동 스냅샷을 남겨 `rewind`/`undo`/`restore`/`revert`.
- **GitHub 연동** — 토큰 로그인(붙여넣기/파이프), 저장소 생성, push/pull.
  최초 push 시 upstream 자동 설정.

## 설치

### Windows
`AutoGit.bat`(또는 바탕화면 바로가기)을 더블클릭하면 현재 폴더를 저장소로 실행합니다.
저장소 폴더를 `AutoGit.bat` 위로 끌어다 놓으면 그 저장소로 실행됩니다.

### Linux / macOS
```bash
./install.sh      # PATH 에 autogit 등록 (기본 /usr/local/bin, 불가 시 ~/.local/bin)
autogit           # 어느 폴더에서든 실행
./uninstall.sh    # 전역 실행 파일 제거
```

`sudo` 없이 쓰려면 `PREFIX` 로 위치를 지정합니다:

```bash
PREFIX="$HOME/.local" ./install.sh
```

Node 내장 모듈만 쓰므로 별도 `node_modules`가 필요 없습니다.

### npm 으로 설치 (공통)
```bash
npm link          # 또는 npm install -g .
autogit           # 어느 폴더에서든 실행
```


## 실행

- `autogit` — 인자 없이 실행하면 현재 폴더를 저장소로 **TUI** 시작 (TTY 필요).
- TTY가 아니면 자동으로 `status` 결과를 출력합니다.
- `autogit tui` 로 명시 실행, `autogit <명령>` 으로 헤드리스 사용.

## TUI

탭: `1` Diff · `2` History · `3` Time · `4` Remote · `5` Branch

| 키 | 동작 |
| --- | --- |
| `↑`/`↓`(`k`/`j`) | 파일/스냅샷 선택 |
| `space` | stage / unstage |
| `a` | 전체 stage (Remote 탭에서는 remote 추가) |
| `g` | 커밋 메시지 자동 생성 |
| `e` | 메시지 편집 |
| `c` | 커밋 |
| `t` / `z` | rewind / undo |
| `r` | 새로고침 |
| `PgUp`/`PgDn` | 스크롤 |
| `?` / `q` | 도움말 / 종료 |

**Time 탭**: `↑`/`↓` 스냅샷 선택 · `Enter` 시점 복구 · `f` 파일만 복구 ·
`t` rewind · `v` revert · `m` 모드(soft/mixed/hard) · `z` undo · `d` 정리

**Remote 탭**: `i` 토큰 붙여넣기 로그인 · `N` 저장소 생성 · `a` remote 추가 ·
`p` push · `P` pull · `o` 저장소 목록 · `L` 로그아웃

**Branch 탭**: `↑`/`↓` 브랜치 선택 · `Enter` 전환 · `n` 새 브랜치 ·
`d` 삭제(미병합 시 `force` 확인) · `r` 이름 변경 · `M` 현재 브랜치로 병합

## CLI

```bash
# 기본
autogit status [--json]          # 변경 사항 요약
autogit msg                      # 메시지만 생성 (커밋 안 함)
autogit stage <경로...> | --all  # stage
autogit unstage <경로...>        # unstage
autogit commit -m "메시지"        # 커밋
autogit commit --auto            # 메시지 자동 생성 후 커밋
autogit log [-n 개수]            # 커밋 기록
autogit branches                 # 브랜치 목록
autogit checkout <브랜치>        # 브랜치 전환
autogit branch                   # 브랜치 목록 (list)
autogit branch new <이름>        # 브랜치 생성 후 전환 (--no-switch)
autogit branch switch <이름>     # 브랜치 전환
autogit branch delete <이름>     # 브랜치 삭제 (--force)
autogit branch rename <A> <B>    # 브랜치 이름 변경
autogit branch merge <이름>      # 현재 브랜치로 병합
```

```bash
# 시간 되돌리기 (변경 전 자동 스냅샷)
autogit rewind <커밋> [--mode soft|mixed|hard]
autogit undo
autogit snapshots [--prune]
autogit restore <스냅샷id> [--files-only]
autogit revert <커밋>
```

```bash
# 원격
autogit remote list|add <이름> <URL>|set-url <이름> <URL>|remove <이름>
autogit pull [remote] [branch]
autogit push [remote] [branch] [-u]   # 최초 push 는 upstream 자동 설정

# GitHub
autogit github status
autogit github login --token <토큰>   # 또는 --gh, 또는 stdin
autogit github logout
autogit github repos
autogit github create <이름> [--private]
```

전역 옵션: `-C <경로>` 저장소 지정 · `--json` JSON 출력 · `-h, --help`.

## 토큰 로그인 (붙여넣기 / 파이프)

```bash
printf %s "$TOKEN" | autogit github login   # 셸 히스토리 노출 없음
autogit github login --gh                    # gh CLI 토큰 재사용
```

TUI에서는 Remote 탭에서 `i` → 토큰 붙여넣기(브래킷 페이스트 지원, 화면에는 `•••`로 마스킹).

## 시간 되돌리기 원리

- 모든 변경 작업 전 `HEAD` + index tree + 워킹트리 tree(untracked/삭제 포함)를 스냅샷으로 저장.
- 스냅샷 객체는 `refs/autogit/**` ref로 걸어 GC에서 보호.
- 작업 이력은 `.git/autogit/journal.json`에 기록되며 `undo`는 직전 스냅샷으로 복귀.
- `snapshots --prune`으로 저널이 참조하지 않는 ref를 정리.

## 보안

- 토큰을 명령줄 인자/로그/출력으로 내보내지 않음 — stdin 또는 `git credential approve`의
  stdin으로만 전달.
- 설정 파일은 `0600` 권한으로 저장.
- remote URL은 `https`/`http`/`ssh`/`git`/`file`/scp 형식만 허용하고 `ext::` 등
  remote helper는 차단.

## 테스트

```bash
npm test
```

임시 저장소를 만들어 status→stage→commit, 시간 되돌리기, remote·자격 증명,
GitHub 흐름(mock 서버), 헤드리스 CLI까지 검증합니다.

## 구조

```
bin/autogit.js         진입점
autogit                Linux/macOS 실행기 (./autogit [경로])
install.sh             Linux/macOS 전역 설치 (PATH 등록)
uninstall.sh           전역 설치 제거
AutoGit.bat            Windows 실행기 (더블클릭 / 드래그 앤 드롭)
src/cli.js             헤드리스 CLI
src/git.js             git 실행 래퍼 (상태/커밋/스냅샷/되돌리기)
src/github.js          GitHub API + 로그인
src/commitMessage.js   규칙 기반 커밋 메시지 생성
src/tui/app.js         TUI
src/tui/screen.js      터미널 화면 제어 (대체 화면, 한글 폭 계산)
tests/                 테스트
```
