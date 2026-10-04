"""Nodus 백엔드 REST/SSE 클라이언트.

토론·아이디어 지도·분기·코드 실행은 전부 백엔드(FastAPI)가 돌린다.
TUI는 HTTP로 명령을 보내고, SSE로 진행 상황을 받아 화면에 그린다.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

import httpx

# SSE 스트림은 25초마다 하트비트가 온다. 읽기 타임아웃을 그보다 넉넉히 두면
# 죽은 연결을 알아서 끊고 재연결할 수 있다.
_STREAM_TIMEOUT = httpx.Timeout(connect=10.0, read=70.0, write=10.0, pool=10.0)


class NodusAPIError(RuntimeError):
    """백엔드가 오류를 돌려주거나 연결에 실패했을 때."""


class NodusAPI:
    """Nodus 백엔드 HTTP 클라이언트 (async)."""

    def __init__(self, base_url: str = "http://localhost:8000") -> None:
        self.base_url = base_url.rstrip("/")
        self._client = httpx.AsyncClient(
            base_url=self.base_url,
            timeout=httpx.Timeout(60.0, connect=10.0),
            headers={"Content-Type": "application/json"},
        )

    def set_base_url(self, url: str) -> None:
        self.base_url = url.rstrip("/")
        self._client.base_url = self.base_url

    async def close(self) -> None:
        await self._client.aclose()

    # ── 공통 ───────────────────────────────────────────────────────────────
    async def _request(self, method: str, path: str, **kw: Any) -> Any:
        try:
            resp = await self._client.request(method, path, **kw)
        except httpx.HTTPError as exc:
            raise NodusAPIError(f"백엔드에 연결할 수 없습니다: {exc}") from exc
        if resp.status_code >= 400:
            raise NodusAPIError(f"{resp.status_code} {resp.reason_phrase} — {resp.text[:300]}")
        if not resp.content:
            return {}
        try:
            return resp.json()
        except ValueError:
            return {}

    # ── 헬스 ───────────────────────────────────────────────────────────────
    async def health(self) -> dict:
        return await self._request("GET", "/api/health")

    # ── 프로젝트 ───────────────────────────────────────────────────────────
    async def list_projects(self) -> list[dict]:
        return await self._request("GET", "/api/projects")

    async def get_project(self, project_id: str) -> dict:
        return await self._request("GET", f"/api/projects/{project_id}")

    async def create_project(
        self,
        *,
        title: str,
        topic: str,
        agent_count: int = 3,
        graph_interval: int = 10,
        max_turns: int = 50,
        project_path: str | None = None,
    ) -> dict:
        body: dict[str, Any] = {
            "title": title,
            "topic": topic,
            "agent_count": agent_count,
            "graph_interval": graph_interval,
            "max_turns": max_turns,
        }
        if project_path:
            body["project_path"] = project_path
        return await self._request("POST", "/api/projects", json=body)

    async def delete_project(self, project_id: str) -> dict:
        return await self._request("DELETE", f"/api/projects/{project_id}")

    async def analyze(self, project_id: str) -> dict:
        return await self._request("POST", f"/api/projects/{project_id}/analyze")

    async def get_context(self, project_id: str) -> dict:
        return await self._request("GET", f"/api/projects/{project_id}/context")

    # ── 폴더 브라우저 ──────────────────────────────────────────────────────
    async def drives(self) -> dict:
        return await self._request("GET", "/api/fs/drives")

    async def browse(self, path: str = "") -> dict:
        return await self._request("GET", "/api/fs/browse", params={"path": path})

    async def validate_dir(self, path: str) -> dict:
        return await self._request("POST", "/api/fs/validate", json={"path": path})

    # ── 토론(가지) ─────────────────────────────────────────────────────────
    async def get_discussion(self, branch_id: str) -> dict:
        return await self._request("GET", f"/api/discussions/{branch_id}")

    async def start(self, branch_id: str, turns: int) -> dict:
        return await self._request("POST", f"/api/discussions/{branch_id}/start", json={"turns": turns})

    async def stop(self, branch_id: str) -> dict:
        return await self._request("POST", f"/api/discussions/{branch_id}/stop")

    async def conclude(self, branch_id: str) -> dict:
        return await self._request("POST", f"/api/discussions/{branch_id}/conclude")

    async def restart(self, branch_id: str) -> dict:
        return await self._request("POST", f"/api/discussions/{branch_id}/restart")

    async def post_message(self, branch_id: str, content: str) -> dict:
        return await self._request("POST", f"/api/discussions/{branch_id}/message", json={"content": content})

    async def fork(self, branch_id: str, fork_node_id: str | None = None, name: str | None = None) -> dict:
        body: dict[str, Any] = {"fork_node_id": fork_node_id}
        if name:
            body["name"] = name
        return await self._request("POST", f"/api/discussions/{branch_id}/branches", json=body)

    async def graph(self, branch_id: str) -> dict:
        return await self._request("GET", f"/api/discussions/{branch_id}/graph")

    # ── 코드 실행 (샌드박스) ───────────────────────────────────────────────
    async def executions(self, branch_id: str) -> dict:
        return await self._request("GET", f"/api/discussions/{branch_id}/executions")

    async def run_code(self, branch_id: str, kind: str, command: str | None = None) -> dict:
        body: dict[str, Any] = {"kind": kind}
        if command:
            body["command"] = command
        return await self._request("POST", f"/api/discussions/{branch_id}/run", json=body)

    async def execution_config(self, project_id: str) -> dict:
        return await self._request("GET", f"/api/projects/{project_id}/execution")

    async def update_execution_config(
        self, project_id: str, *, run_command: str, test_command: str
    ) -> dict:
        return await self._request(
            "PUT",
            f"/api/projects/{project_id}/execution",
            json={"run_command": run_command, "test_command": test_command},
        )

    # ── SSE ────────────────────────────────────────────────────────────────
    async def stream(self, branch_id: str) -> AsyncIterator[tuple[str, dict]]:
        """토론 이벤트 스트림. (event, data) 튜플을 순서대로 낸다."""
        try:
            async with self._client.stream(
                "GET", f"/api/discussions/{branch_id}/stream", timeout=_STREAM_TIMEOUT
            ) as resp:
                if resp.status_code >= 400:
                    body = (await resp.aread())[:300].decode("utf-8", "replace")
                    raise NodusAPIError(f"{resp.status_code} — {body}")
                event: str | None = None
                async for line in resp.aiter_lines():
                    if line.startswith("event:"):
                        event = line[6:].strip()
                    elif line.startswith("data:") and event:
                        try:
                            data = json.loads(line[5:].strip())
                        except ValueError:
                            continue
                        yield event, data if isinstance(data, dict) else {"value": data}
        except httpx.HTTPError as exc:
            raise NodusAPIError(f"스트림 오류: {exc}") from exc
