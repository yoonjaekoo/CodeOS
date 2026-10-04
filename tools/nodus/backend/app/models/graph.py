from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.project import utcnow, new_id


class GraphNode(Base):
    __tablename__ = "graph_nodes"

    id: Mapped[str] = mapped_column(String(128), primary_key=True, default=lambda: new_id("node_"))
    branch_id: Mapped[str] = mapped_column(String(64), ForeignKey("branches.id"), index=True)
    type: Mapped[str] = mapped_column(String(32), default="idea")
    label: Mapped[str] = mapped_column(String(512))
    description: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(32), default="active")
    source_messages: Mapped[str] = mapped_column(Text, default="[]")  # JSON list
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class GraphEdge(Base):
    __tablename__ = "graph_edges"

    id: Mapped[str] = mapped_column(String(128), primary_key=True, default=lambda: new_id("edge_"))
    branch_id: Mapped[str] = mapped_column(String(64), ForeignKey("branches.id"), index=True)
    source: Mapped[str] = mapped_column(String(128))
    target: Mapped[str] = mapped_column(String(128))
    type: Mapped[str] = mapped_column(String(32), default="related_to")
