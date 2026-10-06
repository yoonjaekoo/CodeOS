import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


def utcnow():
    return datetime.now(timezone.utc)


def new_id(prefix: str = "") -> str:
    return f"{prefix}{uuid.uuid4().hex[:12]}" if prefix else uuid.uuid4().hex


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("proj_"))
    title: Mapped[str] = mapped_column(String(255))
    topic: Mapped[str] = mapped_column(Text)
    # Project Analyzer: user-specified local folder + generated context (stored as JSON text)
    project_path: Mapped[str | None] = mapped_column(String(1024), nullable=True, default=None)
    project_context: Mapped[str | None] = mapped_column(Text, nullable=True, default=None)
    context_status: Mapped[str] = mapped_column(String(32), default="none")  # none|analyzing|done|failed
    # Sandboxed execution: user-specified commands. Empty = auto-detect from the folder.
    run_command: Mapped[str | None] = mapped_column(String(1024), nullable=True, default=None)
    test_command: Mapped[str | None] = mapped_column(String(1024), nullable=True, default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)
