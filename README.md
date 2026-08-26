# CodeOS

> 개발할 때는 개발만. 방해 요소를 시스템 수준에서 줄이는 Linux 기반 집중 개발 환경.

CodeOS는 **개발 환경 설치 자동화**와 **웹사이트 접근 제어**를 결합한 개인 프로젝트입니다. Ubuntu/Linux 환경에서 개발 도구를 빠르게 구성하고, 백그라운드 서비스와 Chromium 확장을 이용해 허용된 사이트만 접근할 수 있는 집중 환경을 만드는 것을 목표로 합니다.

현재 CodeOS는 별도의 Linux 배포판이라기보다 **기존 Linux 시스템 위에 설치되는 개발 집중 환경 및 관리 서비스**에 가깝습니다.

## 주요 기능

### 개발 환경 자동 설치

설치 프로그램에서 필요한 개발 도구를 선택하면 병렬로 설치합니다.

- Visual Studio Code
- Python 3 + pip
- G++
- Node.js
- npm
- Docker
- Vim

설치 로그는 `/tmp/codeos-install-*.log`에 저장됩니다.

### 화이트리스트 기반 웹 접근 제어

CodeOS의 핵심 접근 정책은 **blocklist가 아니라 whitelist**입니다.

- 화이트리스트에 등록된 도메인 → 접근 허용
- 등록되지 않은 도메인 → 접근 차단
- Chromium 계열 브라우저 → CodeOS 확장 프로그램이 로컬 서비스에 접근 가능 여부를 확인
- 차단 시 → CodeOS의 `blocked.html` 안내 페이지로 이동
- 정책을 적용할 수 없는 브라우저 → 우회 방지를 위한 Browser Guard 적용

화이트리스트는 다음 위치에 저장됩니다.

```text
/opt/codeos/whitelist.txt
```

### 로컬 백그라운드 서비스

CodeOS는 systemd 서비스로 실행되며 로컬 루프백 인터페이스에서 API를 제공합니다.

```text
127.0.0.1:5890
127.0.0.1:1234
```

`5890`은 CLI 및 브라우저 확장과 통신하는 API에 사용되고, `1234`는 차단 안내 페이지 제공에 사용됩니다.

외부 네트워크에서 API에 접근할 수 없도록 loopback 요청만 처리합니다.

## 구조

```text
CodeOS/
├── Program.cs                 # 설치 프로그램 / CLI 진입점
├── CodeOS.Background.cs       # 백그라운드 서비스
├── BackGroundSetup.cs         # 서비스 설치 및 systemd 구성
├── CodeOS_setup.csproj        # .NET 프로젝트
├── browser-extension/         # 브라우저 접근 제어 확장
├── blocked.html               # 사이트 차단 안내 페이지
├── index.html                 # CodeOS 웹 페이지
├── execute                    # 개발용 서비스 실행 스크립트
└── AGENTS.md                  # 개발/에이전트 참고 문서
```

## 요구 사항

- Linux (Ubuntu 계열 권장)
- .NET 10 SDK
- systemd
- 설치 시 root 권한
- Chromium 계열 브라우저

## 빌드

```bash
dotnet build
```

현재 별도의 테스트/린트 파이프라인은 없으며 `dotnet build`가 기본 검증 방법입니다.

## 설치

CodeOS는 시스템 파일과 `/opt/codeos`, systemd 설정 등을 수정하므로 관리자 권한이 필요합니다.

```bash
sudo dotnet run
```

설치 프로그램이 시작되면 원하는 개발 도구 번호를 선택합니다.

```text
1. Visual Studio Code
2. Python3
3. G++
4. Node.js
5. npm
6. Docker
7. Vim
```

예시:

```text
1 2 3 4 5 6
```

선택한 프로그램 설치와 CodeOS 백그라운드 서비스 구성이 진행됩니다.

## CLI

### 상태 확인

```bash
codeos status
```

### 화이트리스트 보기

```bash
codeos whitelist list
```

### 사이트 허용

```bash
codeos whitelist add example.com
```

### 사이트 제거

```bash
codeos whitelist remove example.com
```

### 화이트리스트 초기화

```bash
codeos whitelist clear
```

### 브라우저 정책 제거

```bash
codeos browser remove
```

### 도움말

```bash
codeos help
```

## 서비스만 다시 설치

`CodeOS.Background.cs`를 수정한 뒤 전체 개발 도구 설치 메뉴를 다시 실행할 필요 없이 서비스만 재설치할 수 있습니다.

```bash
sudo dotnet run -- --service-install
```

## 개발용 실행

저장소의 `execute` 스크립트는 백그라운드 서비스를 개발 중 직접 실행하고 확인하기 위한 도구입니다.

```bash
./execute
```

실행 로그는 다음 파일에서 확인할 수 있습니다.

```text
./execute.log
```

## 동작 흐름

```text
Browser
   │
   ▼
CodeOS Browser Extension
   │
   │  domain
   ▼
127.0.0.1:5890/api/access-status
   │
   ├── whitelist에 있음 ──▶ Allow
   │
   └── whitelist에 없음 ─▶ Block
                              │
                              ▼
                   127.0.0.1:1234/blocked.html
```

## 보안 설계

CodeOS는 브라우저에서 실행되는 일반 웹 페이지가 로컬 접근 판정 API를 임의로 사용하는 것을 줄이기 위해 다음과 같은 제한을 적용합니다.

- API 서버는 loopback 인터페이스에서만 동작
- 외부 IP 요청 거부
- 접근 판정 API는 WebExtension origin만 허용
- `chrome-extension://` / `moz-extension://` origin 검사
- 사용자 입력 도메인 정규화 및 검증
- 서비스는 systemd를 통해 관리

> CodeOS는 보안 제품이나 완전한 샌드박스가 아닙니다. 집중 환경 구축을 목적으로 하는 개인 프로젝트입니다.

## 기술 스택

- **C# / .NET 10**
- **HttpListener / HttpClient**
- **systemd**
- **Chromium WebExtension**
- **HTML / CSS / JavaScript**
- Linux system integration

## 프로젝트 목표

CodeOS의 방향은 단순히 사이트 하나를 차단하는 프로그램이 아닙니다.

1. 개발 환경을 빠르게 준비하고
2. 집중을 방해하는 접근 경로를 줄이며
3. CLI, 브라우저 확장, 백그라운드 서비스를 하나의 환경으로 통합해
4. 사용자가 코딩에 집중할 수 있는 개발 머신을 만드는 것

을 목표로 합니다.

## 현재 상태

CodeOS는 개발 중인 프로젝트입니다. 기능과 명령어, 설치 방식은 변경될 수 있습니다.

## Author

Made by **구윤재 (yoonjaekoo)**
