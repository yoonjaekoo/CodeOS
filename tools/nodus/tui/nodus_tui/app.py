"""Nodus TUI — 터미널에서 쓰는 Nodus 하네스.

토론·아이디어 지도·분기·코드 실행을 한 화면에서 다룬다. 엔진은 백엔드
(FastAPI)가 돌리고, 이 화면은 REST + SSE 클라이언트다. 먼저 백엔드를 띄운 뒤
(`./run.sh` 또는 `uvicorn app.main:app`) `./run-tui.sh`로 실행한다.

화면:
  ┌ Header ──────────────────────────────────────────────┐
  │ 채팅(왼쪽)            │ 지도 / 실행 / 가지 탭 (오른쪽) │
  ├──────────────────────────────────────────────────────┤
  │ 상태줄 · 입력줄 · 키 안내(Footer)                      │
  └──────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from rich.text import Text
from textual import on, work
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import (
    Button,
    DataTable,
    Footer,
    Header,
    Input,
    Label,
    Static,
    TabbedContent,
    TabPane,
)

from .api import NodusAPI, NodusAPIError

# ── 표시용 라벨 (웹 UI와 같은 문구를 쓴다) ─────────────────────────────────
NODE_TYPE_LABEL = {
    "idea": "아이디어",
    "question": "질문",
    "objection": "반론",
    "problem": "문제",
    "decision": "결정",
    "conclusion": "정리",
    "evidence": "실행 근거",
}
NODE_STATUS_LABEL = {"active": "진행 중", "refined": "다려짐", "merged": "합쳐짐", "dropped": "보류"}
EDGE_TYPE_LABEL = {
    "supports": "지지",
    "contradicts": "반대",
    "refines": "다듬음",
    "derives_from": "파생",
    "related_to": "연관",
    "duplicates": "중복",
    "verifies": "검증",
}
EXEC_STATUS_LABEL = {
    "ok": "성공",
    "failed": "실패",
    "timeout": "시간 초과",
    "error": "오류",
    "unavailable": "실행 불가",
}
AGENT_NAMES = {
    "A": "확장형 AI",
    "B": "비판형 AI",
    "C": "대안형 AI",
    "D": "실행형 AI",
    "E": "자유형 AI",
}
AGENT_COLORS = {"A": "blue", "B": "red", "C": "green", "D": "yellow", "E": "magenta"}
ROLE_NAMES = {"user": "나", "moderator": "진행 도우미", "execution": "코드 실행", "conclusion": "결론"}

MAX_BUBBLES = 400  # 채팅 위젯이 무한정 쌓이지 않게 오래된 말풍선을 버린다
STREAM_FLUSH_SEC = 0.08  # 토큰을 모아 이 간격으로 화면에 반영
MAX_TURNS_DEFAULT = 10

HELP_TEXT = """\
주제/토론
  (그냥 입력)            사용자 메시지 보내기 — AI는 턴을 세지 않고 바로 반영
  /start [턴수]          토론 시작 (기본 10턴, ctrl+s)
  /stop                  중지 (ctrl+t)
  /conclude              결론 내리기 (ctrl+n)
  /restart               처음부터 다시 시작 — 기록·지도를 지운다 (확인 후)
  /fork [노드id앞부분]   그 노드에서 가지 갈라내기 (없으면 지금 끝에서)

프로젝트/가지
  /new                   새 브레인스토밍 만들기 (폴더 분석 포함 가능)
  /projects              프로젝트 목록
  /open <번호 또는 id앞부분>   프로젝트 열기
  /branches              가지 목록 (ctrl+b 탭)
  /use <번호 또는 id앞부분>    가지 전환
  /reanalyze             프로젝트 폴더 다시 분석

지도/실행
  /graph                 아이디어 지도 텍스트로 보기 (ctrl+g 탭)
  /run [명령]            코드 실행 (없으면 자동 감지, ctrl+r 탭)
  /test [명령]           테스트 실행 (기본: 감지된 테스트 명령)
  /exec                  이 가지의 실행 기록
  /config                실행 설정·감지된 명령·샌드박스 상태
  /ls [경로]             폴더 목록 보기 (폴더 경로 찾을 때)

