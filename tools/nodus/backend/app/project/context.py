"""Project Context persistence + prompt-block helpers, plus a safe file reader
for on-demand re-reads (kept separate from the generated context on purpose)."""

from __future__ import annotations

import json

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.project import Project
from app.project.analyzer import analyze_project, render_context_text
from app.project.models import ProjectContext
from app.project import progress, scanner


async def run_and_store(project_id: str) -> ProjectContext | None:
    """Analyze the project folder once and persist the context on the Project row."""
    from app.database import SessionLocal

    async with SessionLocal() as session:
        project = await session.get(Project, project_id)
        if project is None or not project.project_path:
            return None
        progress.begin(project_id, project.project_path)
        try:
            ctx = await analyze_project(project.project_path, project_id)
            project.project_context = ctx.model_dump_json()
            project.context_status = "done"
            progress.finish(project_id, "done")
        except Exception as e:
            import logging

            logging.getLogger("nodus.analyzer").exception("project analysis failed for %s", project_id)
            project.context_status = "failed"
            progress.finish(project_id, "failed", f"{type(e).__name__}: {e}")
            await session.commit()
            return None
        await session.commit()
        await session.refresh(project)
        return ctx


def load_context_text(project: Project) -> str:
    """Render stored context for prompt injection (empty string if none)."""
    if not project.project_context:
        return ""
    try:
        return render_context_text(ProjectContext.model_validate_json(project.project_context))
    except Exception:
        return ""


def load_context(project: Project) -> ProjectContext | None:
    if not project.project_context:
        return None
    try:
        return ProjectContext.model_validate_json(project.project_context)
    except Exception:
        return None


def stored_summary(project: Project) -> str:
    ctx = load_context(project)
    return ctx.context_summary if ctx else ""


async def read_project_file(project: Project, rel_path: str, max_chars: int = 8000) -> str:
    """On-demand single file read. Sensitive/unsafe paths always refused."""
    if not project.project_path:
        raise ValueError("이 프로젝트에는 연결된 폴더가 없습니다")
    return scanner.read_file(project.project_path, rel_path, max_chars)


def context_json(project: Project) -> dict | None:
    if not project.project_context:
        return None
    try:
        return json.loads(project.project_context)
    except Exception:
        return None
