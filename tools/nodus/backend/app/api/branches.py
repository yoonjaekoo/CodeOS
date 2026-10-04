"""Branch detail endpoint (spec: GET /api/branches/{id})."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.discussions import _discussion_payload
from app.database import get_db
from app.models.branch import Branch

router = APIRouter(prefix="/api/branches", tags=["branches"])


@router.get("/{branch_id}")
async def get_branch(branch_id: str, db: AsyncSession = Depends(get_db)):
    branch = await db.get(Branch, branch_id)
    if branch is None:
        raise HTTPException(404, "분기를 찾을 수 없습니다")
    return await _discussion_payload(db, branch)
