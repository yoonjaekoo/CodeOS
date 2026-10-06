"""Execution orchestration.

Picks a command (user-configured → auto-detected), runs it in the isolated
sandbox, then writes the result back into the debate three ways:

1. an `Execution` row (raw stdout/stderr for the UI),
2. a `role="execution"` message (so it sits in the conversation and every agent
   prompt from now on sees it),
3. an `evidence` node on the idea graph (so ideas can be linked to real proof).
"""

from __future__ import annotations

import asyncio

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.stream_bus import publish
from app.config import settings
from app.execution import detector, sandbox
from app.graph.manager import upsert_evidence
from app.models.branch import Branch
from app.models.execution import KIND_LABEL, STATUS_LABEL, Execution, execution_payload
from app.models.message import Message, message_payload
from app.models.project import Project

_MAX_COMMAND_CHARS = 512
_MESSAGE_OUTPUT_CHARS = 1500
_CONTEXT_OUTPUT_CHARS = 700

_locks: dict[str, asyncio.Lock] = {}
_running: set[str] = set()


def is_running(branch_id: str) -> bool:
    return branch_id in _running


def _lock(branch_id: str) -> asyncio.Lock:
    lock = _locks.get(branch_id)
    if lock is None:
        lock = asyncio.Lock()
        _locks[branch_id] = lock
    return lock


def clean_command(command: str | None) -> str:
    """Commands must be a single line; anything else is a mistake, not an intention."""
    text = (command or "").strip()
    if "\n" in text or "\r" in text:
        raise ValueError("실행 명령은 한 줄이어야 합니다")
    if len(text) > _MAX_COMMAND_CHARS:
        raise ValueError(f"실행 명령이 너무 깁니다 (최대 {_MAX_COMMAND_CHARS}자)")
    return text


def resolve_command(project: Project, kind: str, explicit: str | None = None) -> tuple[str, str, str]:
    """Return (command, image, reason). Raises ValueError when nothing is runnable."""
    if not project.project_path:
        raise ValueError("이 프로젝트에는 연결된 폴더가 없습니다. 폴더를 지정해야 코드를 실행할 수 있습니다")

    command = clean_command(explicit)
    if command:
        image = settings.sandbox_image or _image_for(project.project_path, kind)
        return command, image, "직접 지정한 명령"

    configured = clean_command(project.test_command if kind == "test" else project.run_command)
    if configured:
        image = settings.sandbox_image or _image_for(project.project_path, kind)
        return configured, image, "프로젝트에 저장된 명령"

    found = detector.detect_kind(project.project_path, kind)
    if found is None:
        raise ValueError(
            f"실행할 {KIND_LABEL.get(kind, kind)} 명령을 찾지 못했습니다. 실행 설정에서 직접 지정해 주세요"
        )
    return found.command, found.image, f"자동 감지 · {found.reason}"


def _image_for(project_path: str, kind: str) -> str:
    found = detector.detect_kind(project_path, kind) or next(
        (c for c in detector.detect(project_path)), None
    )
    return found.image if found else settings.sandbox_default_image


async def command_options(project: Project) -> dict:
    """Everything the UI/agents need to reason about running code here."""
    detected = detector.detect(project.project_path or "")
    info = await sandbox.sandbox_info()
    return {
        "project_path": project.project_path,
        "configured": {
            "run_command": project.run_command or "",
            "test_command": project.test_command or "",
        },
        "detected": [d.as_dict() for d in detected],
        "sandbox": info,
        "can_run": bool(project.project_path) and info["enabled"] and info["available"],
    }


def _describe(execution: Execution) -> str:
    status = STATUS_LABEL.get(execution.status, execution.status)
    parts = [f"{execution.command} → {status}"]
    if execution.exit_code is not None:
        parts.append(f"exit {execution.exit_code}")
    parts.append(f"{execution.duration_ms / 1000:.1f}초")
    return " · ".join(parts)


