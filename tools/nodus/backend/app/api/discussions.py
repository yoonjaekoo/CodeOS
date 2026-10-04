"""Discussion (= branch) endpoints: detail, start, user message, graph, fork."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agents.debate import (
    clear_conclusion_request,
    is_concluding,
    is_running,
    request_conclusion,
    run_conclusion,
    run_discussion,
)
from app.api.stream_bus import publish
from app.branching.manager import create_fork, reset_discussion
from app.database import get_db
from app.graph.manager import get_graph
from app.models.branch import Branch
from app.models.message import Message, message_payload
from app.models.project import Project

router = APIRouter(prefix="/api/discussions", tags=["discussions"])


class StartBody(BaseModel):
    turns: int = Field(default=10, ge=1, le=500)


class MessageBody(BaseModel):
    content: str = Field(min_length=1, max_length=4000)


class ForkBody(BaseModel):
    fork_node_id: str | None = None
    name: str | None = None


async def _discussion_payload(db: AsyncSession, branch: Branch) -> dict:
    project = await db.get(Project, branch.project_id)
    msgs = (
        await db.execute(select(Message).where(Message.branch_id == branch.id).order_by(Message.created_at))
    ).scalars().all()
    graph = await get_graph(db, branch.id)
    return {
        "id": branch.id,
        "project_id": branch.project_id,
        "topic": project.topic if project else "",
        "title": project.title if project else "",
        "name": branch.name,
        "parent_branch_id": branch.parent_branch_id,
        "fork_node_id": branch.fork_node_id,
        "fork_turn": branch.fork_turn,
        "agent_count": branch.agent_count,
        "graph_interval": branch.graph_interval,
        "max_turns": branch.max_turns,
        "ai_turn_count": branch.ai_turn_count,
        "status": branch.status,
        "is_running": is_running(branch.id),
        "messages": [message_payload(m) for m in msgs],
        "graph": graph,
    }


@router.get("/{branch_id}")
async def get_discussion(branch_id: str, db: AsyncSession = Depends(get_db)):
    branch = await db.get(Branch, branch_id)
    if branch is None:
        raise HTTPException(404, "토론을 찾을 수 없습니다")
    return await _discussion_payload(db, branch)


@router.post("/{branch_id}/start")
async def start_discussion(branch_id: str, body: StartBody, db: AsyncSession = Depends(get_db)):
    branch = await db.get(Branch, branch_id)
    if branch is None:
        raise HTTPException(404, "토론을 찾을 수 없습니다")
    if is_running(branch_id):
        return {"status": "already_running"}
    # Fire-and-forget background run; progress arrives via SSE
    asyncio.create_task(run_discussion(branch_id, body.turns))
    return {"status": "started", "turns": body.turns}


@router.post("/{branch_id}/stop")
async def stop_discussion(branch_id: str, db: AsyncSession = Depends(get_db)):
    branch = await db.get(Branch, branch_id)
    if branch is None:
        raise HTTPException(404, "토론을 찾을 수 없습니다")
    if is_running(branch_id):
        # Ask the runner loop to exit; it finalizes status=idle and emits "done".
        branch.status = "stopped"
        await db.commit()
        return {"status": "stopping"}
    branch.status = "idle"
    await db.commit()
    return {"status": "stopped"}


@router.post("/{branch_id}/message")
async def post_user_message(branch_id: str, body: MessageBody, db: AsyncSession = Depends(get_db)):
    branch = await db.get(Branch, branch_id)
    if branch is None:
        raise HTTPException(404, "토론을 찾을 수 없습니다")
    content = body.content.strip()
    if not content:
        raise HTTPException(400, "내용이 비어 있습니다")
    msg = Message(branch_id=branch_id, role="user", agent_name="나", content=content)
    db.add(msg)
    # Touch project updated_at
    project = await db.get(Project, branch.project_id)
    if project:
        from datetime import datetime, timezone

        project.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(msg)
    await publish(branch_id, "user_message", message_payload(msg))
    return message_payload(msg)


@router.post("/{branch_id}/conclude")
async def conclude_discussion(branch_id: str, db: AsyncSession = Depends(get_db)):
    """User-triggered conclusion. Concludes now (idle) or at the end of the current turn (running)."""
    branch = await db.get(Branch, branch_id)
    if branch is None:
        raise HTTPException(404, "토론을 찾을 수 없습니다")
    if is_running(branch_id):
        request_conclusion(branch_id)
        return {"status": "requested"}
    asyncio.create_task(run_conclusion(branch_id))
    return {"status": "started"}


@router.post("/{branch_id}/restart")
async def restart_discussion(branch_id: str, db: AsyncSession = Depends(get_db)):
    """Erase this discussion's history (messages + idea graph) and leave it empty for a fresh start."""
    branch = await db.get(Branch, branch_id)
    if branch is None:
        raise HTTPException(404, "토론을 찾을 수 없습니다")
    if is_concluding(branch_id):
        raise HTTPException(409, "결론을 작성하는 중입니다. 끝난 뒤에 다시 시도해 주세요")
    clear_conclusion_request(branch_id)
    if is_running(branch_id):
        # The loop drops the in-flight turn and exits; then this branch is empty.
        branch.status = "stopped"
    else:
        branch.status = "idle"
    await reset_discussion(db, branch)
    await db.commit()
    return await _discussion_payload(db, branch)


@router.get("/{branch_id}/graph")
async def get_discussion_graph(branch_id: str, db: AsyncSession = Depends(get_db)):
    branch = await db.get(Branch, branch_id)
    if branch is None:
        raise HTTPException(404, "토론을 찾을 수 없습니다")
    return await get_graph(db, branch_id)


@router.post("/{branch_id}/branches")
async def fork_branch(branch_id: str, body: ForkBody, db: AsyncSession = Depends(get_db)):
    parent = await db.get(Branch, branch_id)
    if parent is None:
        raise HTTPException(404, "토론을 찾을 수 없습니다")
    if is_running(branch_id):
        raise HTTPException(409, "분기하기 전에 원본 토론을 중지하세요")
    try:
        child, _ = await create_fork(db, parent, body.fork_node_id, body.name)
    except ValueError as e:
        raise HTTPException(404, str(e))
    await db.commit()
    await db.refresh(child)
    await publish(branch_id, "branch_created", {"branch_id": child.id, "fork_turn": child.fork_turn})
    payload = await _discussion_payload(db, child)
    return payload


@router.get("/{branch_id}/export")
async def export_discussion(branch_id: str, db: AsyncSession = Depends(get_db)):
    branch = await db.get(Branch, branch_id)
    if branch is None:
        raise HTTPException(404, "토론을 찾을 수 없습니다")
    return await _discussion_payload(db, branch)
