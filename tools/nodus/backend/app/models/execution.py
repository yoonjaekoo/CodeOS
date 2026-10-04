from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.project import new_id, utcnow


class Execution(Base):
    """One sandboxed command run.

    Stored separately from the chat so the raw stdout/stderr survives, and mirrored
    into the conversation as a `role="execution"` message plus a graph evidence node.
    """

    __tablename__ = "executions"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("exec_"))
    project_id: Mapped[str] = mapped_column(String(64), ForeignKey("projects.id"), index=True)
    branch_id: Mapped[str | None] = mapped_column(
        String(64), ForeignKey("branches.id"), nullable=True, index=True
    )
    kind: Mapped[str] = mapped_column(String(16), default="test")  # run | test | custom
    command: Mapped[str] = mapped_column(String(1024))
    image: Mapped[str] = mapped_column(String(255), default="")
    status: Mapped[str] = mapped_column(String(16), default="error")  # ok|failed|timeout|error|unavailable
    exit_code: Mapped[int | None] = mapped_column(Integer, nullable=True, default=None)
    stdout: Mapped[str] = mapped_column(Text, default="")
    stderr: Mapped[str] = mapped_column(Text, default="")
    truncated: Mapped[bool] = mapped_column(Boolean, default=False)
    timed_out: Mapped[bool] = mapped_column(Boolean, default=False)
    duration_ms: Mapped[int] = mapped_column(Integer, default=0)
    requested_by: Mapped[str] = mapped_column(String(16), default="user")  # user | agent
    message_id: Mapped[str | None] = mapped_column(String(64), nullable=True, default=None)
    detail: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


STATUS_LABEL: dict[str, str] = {
    "ok": "성공",
    "failed": "실패",
    "timeout": "시간 초과",
    "error": "오류",
    "unavailable": "실행 불가",
}

KIND_LABEL: dict[str, str] = {
    "test": "테스트",
    "run": "실행",
    "custom": "명령",
}


def execution_payload(e: Execution, output_chars: int = 4000) -> dict:
    """Wire shape for REST + SSE. Output is clipped for transport, not for storage."""
    return {
        "id": e.id,
        "project_id": e.project_id,
        "branch_id": e.branch_id,
        "kind": e.kind,
        "kind_label": KIND_LABEL.get(e.kind, e.kind),
        "command": e.command,
        "image": e.image,
        "status": e.status,
        "status_label": STATUS_LABEL.get(e.status, e.status),
        "exit_code": e.exit_code,
        "stdout": _clip(e.stdout, output_chars),
        "stderr": _clip(e.stderr, output_chars),
        "truncated": e.truncated,
        "timed_out": e.timed_out,
        "duration_ms": e.duration_ms,
        "requested_by": e.requested_by,
        "message_id": e.message_id,
        "detail": e.detail,
        "created_at": e.created_at.isoformat() if e.created_at else "",
    }


def _clip(text: str | None, limit: int) -> str:
    text = text or ""
    if len(text) <= limit:
        return text
    head = int(limit * 0.6)
    tail = limit - head
    return f"{text[:head]}\n… (중략 {len(text) - limit}자) …\n{text[-tail:]}"
