"""Project CRUD + root branch creation."""

from __future__ import annotations

import asyncio
import os
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.graph.manager import get_graph
from app.models.branch import Branch
from app.models.message import Message
from app.models.project import Project
from app.project import context as project_context_svc
from app.project import progress

router = APIRouter(prefix="/api/projects", tags=["projects"])


class ProjectCreate(BaseModel):
    title: str = Field(min_length=1, max_length=255)
    topic: str = Field(min_length=1)
    agent_count: int = Field(default=3, ge=2, le=5)
    graph_interval: int = Field(default=10, ge=1, le=100)
    max_turns: int = Field(default=50, ge=-1)  # -1 == unlimited
    project_path: str | None = Field(default=None, max_length=1024)


def _iso(dt: datetime | None) -> str:
    if dt is None:
        return ""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat()


@router.post("")
async def create_project(body: ProjectCreate, db: AsyncSession = Depends(get_db)):
    path = os.path.expanduser((body.project_path or "").strip().strip('"')) or None
    if path and not os.path.isdir(path):
        raise HTTPException(400, "프로젝트 폴더 경로가 존재하지 않습니다")
    project = Project(title=body.title.strip(), topic=body.topic.strip(), project_path=path)
    if path:
        project.context_status = "analyzing"
    db.add(project)
    await db.flush()
    root = Branch(
        project_id=project.id,
        parent_branch_id=None,
        name="메인",
        agent_count=body.agent_count,
        graph_interval=body.graph_interval,
        max_turns=body.max_turns,
    )
    db.add(root)
    await db.commit()
    await db.refresh(project)
    await db.refresh(root)
    if path:
        asyncio.create_task(project_context_svc.run_and_store(project.id))
    return {
        "id": project.id,
        "title": project.title,
        "topic": project.topic,
        "created_at": _iso(project.created_at),
        "updated_at": _iso(project.updated_at),
        "root_branch_id": root.id,
        "project_path": project.project_path,
        "context_status": project.context_status,
    }


@router.get("")
async def list_projects(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(select(Project).order_by(Project.created_at.desc()))).scalars().all()
    return [
        {
            "id": p.id,
            "title": p.title,
            "topic": p.topic,
            "created_at": _iso(p.created_at),
            "updated_at": _iso(p.updated_at),
        }
        for p in rows
    ]


@router.get("/{project_id}")
async def get_project(project_id: str, db: AsyncSession = Depends(get_db)):
    project = await db.get(Project, project_id)
    if project is None:
        raise HTTPException(404, "프로젝트를 찾을 수 없습니다")
    branches = (
        await db.execute(select(Branch).where(Branch.project_id == project_id).order_by(Branch.created_at))
    ).scalars().all()
    out_branches = []
    for b in branches:
        msg_count = (
            await db.execute(select(func.count()).select_from(Message).where(Message.branch_id == b.id))
        ).scalar() or 0
        graph = await get_graph(db, b.id)
        out_branches.append(
            {
                "id": b.id,
                "name": b.name,
                "parent_branch_id": b.parent_branch_id,
                "fork_node_id": b.fork_node_id,
                "fork_source_node_id": b.fork_source_node_id,
                "fork_turn": b.fork_turn,
                "agent_count": b.agent_count,
                "graph_interval": b.graph_interval,
                "max_turns": b.max_turns,
                "ai_turn_count": b.ai_turn_count,
                "status": b.status,
                "message_count": msg_count,
                "node_count": len(graph["nodes"]),
                "created_at": _iso(b.created_at),
            }
        )
    return {
        "id": project.id,
        "title": project.title,
        "topic": project.topic,
        "created_at": _iso(project.created_at),
        "updated_at": _iso(project.updated_at),
        "branches": out_branches,
        "project_path": project.project_path,
        "context_status": project.context_status,
        "context_summary": project_context_svc.stored_summary(project),
        "is_analyzing": progress.is_running(project_id),
        "analysis": progress.snapshot(project_id),
    }


@router.post("/{project_id}/analyze")
async def analyze_project_endpoint(project_id: str, db: AsyncSession = Depends(get_db)):
    """(Re)run the Project Analyzer once for this project."""
    project = await db.get(Project, project_id)
    if project is None:
        raise HTTPException(404, "프로젝트를 찾을 수 없습니다")
    if not project.project_path:
        raise HTTPException(400, "이 프로젝트에는 연결된 폴더가 없습니다")
    if progress.is_running(project_id):
        return {"status": "already_analyzing"}
    project.context_status = "analyzing"
    await db.commit()
    asyncio.create_task(project_context_svc.run_and_store(project_id))
    return {"status": "started"}


@router.get("/{project_id}/context")
async def get_project_context(project_id: str, db: AsyncSession = Depends(get_db)):
    project = await db.get(Project, project_id)
    if project is None:
        raise HTTPException(404, "프로젝트를 찾을 수 없습니다")
    return {
        "status": project.context_status,
        "project_path": project.project_path,
        "context": project_context_svc.context_json(project),
        "progress": progress.snapshot(project_id),
    }


@router.get("/{project_id}/files")
async def read_project_file(project_id: str, path: str, db: AsyncSession = Depends(get_db)):
    """On-demand single file read (redacted). Structure for future agent tool use."""
    project = await db.get(Project, project_id)
    if project is None:
        raise HTTPException(404, "프로젝트를 찾을 수 없습니다")
    try:
        content = await project_context_svc.read_project_file(project, path)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"path": path, "content": content}


@router.delete("/{project_id}")
async def delete_project(project_id: str, db: AsyncSession = Depends(get_db)):
    from app.models.execution import Execution
    from app.models.graph import GraphEdge, GraphNode

    project = await db.get(Project, project_id)
    if project is None:
        raise HTTPException(404, "프로젝트를 찾을 수 없습니다")
    branch_ids = [
        b.id for b in (await db.execute(select(Branch).where(Branch.project_id == project_id))).scalars().all()
    ]
    await db.execute(delete(Execution).where(Execution.project_id == project_id))
    if branch_ids:
        await db.execute(delete(Message).where(Message.branch_id.in_(branch_ids)))
        await db.execute(delete(GraphNode).where(GraphNode.branch_id.in_(branch_ids)))
        await db.execute(delete(GraphEdge).where(GraphEdge.branch_id.in_(branch_ids)))
        await db.execute(delete(Branch).where(Branch.project_id == project_id))
    await db.delete(project)
    await db.commit()
    return {"status": "deleted"}


@router.post("/{project_id}/discussions")
async def create_discussion(project_id: str, db: AsyncSession = Depends(get_db)):
    """Create an extra root-level discussion branch (rarely needed; root exists already)."""
    project = await db.get(Project, project_id)
    if project is None:
        raise HTTPException(404, "프로젝트를 찾을 수 없습니다")
    root = (
        await db.execute(
            select(Branch).where(Branch.project_id == project_id, Branch.parent_branch_id.is_(None))
        )
    ).scalars().first()
    if root is None:
        raise HTTPException(500, "프로젝트에 루트 토론이 없습니다")
    branch = Branch(
        project_id=project_id,
        parent_branch_id=None,
        name="메인",
        agent_count=root.agent_count,
        graph_interval=root.graph_interval,
        max_turns=root.max_turns,
    )
    db.add(branch)
    await db.commit()
    await db.refresh(branch)
    return {"id": branch.id, "project_id": project_id}
