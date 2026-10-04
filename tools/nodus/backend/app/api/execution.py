"""Sandboxed execution endpoints.

- project-level: what commands to run (configured + auto-detected) and sandbox status
- branch-level: kick off a run and read back what was run
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.stream_bus import publish
from app.database import get_db
from app.execution import manager as execution_service
from app.models.branch import Branch
from app.models.execution import Execution, execution_payload
from app.models.project import Project

router = APIRouter(tags=["execution"])


class ExecutionSettings(BaseModel):
    run_command: str | None = Field(default=None, max_length=1024)
    test_command: str | None = Field(default=None, max_length=1024)


class RunBody(BaseModel):
    kind: str = Field(default="test", pattern="^(run|test)$")
    command: str | None = Field(default=None, max_length=1024)


def _clean_optional(value: str | None) -> str | None:
    if value is None:
        return None
    try:
        text = execution_service.clean_command(value)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return text or None


@router.get("/api/projects/{project_id}/execution")
async def get_execution_settings(project_id: str, db: AsyncSession = Depends(get_db)):
    project = await db.get(Project, project_id)
    if project is None:
        raise HTTPException(404, "프로젝트를 찾을 수 없습니다")
    return await execution_service.command_options(project)


@router.put("/api/projects/{project_id}/execution")
async def update_execution_settings(
    project_id: str, body: ExecutionSettings, db: AsyncSession = Depends(get_db)
):
    """Store the user's own run/test commands. Empty string clears back to auto-detect."""
    project = await db.get(Project, project_id)
    if project is None:
        raise HTTPException(404, "프로젝트를 찾을 수 없습니다")
    project.run_command = _clean_optional(body.run_command)
    project.test_command = _clean_optional(body.test_command)
    await db.commit()
    await db.refresh(project)
    return await execution_service.command_options(project)


@router.get("/api/discussions/{branch_id}/executions")
async def list_executions(branch_id: str, db: AsyncSession = Depends(get_db)):
    branch = await db.get(Branch, branch_id)
    if branch is None:
        raise HTTPException(404, "토론을 찾을 수 없습니다")
    rows = (
        await db.execute(
            select(Execution)
            .where(Execution.branch_id == branch_id)
            .order_by(Execution.created_at.desc())
            .limit(20)
        )
    ).scalars().all()
    return {
        "is_running": execution_service.is_running(branch_id),
        "executions": [execution_payload(e, output_chars=2000) for e in rows],
    }


@router.post("/api/discussions/{branch_id}/run")
async def run_code(branch_id: str, body: RunBody, db: AsyncSession = Depends(get_db)):
    """Run the project's code in the sandbox. Progress arrives over SSE."""
    branch = await db.get(Branch, branch_id)
    if branch is None:
        raise HTTPException(404, "토론을 찾을 수 없습니다")
    if execution_service.is_running(branch_id):
        return {"status": "already_running"}
    project = await db.get(Project, branch.project_id)
    if project is None:
        raise HTTPException(404, "프로젝트를 찾을 수 없습니다")
    try:
        execution_service.resolve_command(project, body.kind, body.command)
    except ValueError as e:
        raise HTTPException(400, str(e))
    asyncio.create_task(_run_task(branch_id, body.kind, body.command, "user"))
    return {"status": "started"}


async def _run_task(branch_id: str, kind: str, command: str | None, requested_by: str) -> None:
    from app.database import SessionLocal

    async with SessionLocal() as session:
        branch = await session.get(Branch, branch_id)
        if branch is None:
            return
        try:
            await execution_service.run_for_branch(
                session, branch, kind=kind, command=command, requested_by=requested_by
            )
        except Exception as e:
            await session.rollback()
            await publish(branch_id, "error", {"message": f"코드 실행 실패: {e}"})
