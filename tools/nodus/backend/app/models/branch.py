from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.project import utcnow, new_id


class Branch(Base):
    """A discussion branch. Root branch has parent_branch_id=None."""

    __tablename__ = "branches"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("br_"))
    project_id: Mapped[str] = mapped_column(String(64), ForeignKey("projects.id"), index=True)
    parent_branch_id: Mapped[str | None] = mapped_column(String(64), ForeignKey("branches.id"), nullable=True, default=None)
    fork_node_id: Mapped[str | None] = mapped_column(String(128), nullable=True, default=None)
    # The parent-branch node id this branch was forked from (stable for parent->child mapping)
    fork_source_node_id: Mapped[str | None] = mapped_column(String(128), nullable=True, default=None)
    fork_turn: Mapped[int] = mapped_column(Integer, default=0)
    name: Mapped[str] = mapped_column(String(255), default="메인")
    # Discussion settings live on each branch (inherited on fork)
    agent_count: Mapped[int] = mapped_column(Integer, default=3)
    graph_interval: Mapped[int] = mapped_column(Integer, default=10)
    max_turns: Mapped[int] = mapped_column(Integer, default=50)  # -1 == unlimited (capped internally)
    ai_turn_count: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(32), default="idle")  # idle | running | stopped | error
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