def render_message(execution: Execution) -> str:
    """The chat bubble / prompt text for a finished run."""
    lines = [
        f"[실행 결과] {KIND_LABEL.get(execution.kind, execution.kind)} · {_describe(execution)}"
    ]
    if execution.detail:
        lines.append(f"({execution.detail})")
    if execution.stdout.strip():
        lines += ["", "출력:", sandbox.clip(execution.stdout.strip(), _MESSAGE_OUTPUT_CHARS)]
    if execution.stderr.strip():
        lines += ["", "에러 출력:", sandbox.clip(execution.stderr.strip(), _MESSAGE_OUTPUT_CHARS)]
    if not execution.stdout.strip() and not execution.stderr.strip():
        lines += ["", "(출력 없음)"]
    return "\n".join(lines)


def render_context(executions: list[Execution]) -> str:
    """Block injected into every agent prompt so claims get checked against real output."""
    if not executions:
        return ""
    lines = [
        "[실행 결과 기록]",
        "아래는 이 프로젝트에서 실제로 돌려본 명령의 결과다. 상상이 아니라 사실이다.",
    ]
    for e in executions:
        lines.append(f"- ({e.created_at:%H:%M}) {_describe(e)}")
        body = (e.stdout or e.stderr or "").strip()
        if body:
            lines.append("  " + sandbox.clip(body, _CONTEXT_OUTPUT_CHARS).replace("\n", "\n  "))
        if e.detail:
            lines.append(f"  ({e.detail})")
    lines.append("[실행 결과 기록 끝]")
    return "\n".join(lines)


async def recent_executions(session: AsyncSession, branch_id: str, limit: int = 5) -> list[Execution]:
    rows = (
        await session.execute(
            select(Execution)
            .where(Execution.branch_id == branch_id)
            .order_by(Execution.created_at.desc())
            .limit(limit)
        )
    ).scalars().all()
    return list(reversed(rows))


async def run_for_branch(
    session: AsyncSession,
    branch: Branch,
    *,
    kind: str = "test",
    command: str | None = None,
    requested_by: str = "user",
) -> dict:
    """Run one command for a branch and mirror the result into chat + graph."""
    if kind not in ("run", "test"):
        kind = "custom"

    project = await session.get(Project, branch.project_id)
    if project is None:
        raise ValueError("프로젝트를 찾을 수 없습니다")

    resolved, image, reason = resolve_command(project, kind, command)

    async with _lock(branch.id):
        _running.add(branch.id)
        await publish(
            branch.id,
            "execution_start",
            {
                "kind": kind,
                "kind_label": KIND_LABEL.get(kind, kind),
                "command": resolved,
                "image": image,
                "requested_by": requested_by,
                "reason": reason,
            },
        )
        try:
            result = await sandbox.run(resolved, project_path=project.project_path or "", image=image)
        finally:
            _running.discard(branch.id)

        execution = Execution(
            project_id=project.id,
            branch_id=branch.id,
            kind=kind,
            command=resolved,
            image=result.image,
            status=result.status,
            exit_code=result.exit_code,
            stdout=result.stdout,
            stderr=result.stderr,
            truncated=result.truncated,
            timed_out=result.timed_out,
            duration_ms=result.duration_ms,
            requested_by=requested_by,
            detail=result.detail,
        )
        session.add(execution)
        await session.flush()

        message = Message(
            branch_id=branch.id,
            role="execution",
            agent_name="코드 실행",
            content=render_message(execution),
        )
        session.add(message)
        await session.flush()
        execution.message_id = message.id
        await session.commit()
        await session.refresh(execution)
        await session.refresh(message)

        # Snapshot the wire payload before the optional graph write: a rollback
        # would expire these rows and reading them afterwards would fail.
        payload = {
            "execution": execution_payload(execution),
            "message": message_payload(message),
        }

        # Evidence node is a bonus: a graph failure must never lose the run.
        try:
            graph = await upsert_evidence(
                session,
                branch.id,
                execution_id=execution.id,
                label=f"실행 근거: {STATUS_LABEL.get(result.status, result.status)} — {resolved[:60]}",
                description=(
                    f"{reason}\n{_describe(execution)}\n"
                    + sandbox.clip((result.stdout or result.stderr or "").strip(), 300)
                ),
                source_messages=[message.id],
            )
            await session.commit()
            payload["graph"] = graph
        except Exception:
            await session.rollback()

        await publish(branch.id, "execution_result", payload)
        return payload
