from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.project import utcnow, new_id


class Message(Base):
    __tablename__ = "messages"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("msg_"))
    branch_id: Mapped[str] = mapped_column(String(64), ForeignKey("branches.id"), index=True)
    role: Mapped[str] = mapped_column(String(32))  # agent | user | moderator | conclusion | execution
    agent_id: Mapped[str | None] = mapped_column(String(64), nullable=True, default=None)
    agent_name: Mapped[str | None] = mapped_column(String(64), nullable=True, default=None)
    content: Mapped[str] = mapped_column(Text)
    turn: Mapped[int | None] = mapped_column(Integer, nullable=True, default=None)  # AI turn number (None for user msgs)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


def message_payload(m: Message) -> dict:
    """Wire shape of a message (REST + SSE)."""
    return {
        "id": m.id,
        "role": m.role,
        "agent_id": m.agent_id,
        "agent_name": m.agent_name,
        "content": m.content,
        "turn": m.turn,
        "created_at": m.created_at.isoformat() if m.created_at else "",
    }
