"""Branch lifecycle: fork-from-node with inherited context + graph state, and empty resets."""

from __future__ import annotations

import json

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.graph.manager import clone_graph
from app.models.branch import Branch
from app.models.execution import Execution
from app.models.graph import GraphEdge, GraphNode
from app.models.message import Message


async def create_fork(
    session: AsyncSession,
    parent: Branch,
    fork_node_id: str | None,
    name: str | None = None,
) -> tuple[Branch, dict[str, str]]:
    """Create a child branch inheriting context/graph up to the fork point.

    Returns (child, node_id_map). Never mutates the parent.
    """
    fork_turn = parent.ai_turn_count
    mapped_node_id: str | None = None
    node_map: dict[str, str] = {}

    if fork_node_id:
        node = (
            await session.execute(
                select(GraphNode).where(GraphNode.branch_id == parent.id, GraphNode.id == fork_node_id)
            )
        ).scalar_one_or_none()
        if node is None:
            raise ValueError("이 토론에서 분기 지점 아이디어를 찾을 수 없습니다")
        try:
            src_msgs: list[str] = json.loads(node.source_messages or "[]")
        except Exception:
            src_msgs = []
        if src_msgs:
            rows = (
                await session.execute(
                    select(Message.turn).where(Message.branch_id == parent.id, Message.id.in_(src_msgs))
                )
            ).all()
            turns = [r[0] for r in rows if r[0] is not None]
            if turns:
                fork_turn = max(turns)

    child = Branch(
        project_id=parent.project_id,
        parent_branch_id=parent.id,
        fork_node_id=fork_node_id,
        fork_source_node_id=fork_node_id,  # parent's node id, kept for parent->child lookup
        fork_turn=fork_turn,
        name=name or f"{fork_turn}번 발언에서 분기",
        agent_count=parent.agent_count,
        graph_interval=parent.graph_interval,
        max_turns=parent.max_turns,
        ai_turn_count=0,  # fresh counter for the new branch (messages carry fork lineage)
    )
    session.add(child)
    await session.flush()

    # 1) Copy conversation context: all parent messages up to fork_turn
    #    (user messages interleaved before that point are included by created order).
    parent_msgs = (
        await session.execute(select(Message).where(Message.branch_id == parent.id).order_by(Message.created_at))
    ).scalars().all()
    cutoff_id: str | None = None
    for m in parent_msgs:
        if m.role == "agent" and m.turn is not None and m.turn <= fork_turn:
            cutoff_id = m.id
    cutoff_at = next((x.created_at for x in parent_msgs if x.id == cutoff_id), None)
    copied = 0
    for m in parent_msgs:
        if cutoff_at is not None and m.created_at > cutoff_at:
            break
        session.add(
            Message(
                branch_id=child.id,
                role=m.role,
                agent_id=m.agent_id,
                agent_name=m.agent_name,
                content=m.content,
                turn=m.turn,
            )
        )
        copied += 1
        if m.id == cutoff_id:
            break
    # If nothing matched (fork at 0), still copy leading user messages
    if copied == 0:
        for m in parent_msgs:
            if m.role == "user":
                session.add(
                    Message(
                        branch_id=child.id,
                        role="user",
                        agent_id=None,
                        agent_name="You",
                        content=m.content,
                        turn=None,
                    )
                )
            else:
                break

    # 2) Copy graph state (fresh ids)
    node_map = await clone_graph(session, parent.id, child.id)
    if fork_node_id and fork_node_id in node_map:
        child.fork_node_id = node_map[fork_node_id]

    # 3) Child turn counter resumes after fork point so snapshot cadence continues
    child.ai_turn_count = fork_turn
    await session.flush()
    return child, node_map


async def reset_discussion(session: AsyncSession, branch: Branch) -> None:
    """Erase a branch's history — messages, idea graph, turn counter — so it restarts empty.

    The branch row itself (name, settings, id) is kept; callers own its status.
    """
    await session.execute(delete(Message).where(Message.branch_id == branch.id))
    await session.execute(delete(Execution).where(Execution.branch_id == branch.id))
    await session.execute(delete(GraphEdge).where(GraphEdge.branch_id == branch.id))
    await session.execute(delete(GraphNode).where(GraphNode.branch_id == branch.id))
    branch.ai_turn_count = 0
    await session.flush()


def build_context(
    topic: str,
    branch: Branch,
    messages: list[Message],
    graph_summary: str = "",
    open_questions: list[str] | None = None,
    project_context: str = "",
    max_messages: int = 30,
    execution_context: str = "",
    executions_available: bool = False,
) -> list[dict[str, str]]:
    """Assemble LLM context. Structured for future compression (summarize old tail)."""
    sys = ""
    if project_context:
        sys += (
            f"{project_context}\n\n"
            "위 프로젝트 맥락은 사용자의 실제 프로젝트를 분석한 결과다. "
            "모든 아이디어와 토론은 이 프로젝트의 구조·기술 스택·제약 안에서 현실적으로 유효해야 한다.\n\n"
        )
    sys += (
        f"토론 주제: {topic}\n"
        f"분기: {branch.name} ({branch.fork_turn}번 발언에서 갈라짐). "
        "분기 지점의 사고 흐름을 이어가고, 처음부터 다시 시작하지 마세요.\n"
    )
    if executions_available:
        sys += (
            "코드 실행: 이 프로젝트의 코드를 격리된 샌드박스에서 실제로 돌려볼 수 있다. "
            "실행으로 확인할 수 있는 주장을 하려면 발언 맨 끝에 자기 줄로 `@test` 또는 "
            "`@run <명령>`을 적어라. 결과는 [실행 결과]로 돌아온다.\n"
        )
    if execution_context:
        sys += f"\n{execution_context}\n"
    if graph_summary:
        sys += f"Current idea-graph summary: {graph_summary[:600]}\n"
    if open_questions:
        sys += "Open questions: " + "; ".join(open_questions[:5]) + "\n"
    out: list[dict[str, str]] = [{"role": "system", "content": sys}]
    tail = messages[-max_messages:]
    # MVP: full tail. (Future: summarize messages[:-max_messages] into sys.)
    for m in tail:
        if m.role == "user":
            out.append({"role": "user", "content": f"[User] {m.content}"})
        elif m.role == "moderator":
            out.append({"role": "user", "content": f"[Moderator note] {m.content}"})
        elif m.role == "execution":
            # Real sandbox output: observed fact, not something an agent said.
            out.append({"role": "user", "content": m.content})
        else:
            out.append({"role": "assistant", "content": f"[{m.agent_name}] {m.content}"})
    return out