기타
  /status                연결·프로젝트·설정 요약
  /save [파일.md]        이 토론을 마크다운으로 저장
  /api [주소]            백엔드 주소 바꾸기 (기본 http://localhost:8000)
  /clear                 화면(채팅) 비우기 (ctrl+l)
  /help                  이 도움말
  /quit                  종료 (ctrl+q)

키: ctrl+s 시작 · ctrl+t 중지 · ctrl+n 결론 · ctrl+g/r/b 탭 · ctrl+o 패널 · ctrl+q 종료
SSE로 실시간 수신하므로 토론은 백엔드에서 계속 돈다 — 화면을 꺼도 멈추지 않는다.\
"""


# ── 위젯 ───────────────────────────────────────────────────────────────────
class Bubble(Static):
    """채팅 말풍선 한 개. 스트리밍 중에도 같은 위젯을 update()로 갱신한다."""

    def __init__(
        self,
        content: Text,
        *,
        role: str,
        agent_id: str | None = None,
        msg_key: str | None = None,
    ) -> None:
        classes = f"msg msg-{role}"
        if agent_id in AGENT_COLORS:
            classes += f" agent-{agent_id}"
        super().__init__(content, classes=classes)
        self.role = role
        self.agent_id = agent_id
        self.msg_key = msg_key


@dataclass
class _Stream:
    """지금 스트리밍 중인 발언."""

    agent_id: str
    name: str
    text: str = ""
    turn: int | None = None
    bubble: Bubble | None = None
    dirty: bool = False
    is_conclusion: bool = False


def bubble_text(header: str, header_style: str, body: str, body_style: str = "") -> Text:
    text = Text()
    text.append(header, style=header_style)
    if body:
        text.append("\n")
        text.append(body, style=body_style)
    return text


def message_renderable(m: dict) -> tuple[Text, str, str | None, str]:
    """서버 메시지 dict -> (Text, role, agent_id, msg_key)."""
    role = str(m.get("role") or "agent")
    body = str(m.get("content") or "")
    key = str(m.get("id") or "")
    if role == "agent":
        agent_id = str(m.get("agent_id") or "")
        name = str(m.get("agent_name") or AGENT_NAMES.get(agent_id, "AI"))
        color = AGENT_COLORS.get(agent_id, "cyan")
        turn = m.get("turn")
        header = f"{name} · {turn}턴" if turn else name
        return bubble_text(header, f"bold {color}", body), role, agent_id, key
    name = str(m.get("agent_name") or ROLE_NAMES.get(role, role))
    styles = {
        "user": "bold white",
        "moderator": "bold yellow",
        "execution": "bold green",
        "conclusion": "bold cyan",
    }
    body_style = "grey70" if role == "execution" else ""
    return bubble_text(name, styles.get(role, "bold"), body, body_style), role, None, key


# ── 모달 ───────────────────────────────────────────────────────────────────
class NewProjectScreen(ModalScreen[dict | None]):
    """새 브레인스토밍 만들기 (제목·주제·설정·폴더)."""

    BINDINGS = [Binding("escape", "cancel", "취소")]

    _ORDER = ("#np-title", "#np-topic", "#np-agents", "#np-interval", "#np-turns", "#np-path")

    def compose(self) -> ComposeResult:
        with Vertical(id="np-box"):
            yield Label("새 브레인스토밍", id="np-head")
            yield Label("제목 *")
            yield Input(placeholder="예: 펫케어 앱 구상", id="np-title")
            yield Label("주제 *")
            yield Input(placeholder="무엇을 두고 토론할지 한 줄로", id="np-topic")
            with Horizontal(classes="np-row"):
                with Vertical(classes="np-col"):
                    yield Label("AI 수 (2–5)")
                    yield Input(value="3", id="np-agents")
                with Vertical(classes="np-col"):
                    yield Label("지도 주기 (턴)")
                    yield Input(value="10", id="np-interval")
                with Vertical(classes="np-col"):
                    yield Label("최대 턴 (-1=무제한)")
                    yield Input(value="50", id="np-turns")
            yield Label("폴더 경로 (선택 — 넣으면 프로젝트를 분석합니다)")
            yield Input(placeholder="/home/pi/내프로젝트", id="np-path")
            with Horizontal(classes="np-buttons"):
                yield Button("만들기", variant="primary", id="np-create")
                yield Button("취소", id="np-cancel")

    def on_mount(self) -> None:
        self.query_one("#np-title", Input).focus()

    def action_cancel(self) -> None:
        self.dismiss(None)

    @on(Button.Pressed, "#np-cancel")
    def _cancel(self) -> None:
        self.dismiss(None)

    @on(Input.Submitted)
    def _next_field(self, event: Input.Submitted) -> None:
        """엔터로 다음 칸 이동, 마지막 칸에서는 만들기."""
        widget_id = f"#{event.input.id}"
        idx = self._ORDER.index(widget_id) if widget_id in self._ORDER else -1
        if 0 <= idx < len(self._ORDER) - 1:
            self.query_one(self._ORDER[idx + 1], Input).focus()
        else:
            self._create()

    @on(Button.Pressed, "#np-create")
    def _create(self) -> None:
        title = self.query_one("#np-title", Input).value.strip()
        topic = self.query_one("#np-topic", Input).value.strip()
        if not title or not topic:
            self.notify("제목과 주제는 필수입니다", severity="error")
            return
        try:
            agents = max(2, min(5, int(self.query_one("#np-agents", Input).value.strip() or "3")))
            interval = max(1, min(100, int(self.query_one("#np-interval", Input).value.strip() or "10")))
            turns = int(self.query_one("#np-turns", Input).value.strip() or "50")
            if turns < -1:
                raise ValueError("turns")
        except ValueError:
            self.notify("숫자 칸을 확인하세요 (AI 2–5, 주기 1–100, 턴 -1 이상)", severity="error")
            return
        self.dismiss(
            {
                "title": title,
                "topic": topic,
                "agent_count": agents,
                "graph_interval": interval,
                "max_turns": turns,
                "project_path": self.query_one("#np-path", Input).value.strip(),
            }
        )


class ConfirmScreen(ModalScreen[bool]):
    """되돌릴 수 없는 동작 확인."""

    BINDINGS = [Binding("escape", "cancel", "취소")]

    def __init__(self, message: str, *, ok_label: str = "실행") -> None:
        super().__init__()
        self.message = message
        self.ok_label = ok_label

    def compose(self) -> ComposeResult:
        with Vertical(id="cf-box"):
            yield Static(self.message, id="cf-message", markup=False)
            with Horizontal(classes="np-buttons"):
                yield Button(self.ok_label, variant="error", id="cf-ok")
                yield Button("취소", id="cf-cancel")

    def on_mount(self) -> None:
        self.query_one("#cf-cancel", Button).focus()

    def action_cancel(self) -> None:
        self.dismiss(False)

    @on(Button.Pressed, "#cf-ok")
    def _ok(self) -> None:
        self.dismiss(True)

    @on(Button.Pressed, "#cf-cancel")
    def _cancel(self) -> None:
        self.dismiss(False)


# ── 앱 ─────────────────────────────────────────────────────────────────────
class NodusTUI(App[None]):
    """Nodus 터미널 하네스."""

    CSS_PATH = "nodus.tcss"
    TITLE = "Nodus TUI"
    SUB_TITLE = "터미널 AI 브레인스토밍 하네스"

    BINDINGS = [
        Binding("f1", "help", "도움말"),
        Binding("ctrl+s", "start", "시작"),
        Binding("ctrl+t", "stop", "중지"),
        Binding("ctrl+n", "conclude", "결론"),
        Binding("ctrl+g", "tab_graph", "지도탭"),
        Binding("ctrl+r", "tab_exec", "실행탭"),
        Binding("ctrl+b", "tab_branches", "가지탭"),
        Binding("ctrl+o", "toggle_side", "패널"),
        Binding("ctrl+l", "clear_chat", "비우기"),
        Binding("ctrl+q", "quit", "종료"),
    ]

    def __init__(self, api_url: str = "http://localhost:8000", initial_project: str | None = None) -> None:
        super().__init__()
        self.api = NodusAPI(api_url)
        self.initial_project = initial_project

        self.online = False
        self.llm_configured: bool | None = None
        self.project: dict | None = None
        self.branches: list[dict] = []
        self.discussion: dict | None = None
        self.executions: dict[str, dict] = {}
        self.exec_running = False
        self.sandbox_info: dict | None = None
        self.turns_default = MAX_TURNS_DEFAULT

        self._stream: _Stream | None = None
        self._sse_branch: str | None = None
        self._bubble_by_id: dict[str, Bubble] = {}
        self._scroll_pending = False
        self._booted = False

    # ── 화면 구성 ──────────────────────────────────────────────────────────
    def compose(self) -> ComposeResult:
        yield Header(show_clock=True)
        with Horizontal(id="body"):
            yield VerticalScroll(id="chat")
            with TabbedContent(id="side"):
                with TabPane("지도", id="tab-graph"):
                    with VerticalScroll():
                        yield Static(
                            Text("아직 지도가 없습니다. 토론이 지도 주기에 닿으면 채워집니다.", style="dim"),
                            id="graph-text",
                        )
                with TabPane("실행", id="tab-exec"):
                    yield DataTable(id="exec-table")
                with TabPane("가지", id="tab-branches"):
                    yield DataTable(id="branch-table")
        yield Static(Text("연결 중…", style="dim"), id="status")
        yield Input(placeholder="메시지를 입력하거나 /help — 명령은 / 로 시작", id="prompt")
        yield Footer()

    def on_mount(self) -> None:
        self.query_one("#prompt", Input).focus()
        exec_table = self.query_one("#exec-table", DataTable)
        exec_table.cursor_type = "row"
        exec_table.add_columns("상태", "종류", "명령", "시간", "exit")
        branch_table = self.query_one("#branch-table", DataTable)
        branch_table.cursor_type = "row"
        branch_table.add_columns("", "이름", "턴", "상태", "메시지", "노드")

        self._line(f"Nodus TUI · {self.api.base_url}", style="bold")
        self._line("엔진은 백엔드가 돌립니다. /help 로 명령을 보세요.", style="dim")
        self._connect()
        self.set_interval(STREAM_FLUSH_SEC, self._flush_stream)
        self.set_interval(10.0, self._health_check)

    async def on_unmount(self) -> None:
        self._sse_branch = None
        await self.api.close()

    # ── 연결 ───────────────────────────────────────────────────────────────
    @work(exclusive=True, group="connect", exit_on_error=False)
    async def _connect(self) -> None:
        warned = False
        while True:
            try:
                await self._ping()
            except NodusAPIError as exc:
                if not warned:
                    self._line(f"백엔드에 연결할 수 없습니다 — {exc}", style="yellow")
                    self._line(
                        "백엔드를 먼저 띄우세요: ./run.sh (또는 uvicorn app.main:app). "
                        "5초마다 다시 시도합니다. 다른 주소면 /api <주소>.",
                        style="dim",
                    )
                    warned = True
                await asyncio.sleep(5)
                continue
            self._line(f"연결됨 · LLM {'실제 모델' if self.llm_configured else 'mock 모드'}", style="green")
            try:
                await self._bootstrap()
            except NodusAPIError as exc:
                self._line(str(exc), style="red")
            return

    @work(exclusive=True, group="health", exit_on_error=False)
    async def _health_check(self) -> None:
        try:
            await self._ping()
        except NodusAPIError:
            if self.online:
                self.online = False
                self._line("백엔드 연결이 끊겼습니다. 다시 시도 중…", style="yellow")
                self._refresh_status()
            return
        if not self.online and self._booted:
            self._line("백엔드에 다시 연결됐습니다.", style="green")
            await self._bootstrap()
        self._refresh_status()

    async def _ping(self) -> None:
        health = await self.api.health()
        self.online = True
        self.llm_configured = bool(health.get("llm_configured"))

    async def _bootstrap(self) -> None:
        """처음 연결됐을 때: 프로젝트 목록 → 시작 프로젝트 열기."""
        if self.project is not None:
            return
        self._booted = True
        if self.initial_project:
            target = await self._resolve_project(self.initial_project)
            if target:
                await self._open_project(target)
                return
            self._line(f"시작 프로젝트 '{self.initial_project}'를 찾지 못했습니다.", style="yellow")
        projects = await self.api.list_projects()
        if not projects:
            self._line("프로젝트가 없습니다. /new 로 새로 시작하세요.", style="dim")
            return
        self._render_project_list(projects)
        await self._open_project(str(projects[0]["id"]))

    async def _resolve_project(self, token: str) -> str | None:
        projects = await self.api.list_projects()
        token = token.strip()
        if token.isdigit():
            idx = int(token) - 1
            if 0 <= idx < len(projects):
                return str(projects[idx]["id"])
            return None
        for p in projects:
            if str(p["id"]).startswith(token):
                return str(p["id"])
        return None

    # ── 프로젝트 / 가지 ────────────────────────────────────────────────────
    async def _open_project(self, project_id: str) -> None:
        project = await self.api.get_project(project_id)
        self.project = project
        self.branches = list(project.get("branches") or [])
        self._render_branches()
        self._line(f"프로젝트: {project.get('title')} — {project.get('topic')}", style="bold")
        path = project.get("project_path")
        if path:
            self._line(f"폴더: {path} · 분석: {project.get('context_status')}", style="dim")
            if project.get("context_status") == "analyzing":
                self._poll_analysis(project_id)
        root = next((b for b in self.branches if b.get("parent_branch_id") is None), None)
        if root is None and self.branches:
            root = self.branches[0]
        if root:
            await self._open_branch(str(root["id"]))
        self._refresh_status()

    async def _open_branch(self, branch_id: str) -> None:
        same = bool(self.discussion and self.discussion.get("id") == branch_id)
        discussion = await self.api.get_discussion(branch_id)
        self.discussion = discussion
        self._render_chat(discussion)
        self._render_graph(discussion.get("graph") or {})
        self._render_branches()
        await self._refresh_executions()
        self._refresh_status()
        if not same:
            self._line(
                f"가지 열림: {discussion.get('name')} · "
                f"{discussion.get('ai_turn_count', 0)}/{discussion.get('max_turns') or '∞'}턴 · "
                f"AI {discussion.get('agent_count')}명",
                style="dim",
            )
        self._start_sse(branch_id)

    def _start_sse(self, branch_id: str) -> None:
        if self._sse_branch == branch_id:
            return
        self._sse_branch = branch_id
        self._sse_loop(branch_id)

    @work(exclusive=True, group="sse", exit_on_error=False)
    async def _sse_loop(self, branch_id: str) -> None:
        """SSE 스트림을 붙잡고 이벤트를 화면에 반영. 끊기면 2초마다 재연결."""
        while self._sse_branch == branch_id:
            try:
                async for event, data in self.api.stream(branch_id):
                    if self._sse_branch != branch_id:
                        return
                    await self._handle_event(event, data)
            except asyncio.CancelledError:
                raise
            except NodusAPIError as exc:
                if self._sse_branch != branch_id:
                    return
                self._line(f"SSE 끊김 — {exc} (2초 후 재연결)", style="yellow")
            except Exception as exc:  # 화면이 죽지 않게 전부 잡는다
                if self._sse_branch != branch_id:
                    return
                self._line(f"SSE 오류: {exc} (2초 후 재연결)", style="yellow")
            if self._sse_branch != branch_id:
                return
            await asyncio.sleep(2)

    # ── SSE 이벤트 ─────────────────────────────────────────────────────────
    async def _handle_event(self, event: str, data: dict) -> None:
        if event == "token":
            self._append_token(str(data.get("agent_id") or ""), str(data.get("token") or ""))
        elif event == "agent_start":
            agent_id = str(data.get("agent_id") or "")
            self._stream = _Stream(
                agent_id=agent_id,
                name=str(data.get("agent_name") or AGENT_NAMES.get(agent_id, "AI")),
                is_conclusion=(agent_id == "conclusion"),
            )
        elif event == "agent_message":
            self._finalize_stream(data)
        elif event == "user_message":
            self._upsert_message(data)
        elif event == "moderator_alert":
            self._line(str(data.get("message") or ""), style="yellow", header="진행 도우미")
        elif event == "conclusion":
            message = data.get("message")
            if isinstance(message, dict):
                self._upsert_message(message)
            graph = data.get("graph")
            if isinstance(graph, dict):
                self._render_graph(graph)
            self._stream = None
            self._refresh_status()
        elif event == "graph_update":
            graph = data.get("graph")
            if isinstance(graph, dict):
                self._render_graph(graph)
            summary = str(data.get("summary") or "")
            self._line(
                f"지도 갱신 ({data.get('turn')}턴)" + (f" — {summary}" if summary else ""), style="dim"
            )
        elif event == "graph_snapshot_start":
            self._line(f"지도 갱신 중 ({data.get('turn')}턴)…", style="dim")
        elif event == "execution_start":
            self.exec_running = True
            self._line(
                f"[실행] {data.get('kind_label') or data.get('kind')}: {data.get('command')} "
                f"(이미지 {data.get('image')}, 요청 {data.get('requested_by')})",
                style="green",
            )
            self._refresh_status()
        elif event == "execution_result":
            execution = data.get("execution") or {}
            self.exec_running = False
            if isinstance(execution, dict) and execution.get("id"):
                self.executions[str(execution["id"])] = execution
                self._render_exec_table()
            message = data.get("message")
            if isinstance(message, dict):
                self._upsert_message(message)
            graph = data.get("graph")
            if isinstance(graph, dict):
                self._render_graph(graph)
            self._refresh_status()
        elif event == "turn_complete":
            if self.discussion is not None:
                self.discussion["ai_turn_count"] = data.get("turn") or self.discussion.get("ai_turn_count")
            self._refresh_status()
        elif event == "branch_created":
            self._line(f"가지가 만들어졌습니다 (fork turn {data.get('fork_turn')}).", style="dim")
            await self._refresh_project()
        elif event == "done":
            self._stream = None
            self.exec_running = False
            await self._sync_after_done(data)
        elif event == "error":
            self._line(str(data.get("message") or "오류"), style="red")
        # connected/heartbeat 등은 무시

    async def _sync_after_done(self, data: dict) -> None:
        reason = data.get("reason")
        if self.discussion is not None:
            branch_id = str(self.discussion.get("id"))
            try:
                discussion = await self.api.get_discussion(branch_id)
            except NodusAPIError as exc:
                self._line(str(exc), style="red")
            else:
                if self.discussion is not None and str(self.discussion.get("id")) == branch_id:
                    self.discussion = discussion
                    self._render_chat(discussion)
                    self._render_graph(discussion.get("graph") or {})
                    await self._refresh_executions()
        await self._refresh_project()
        self._refresh_status()
        self._line(
            "토론이 끝났습니다" + (" (결론 포함)" if reason == "concluded" else ""),
            style="bold green",
        )

    async def _refresh_project(self) -> None:
        if self.project is None:
            return
        try:
            project = await self.api.get_project(str(self.project.get("id")))
        except NodusAPIError:
            return
        self.project = project
        self.branches = list(project.get("branches") or [])
        self._render_branches()

    async def _refresh_executions(self) -> None:
        if self.discussion is None:
            return
        try:
            payload = await self.api.executions(str(self.discussion.get("id")))
        except NodusAPIError:
            return
        self.exec_running = bool(payload.get("is_running"))
        self.executions = {str(e["id"]): e for e in payload.get("executions") or []}
        self._render_exec_table()
        self._refresh_status()

    # ── 스트리밍 ───────────────────────────────────────────────────────────
    def _append_token(self, agent_id: str, token: str) -> None:
        stream = self._stream
        if stream is None or stream.agent_id != agent_id:
            stream = _Stream(agent_id=agent_id, name=AGENT_NAMES.get(agent_id, "AI"))
            self._stream = stream
        stream.text += token
        stream.dirty = True

    def _flush_stream(self) -> None:
        stream = self._stream
        if stream is None or not stream.dirty:
            return
        stream.dirty = False
        was_end = self._at_chat_end()
        header = self._stream_header(stream)
        style = f"bold {AGENT_COLORS.get(stream.agent_id, 'cyan')}"
        renderable = bubble_text(header, style, stream.text or "…")
        if stream.bubble is None:
            stream.bubble = self._mount_bubble(renderable, role="agent", agent_id=stream.agent_id)
        else:
            stream.bubble.update(renderable)
        if was_end:
            self._scroll_chat_end()

    def _stream_header(self, stream: _Stream) -> str:
        if stream.agent_id == "conclusion":
            return "결론 작성 중…"
        return f"{stream.name} · 발언 중…"

    def _finalize_stream(self, message: dict) -> None:
        stream = self._stream
        self._stream = None
        if stream is not None and stream.bubble is not None:
            renderable, _role, _agent, _key = message_renderable(message)
            stream.bubble.update(renderable)
            if stream.bubble.msg_key is None:
                stream.bubble.msg_key = str(message.get("id") or "")
                if stream.bubble.msg_key:
                    self._bubble_by_id[stream.bubble.msg_key] = stream.bubble
            self._trim_chat()
            if self._at_chat_end():
                self._scroll_chat_end()
        else:
            self._upsert_message(message)

    # ── 채팅 렌더링 ────────────────────────────────────────────────────────
    def _render_chat(self, discussion: dict) -> None:
        messages = list(discussion.get("messages") or [])
        hidden = max(0, len(messages) - MAX_BUBBLES)
        shown = messages[hidden:]
        self.query_one("#chat", VerticalScroll).remove_children()
        self._bubble_by_id = {}
        bubbles: list[Bubble] = []
        if hidden:
            bubbles.append(
                Bubble(Text(f"… 앞부분 {hidden}개 메시지는 접었습니다", style="dim"), role="system")
            )
        for m in shown:
            renderable, role, agent_id, key = message_renderable(m)
            bubbles.append(Bubble(renderable, role=role, agent_id=agent_id, msg_key=key or None))
            if key:
                self._bubble_by_id[key] = bubbles[-1]
        self.query_one("#chat", VerticalScroll).mount_all(bubbles)
        self._scroll_chat_end()
        self._refresh_status()

    def _upsert_message(self, message: dict) -> None:
        """서버 메시지를 채팅에 반영 (같은 id면 내용만 갱신)."""
        renderable, role, agent_id, key = message_renderable(message)
        existing = self._bubble_by_id.get(key)
        if existing is not None:
            existing.update(renderable)
            self._trim_chat()
            return
        was_end = self._at_chat_end()
        bubble = self._mount_bubble(renderable, role=role, agent_id=agent_id, msg_key=key or None)
        if key:
            self._bubble_by_id[key] = bubble
        if was_end:
            self._scroll_chat_end()

    def _mount_bubble(
        self,
        renderable: Text,
        *,
        role: str,
        agent_id: str | None = None,
        msg_key: str | None = None,
    ) -> Bubble:
        bubble = Bubble(renderable, role=role, agent_id=agent_id, msg_key=msg_key)
        self.query_one("#chat", VerticalScroll).mount(bubble)
        self._trim_chat()
        return bubble

    def _line(self, text: str, style: str = "", header: str | None = None) -> None:
        """시스템 안내 한 줄 (메시지가 아니라 화면 메모)."""
        body = Text()
        if header:
            body.append(f"{header}: ", style="bold yellow")
        body.append(text, style=style)
        was_end = self._at_chat_end()
        self._mount_bubble(body, role="system")
        if was_end:
            self._scroll_chat_end()

    def _trim_chat(self) -> None:
        chat = self.query_one("#chat", VerticalScroll)
        children = list(chat.children)
        extra = len(children) - MAX_BUBBLES
        if extra <= 0:
            return
        for child in children[:extra]:
            child.remove()

    def _at_chat_end(self) -> bool:
        try:
            return bool(self.query_one("#chat", VerticalScroll).is_vertical_scroll_end)
        except Exception:
            return True

    def _scroll_chat_end(self) -> None:
        if self._scroll_pending:
            return
        self._scroll_pending = True

        def _do() -> None:
            self._scroll_pending = False
            self.query_one("#chat", VerticalScroll).scroll_end(animate=False)

        self.call_after_refresh(_do)

    # ── 패널 렌더링 ────────────────────────────────────────────────────────
    def _render_graph(self, graph: dict) -> None:
        nodes = list(graph.get("nodes") or [])
        edges = list(graph.get("edges") or [])
        text = Text()
        if not nodes:
            text.append("아직 지도가 없습니다. 토론이 지도 주기에 닿으면 채워집니다.", style="dim")
        else:
            by_type: dict[str, list[dict]] = {}
            for n in nodes:
                by_type.setdefault(str(n.get("type") or "idea"), []).append(n)
            labels = {str(n.get("id")): str(n.get("label") or "") for n in nodes}
            for node_type, group in by_type.items():
                text.append(f"[{NODE_TYPE_LABEL.get(node_type, node_type)}] {len(group)}개\n", style="bold")
                for n in group:
                    status = NODE_STATUS_LABEL.get(str(n.get("status")), str(n.get("status")))
                    text.append("  • ")
                    text.append(str(n.get("label") or ""), style="bold")
                    text.append(f"  ({status})", style="dim")
                    text.append(f"  {str(n.get('id'))[:12]}", style="dim")
                    description = " ".join(str(n.get("description") or "").split())
                    if description:
                        text.append(f"\n     {description[:90]}", style="dim")
                    text.append("\n")
            if edges:
                text.append(f"\n[관계] {len(edges)}개\n", style="bold")
                for e in edges[:80]:
                    src = labels.get(str(e.get("source")), str(e.get("source"))[:10])
                    dst = labels.get(str(e.get("target")), str(e.get("target"))[:10])
                    edge_type = EDGE_TYPE_LABEL.get(str(e.get("type")), str(e.get("type")))
                    text.append(f"  {src} —[{edge_type}]→ {dst}\n", style="dim")
        self.query_one("#graph-text", Static).update(text)

    def _render_exec_table(self) -> None:
        table = self.query_one("#exec-table", DataTable)
        table.clear()
        runs = sorted(self.executions.values(), key=lambda e: str(e.get("created_at") or ""), reverse=True)
        for e in runs[:50]:
            status = EXEC_STATUS_LABEL.get(str(e.get("status")), str(e.get("status")))
            duration = f"{int(e.get('duration_ms') or 0) / 1000:.1f}s"
            exit_code = e.get("exit_code")
            table.add_row(
                Text(status, style="green" if e.get("status") == "ok" else "red"),
                str(e.get("kind_label") or e.get("kind") or ""),
                Text(str(e.get("command") or "")[:60]),
                duration,
                "-" if exit_code is None else str(exit_code),
                key=str(e.get("id")),
            )

    def _render_branches(self) -> None:
        table = self.query_one("#branch-table", DataTable)
        table.clear()
        current = str(self.discussion.get("id")) if self.discussion else ""
        for b in self.branches:
            marker = "▶" if str(b.get("id")) == current else " "
            max_turns = b.get("max_turns")
            turns = f"{b.get('ai_turn_count', 0)}/{max_turns if max_turns and max_turns > 0 else '∞'}"
            table.add_row(
                marker,
                str(b.get("name") or ""),
                turns,
                str(b.get("status") or ""),
                str(b.get("message_count") or 0),
                str(b.get("node_count") or 0),
                key=str(b.get("id")),
            )

    def _render_project_list(self, projects: list[dict]) -> None:
        for i, p in enumerate(projects, start=1):
            self._line(
                f"{i}. {p.get('title')} — {p.get('topic')}  ({str(p.get('id'))[:12]})", style="dim"
            )

    def _refresh_status(self) -> None:
        text = Text()
        if not self.online:
            text.append("● 오프라인", style="bold red")
        elif (self.discussion or {}).get("is_running"):
            text.append("● 실행 중", style="bold green")
            if self.exec_running:
                text.append(" · 코드 실행 중", style="green")
        else:
            text.append("○ 대기", style="dim")

        title = str((self.project or {}).get("title") or "프로젝트 없음")
        text.append("  ")
        text.append(title, style="bold")
        if self.discussion:
            max_turns = self.discussion.get("max_turns")
            limit = max_turns if max_turns and max_turns > 0 else "∞"
            text.append(f" · {self.discussion.get('name')} {self.discussion.get('ai_turn_count', 0)}/{limit}턴")
        text.append("  ")
        text.append(f"LLM {'실제' if self.llm_configured else 'mock'}", style="dim")
        text.append("  ")
        text.append(self.api.base_url, style="dim")
        self.query_one("#status", Static).update(text)

    # ── 입력 처리 ──────────────────────────────────────────────────────────
    @on(Input.Submitted, "#prompt")
    async def _on_prompt(self, event: Input.Submitted) -> None:
        text = event.value.strip()
        event.input.value = ""
        if not text:
            return
        if text.startswith("/"):
            await self._run_command(text)
        else:
            await self._send_user_message(text)

    async def _send_user_message(self, content: str) -> None:
        if self.discussion is None:
            self.notify("프로젝트를 먼저 여세요 (/open, /new)", severity="warning")
            return
        try:
            message = await self.api.post_message(str(self.discussion.get("id")), content)
        except NodusAPIError as exc:
            self.notify(str(exc), severity="error")
            return
        if isinstance(message, dict):
            self._upsert_message(message)

    async def _run_command(self, raw: str) -> None:
        name, _, arg = raw.partition(" ")
        name = name.lower()
        arg = arg.strip()
        handler = {
            "/help": self._cmd_help,
            "/projects": self._cmd_projects,
            "/open": self._cmd_open,
            "/new": self._cmd_new,
            "/branches": self._cmd_branches,
            "/use": self._cmd_use,
            "/start": self._cmd_start,
            "/stop": self._cmd_stop,
            "/conclude": self._cmd_conclude,
            "/restart": self._cmd_restart,
            "/fork": self._cmd_fork,
            "/graph": self._cmd_graph,
            "/ls": self._cmd_ls,
            "/run": self._cmd_run,
            "/test": self._cmd_test,
            "/exec": self._cmd_exec,
            "/config": self._cmd_config,
            "/status": self._cmd_status,
            "/api": self._cmd_api,
            "/save": self._cmd_save,
            "/clear": self._cmd_clear,
            "/reanalyze": self._cmd_reanalyze,
            "/quit": self._cmd_quit,
            "/exit": self._cmd_quit,
            "/q": self._cmd_quit,
        }.get(name)
        if handler is None:
            self.notify(f"모르는 명령: {name} — /help", severity="warning")
            return
        await handler(arg)

    # ── 명령 ───────────────────────────────────────────────────────────────
    async def _cmd_help(self, _arg: str = "") -> None:
        """도움말은 마크업 없이 그린다 (본문의 대괄호가 서식으로 먹히지 않게)."""
        for block in HELP_TEXT.split("\n\n"):
            lines = block.splitlines()
            text = Text()
            if lines:
                text.append(lines[0] + "\n", style="bold")
                text.append("\n".join(lines[1:]))
            self._mount_bubble(text, role="system")

    async def _cmd_projects(self, _arg: str = "") -> None:
        try:
            projects = await self.api.list_projects()
        except NodusAPIError as exc:
            self.notify(str(exc), severity="error")
            return
        if not projects:
            self._line("프로젝트가 없습니다. /new 로 새로 시작하세요.", style="dim")
            return
        self._render_project_list(projects)
        self._line("'/open <번호>' 로 여세요.", style="dim")

    async def _cmd_open(self, arg: str) -> None:
        if not arg:
            await self._cmd_projects()
            return
        target = await self._resolve_project(arg)
        if target is None:
            self.notify(f"프로젝트 '{arg}'를 찾지 못했습니다", severity="error")
            return
        self._sse_branch = None
        self.discussion = None
        try:
            await self._open_project(target)
        except NodusAPIError as exc:
            self.notify(str(exc), severity="error")

    async def _cmd_new(self, _arg: str = "") -> None:
        if not self.online:
            self.notify("백엔드에 연결되면 만들 수 있습니다", severity="warning")
            return
        self.push_screen(NewProjectScreen(), self._new_project_result)

    def _new_project_result(self, data: dict | None) -> None:
        if data:
            self._create_project(data)

    @work(exclusive=True, group="create", exit_on_error=False)
    async def _create_project(self, data: dict) -> None:
        path = str(data.get("project_path") or "").strip()
        if path:
            try:
                check = await self.api.validate_dir(path)
            except NodusAPIError as exc:
                self.notify(str(exc), severity="error")
                return
            if not check.get("ok"):
                self.notify(f"폴더를 쓸 수 없습니다: {path}", severity="error")
                return
        try:
            project = await self.api.create_project(
                title=str(data["title"]),
                topic=str(data["topic"]),
                agent_count=int(data["agent_count"]),
                graph_interval=int(data["graph_interval"]),
                max_turns=int(data["max_turns"]),
                project_path=path or None,
            )
        except NodusAPIError as exc:
            self.notify(str(exc), severity="error")
            return
        self._line(f"프로젝트를 만들었습니다: {project.get('title')}", style="bold green")
        self.discussion = None
        self._sse_branch = None
        await self._open_project(str(project["id"]))
        if path:
            self._poll_analysis(str(project["id"]))

    @work(exclusive=True, group="analysis", exit_on_error=False)
    async def _poll_analysis(self, project_id: str) -> None:
        """폴더 분석 진행 상황을 채팅에 한 줄씩 보여준다 (분석은 백엔드가 한다)."""
        last = ""
        for _ in range(600):
            try:
                payload = await self.api.get_context(project_id)
            except NodusAPIError:
                return
            progress = payload.get("progress") or {}
            stages = progress.get("stages") or []
            status = str(payload.get("status") or "")
            detail = " · ".join(
                f"{s.get('label')}{'✓' if s.get('status') == 'done' else '…' if s.get('status') == 'running' else ''}"
                for s in stages
            )
            if detail and detail != last:
                self._line(f"[분석] {detail}", style="dim")
                last = detail
            if status != "analyzing":
                if status == "done":
                    counts = progress.get("counts") or {}
                    self._line(
                        f"[분석] 완료 — 파일 {counts.get('scanned', '?')}개 스캔, "
                        f"{counts.get('selected', '?')}개 선정, {counts.get('read', '?')}개 읽음",
                        style="dim",
                    )
                else:
                    self._line(f"[분석] {status}", style="yellow")
                if self.project is not None and str(self.project.get("id")) == project_id:
                    await self._refresh_project()
                return
            await asyncio.sleep(2)

    async def _cmd_reanalyze(self, _arg: str = "") -> None:
        if self.project is None or not self.project.get("project_path"):
            self.notify("폴더가 연결된 프로젝트가 아닙니다", severity="warning")
            return
        try:
            await self.api.analyze(str(self.project["id"]))
        except NodusAPIError as exc:
            self.notify(str(exc), severity="error")
            return
        self._line("폴더 다시 분석을 시작합니다…", style="dim")
        self._poll_analysis(str(self.project["id"]))

    async def _cmd_branches(self, _arg: str = "") -> None:
        await self._refresh_project()
        for i, b in enumerate(self.branches, start=1):
            marker = "▶" if self.discussion and b.get("id") == self.discussion.get("id") else " "
            self._line(
                f"{marker} {i}. {b.get('name')} · {b.get('ai_turn_count', 0)}턴 · "
                f"메시지 {b.get('message_count', 0)} · 노드 {b.get('node_count', 0)} · {b.get('status')}",
                style="dim",
            )
        self.query_one("#side", TabbedContent).active = "tab-branches"

    async def _cmd_use(self, arg: str) -> None:
        if not arg:
            await self._cmd_branches()
            return
        target: str | None = None
        if arg.isdigit():
            idx = int(arg) - 1
            if 0 <= idx < len(self.branches):
                target = str(self.branches[idx]["id"])
        else:
            target = next((str(b["id"]) for b in self.branches if str(b["id"]).startswith(arg)), None)
        if target is None:
            self.notify(f"가지 '{arg}'를 찾지 못했습니다", severity="error")
            return
        await self._switch_branch(target)

    async def _switch_branch(self, branch_id: str) -> None:
        try:
            await self._open_branch(branch_id)
        except NodusAPIError as exc:
            self.notify(str(exc), severity="error")
            return
        self._render_branches()

    async def _cmd_start(self, arg: str) -> None:
        if self.discussion is None:
            self.notify("프로젝트를 먼저 여세요 (/open, /new)", severity="warning")
            return
        if arg:
            try:
                self.turns_default = max(1, min(500, int(arg)))
            except ValueError:
                self.notify("턴수는 숫자로", severity="error")
                return
        try:
            result = await self.api.start(str(self.discussion["id"]), self.turns_default)
        except NodusAPIError as exc:
            self.notify(str(exc), severity="error")
            return
        if result.get("status") == "already_running":
            self.notify("이미 실행 중입니다", severity="warning")
            return
        if self.discussion is not None:
            self.discussion["is_running"] = True
        self._line(f"토론 시작 — 최대 {self.turns_default}턴", style="bold green")
        self._refresh_status()

    async def _cmd_stop(self, _arg: str = "") -> None:
        if self.discussion is None:
            return
        try:
            await self.api.stop(str(self.discussion["id"]))
        except NodusAPIError as exc:
            self.notify(str(exc), severity="error")
            return
        self._line("중지 요청 — 현재 발언이 끝나면 멈춥니다.", style="yellow")

    async def _cmd_conclude(self, _arg: str = "") -> None:
        if self.discussion is None:
            return
        try:
            result = await self.api.conclude(str(self.discussion["id"]))
        except NodusAPIError as exc:
            self.notify(str(exc), severity="error")
            return
        if result.get("status") == "requested":
            self._line("결론 요청 — 현재 발언이 끝나면 결론을 씁니다.", style="dim")
        else:
            self._line("결론을 작성합니다…", style="dim")

    async def _cmd_restart(self, _arg: str = "") -> None:
        if self.discussion is None:
            return
        self.push_screen(
            ConfirmScreen(
                "처음부터 다시 시작할까요?\n\n이 가지의 대화 기록과 아이디어 지도를 전부 지웁니다. 되돌릴 수 없습니다.",
                ok_label="지우고 다시 시작",
            ),
            self._restart_confirmed,
        )

    def _restart_confirmed(self, ok: bool | None) -> None:
        if ok:
            self._do_restart()

    @work(exclusive=True, group="restart", exit_on_error=False)
    async def _do_restart(self) -> None:
        assert self.discussion is not None
        try:
            discussion = await self.api.restart(str(self.discussion["id"]))
        except NodusAPIError as exc:
            self.notify(str(exc), severity="error")
            return
        self.discussion = discussion
        self._render_chat(discussion)
        self._render_graph(discussion.get("graph") or {})
        await self._refresh_executions()
        self._refresh_status()
        self._line("처음부터 다시 시작 — 기록과 지도를 지웠습니다.", style="bold green")

    async def _cmd_fork(self, arg: str) -> None:
        if self.discussion is None:
            return
        node_id: str | None = None
        if arg:
            graph = self.discussion.get("graph") or {}
            nodes = graph.get("nodes") or []
            matches = [str(n["id"]) for n in nodes if str(n["id"]).startswith(arg)]
            if not matches:
                self.notify(f"노드 '{arg}'를 찾지 못했습니다 (/graph 로 확인)", severity="error")
                return
            node_id = matches[0]
        try:
            child = await self.api.fork(str(self.discussion["id"]), node_id)
        except NodusAPIError as exc:
            self.notify(str(exc), severity="error")
            return
        self._line(f"가지 생성: {child.get('name')}", style="bold green")
        await self._refresh_project()
        try:
            await self._open_branch(str(child["id"]))
        except NodusAPIError:
            pass
        self._render_branches()

    async def _cmd_graph(self, _arg: str = "") -> None:
        if self.discussion is None:
            return
        try:
            graph = await self.api.graph(str(self.discussion["id"]))
        except NodusAPIError as exc:
            self.notify(str(exc), severity="error")
            return
        self._render_graph(graph)
        self.query_one("#side", TabbedContent).active = "tab-graph"
        nodes = graph.get("nodes") or []
        edges = graph.get("edges") or []
        self._line(f"지도: 노드 {len(nodes)}개 · 관계 {len(edges)}개 (오른쪽 '지도' 탭)", style="dim")
        for n in nodes[-12:]:
            self._line(
                f"- [{NODE_TYPE_LABEL.get(str(n.get('type')), str(n.get('type')))}] {n.get('label')} "
                f"({str(n.get('id'))[:12]})",
                style="dim",
            )
        if nodes:
            self._line("'/fork <id앞부분>' 으로 그 노드에서 갈라낼 수 있습니다.", style="dim")

    async def _cmd_ls(self, arg: str) -> None:
        path = arg
        if not path and self.project:
            path = str(self.project.get("project_path") or "")
        try:
            payload = await self.api.browse(path)
        except NodusAPIError as exc:
            self.notify(str(exc), severity="error")
            return
        current = str(payload.get("path") or "(루트)")
        self._line(f"폴더: {current} · 상위: {payload.get('parent') or '-'}", style="bold")
        dirs = payload.get("dirs") or []
        for d in dirs[:80]:
            self._line(f"  {d.get('path')}", style="dim")
        if not dirs:
            self._line("  (하위 폴더 없음)", style="dim")

    async def _cmd_run(self, arg: str) -> None:
        await self._run_code("run", arg)

    async def _cmd_test(self, arg: str) -> None:
        await self._run_code("test", arg)

    async def _run_code(self, kind: str, command: str) -> None:
        if self.discussion is None:
            self.notify("프로젝트를 먼저 여세요", severity="warning")
            return
        try:
            result = await self.api.run_code(str(self.discussion["id"]), kind, command or None)
        except NodusAPIError as exc:
            self.notify(str(exc), severity="error")
            return
        if result.get("status") == "already_running":
            self.notify("이미 실행 중입니다", severity="warning")
            return
        self.exec_running = True
        self._line(f"{'실행' if kind == 'run' else '테스트'} 시작" + (f": {command}" if command else " (자동 감지)"), style="green")
        self.query_one("#side", TabbedContent).active = "tab-exec"
        self._refresh_status()

    async def _cmd_exec(self, _arg: str = "") -> None:
        if self.discussion is None:
            return
        await self._refresh_executions()
        runs = sorted(self.executions.values(), key=lambda e: str(e.get("created_at") or ""), reverse=True)
        if not runs:
            self._line("실행 기록이 없습니다. /run 또는 /test 로 돌려보세요.", style="dim")
            return
        for e in runs[:10]:
            status = EXEC_STATUS_LABEL.get(str(e.get("status")), str(e.get("status")))
            self._line(
                f"[{status}] {e.get('kind_label')} · {e.get('command')} · "
                f"{int(e.get('duration_ms') or 0) / 1000:.1f}s · exit {e.get('exit_code') if e.get('exit_code') is not None else '-'}",
                style="dim",
            )
        self._line("행을 고르면 전체 출력이 채팅에 나옵니다.", style="dim")
        self.query_one("#side", TabbedContent).active = "tab-exec"

    async def _cmd_config(self, _arg: str = "") -> None:
        if self.project is None:
            return
        try:
            config = await self.api.execution_config(str(self.project["id"]))
        except NodusAPIError as exc:
            self.notify(str(exc), severity="error")
            return
        self.sandbox_info = config.get("sandbox") or {}
        sandbox = self.sandbox_info
        self._line(
            f"샌드박스: {'사용 가능' if sandbox.get('available') else '사용 불가'} · "
            f"이미지 {sandbox.get('image')} · 네트워크 {sandbox.get('network')} · "
            f"쓰기 {'허용' if sandbox.get('writable') else '읽기 전용'} · 제한 {sandbox.get('timeout_sec')}초",
            style="bold" if sandbox.get("available") else "yellow",
        )
        if not sandbox.get("available"):
            self._line(f"이유: {sandbox.get('detail') or 'Docker 없음'}", style="yellow")
        configured = config.get("configured") or {}
        self._line(
            f"지정된 명령 — 실행: {configured.get('run_command') or '(없음)'} · "
            f"테스트: {configured.get('test_command') or '(없음)'}",
            style="dim",
        )
        for d in config.get("detected") or []:
            self._line(f"감지: [{d.get('kind')}] {d.get('command')} — {d.get('reason')} ({d.get('confidence')})", style="dim")
        if not config.get("detected"):
            self._line("감지된 명령이 없습니다 (폴더 없음 또는 매니페스트 없음)", style="dim")

    async def _cmd_status(self, _arg: str = "") -> None:
        self._line(
            f"API {self.api.base_url} · {'온라인' if self.online else '오프라인'} · "
            f"LLM {'실제 모델' if self.llm_configured else 'mock'}",
            style="bold",
        )
        if self.project:
            self._line(f"프로젝트: {self.project.get('title')} ({self.project.get('id')}) · 폴더: {self.project.get('project_path') or '-'}", style="dim")
        if self.discussion:
            d = self.discussion
            self._line(
                f"가지: {d.get('name')} · {d.get('ai_turn_count')}/{d.get('max_turns') or '∞'}턴 · "
                f"AI {d.get('agent_count')}명 · 지도 주기 {d.get('graph_interval')} · 상태 {d.get('status')}",
                style="dim",
            )
            self._line(f"메시지 {len(d.get('messages') or [])}개 · 노드 {len((d.get('graph') or {}).get('nodes') or [])}개", style="dim")

    async def _cmd_api(self, arg: str) -> None:
        if not arg:
            self._line(f"현재 API 주소: {self.api.base_url}", style="dim")
            return
        self.api.set_base_url(arg)
        self._line(f"API 주소 변경: {self.api.base_url} — 다시 연결합니다.", style="bold")
        self._booted = False
        self.online = False
        self._connect()

    async def _cmd_save(self, arg: str) -> None:
        if self.discussion is None:
            return
        d = self.discussion
        name = str(d.get("name") or "branch").replace("/", "-").replace(" ", "_")
        target = Path(arg) if arg else Path.cwd() / f"nodus-{name}-{datetime.now():%Y%m%d-%H%M}.md"
        lines = [
            f"# {d.get('title')}",
            "",
            f"- 주제: {d.get('topic')}",
            f"- 가지: {d.get('name')} ({d.get('ai_turn_count')}턴)",
            f"- 저장: {datetime.now():%Y-%m-%d %H:%M}",
            "",
            "## 대화",
            "",
        ]
        for m in d.get("messages") or []:
            role = str(m.get("role"))
            speaker = str(m.get("agent_name") or ROLE_NAMES.get(role, role))
            turn = f" · {m.get('turn')}턴" if m.get("turn") else ""
            lines += [f"### {speaker}{turn}", "", str(m.get("content") or ""), ""]
        graph = d.get("graph") or {}
        nodes = graph.get("nodes") or []
        if nodes:
            lines += ["## 아이디어 지도", ""]
            for n in nodes:
                lines.append(
                    f"- [{NODE_TYPE_LABEL.get(str(n.get('type')), str(n.get('type')))}"
                    f"/{NODE_STATUS_LABEL.get(str(n.get('status')), str(n.get('status')))}] {n.get('label')}"
                )
            lines.append("")
        try:
            target.write_text("\n".join(lines), encoding="utf-8")
        except OSError as exc:
            self.notify(f"저장 실패: {exc}", severity="error")
            return
        self._line(f"저장했습니다: {target}", style="bold green")

    async def _cmd_clear(self, _arg: str = "") -> None:
        self.action_clear_chat()

    async def _cmd_quit(self, _arg: str = "") -> None:
        self.exit()

    # ── 키 액션 ────────────────────────────────────────────────────────────
    def action_help(self) -> None:
        self.run_worker(self._cmd_help(), exclusive=False)

    def action_start(self) -> None:
        self.run_worker(self._cmd_start(""), exclusive=False)

    def action_stop(self) -> None:
        self.run_worker(self._cmd_stop(), exclusive=False)

    def action_conclude(self) -> None:
        self.run_worker(self._cmd_conclude(), exclusive=False)

    def action_tab_graph(self) -> None:
        self.query_one("#side", TabbedContent).active = "tab-graph"

    def action_tab_exec(self) -> None:
        self.query_one("#side", TabbedContent).active = "tab-exec"

    def action_tab_branches(self) -> None:
        self.query_one("#side", TabbedContent).active = "tab-branches"

    def action_toggle_side(self) -> None:
        side = self.query_one("#side", TabbedContent)
        side.display = not side.display

    def action_clear_chat(self) -> None:
        self.query_one("#chat", VerticalScroll).remove_children()
        self._bubble_by_id = {}
        self._line("화면을 비웠습니다 (기록은 서버에 그대로 있습니다).", style="dim")

    # ── 표(table) 선택 ─────────────────────────────────────────────────────
    @on(DataTable.RowSelected, "#exec-table")
    def _exec_selected(self, event: DataTable.RowSelected) -> None:
        run = self.executions.get(str(event.row_key.value))
        if not run:
            return
        status = EXEC_STATUS_LABEL.get(str(run.get("status")), str(run.get("status")))
        self._line(
            f"[{status}] {run.get('command')} · 이미지 {run.get('image')} · "
            f"{int(run.get('duration_ms') or 0) / 1000:.1f}s · exit {run.get('exit_code')} · {run.get('requested_by')}",
            style="bold",
        )
        stdout = str(run.get("stdout") or "")
        stderr = str(run.get("stderr") or "")
        if stdout.strip():
            self._line("출력:\n" + stdout.strip()[:4000], style="")
        if stderr.strip():
            self._line("에러 출력:\n" + stderr.strip()[:2000], style="yellow")
        if not stdout.strip() and not stderr.strip():
            self._line("(출력 없음)", style="dim")

    @on(DataTable.RowSelected, "#branch-table")
    def _branch_selected(self, event: DataTable.RowSelected) -> None:
        branch_id = str(event.row_key.value)
        if self.discussion is not None and branch_id == str(self.discussion.get("id")):
            return
        self.run_worker(self._switch_branch(branch_id), exclusive=True, group="switch")
