"""Async engine / session factory. Supports postgres (asyncpg) and sqlite (aiosqlite)."""

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.config import settings


class Base(DeclarativeBase):
    pass


connect_args = {}
if settings.database_url.startswith("sqlite"):
    connect_args = {"check_same_thread": False}

engine = create_async_engine(settings.database_url, echo=False, connect_args=connect_args)
SessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def get_db():
    async with SessionLocal() as session:
        yield session


async def init_db():
    # Import models so metadata is populated
    import app.models  # noqa: F401

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        # Lightweight auto-migration: add missing columns for SQLite dev DBs.
        await _ensure_columns(conn)


async def _ensure_columns(conn) -> None:
    from sqlalchemy import inspect, text

    def _sync(inspector):
        out = []
        if "branches" in inspector.get_table_names():
            cols = {c["name"] for c in inspector.get_columns("branches")}
            if "fork_source_node_id" not in cols:
                out.append("ALTER TABLE branches ADD COLUMN fork_source_node_id VARCHAR(128)")
        if "projects" in inspector.get_table_names():
            cols = {c["name"] for c in inspector.get_columns("projects")}
            if "project_path" not in cols:
                out.append("ALTER TABLE projects ADD COLUMN project_path VARCHAR(1024)")
            if "project_context" not in cols:
                out.append("ALTER TABLE projects ADD COLUMN project_context TEXT")
            if "context_status" not in cols:
                out.append("ALTER TABLE projects ADD COLUMN context_status VARCHAR(32) DEFAULT 'none'")
            if "run_command" not in cols:
                out.append("ALTER TABLE projects ADD COLUMN run_command VARCHAR(1024)")
            if "test_command" not in cols:
                out.append("ALTER TABLE projects ADD COLUMN test_command VARCHAR(1024)")
        return out

    stmts = await conn.run_sync(lambda c: _sync(inspect(c)))
    for s in stmts:
        await conn.execute(text(s))
