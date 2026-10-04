"""Free-debate engine: scheduler picks speaker, LLM streams, turns tracked, snapshots on cadence."""

from __future__ import annotations

import asyncio
import random

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agents.base import agents_for_count, continuation_prompt, debate_system_prompt
from app.agents.conclusion import stream_conclusion
from app.agents.moderator import observe
from app.agents.scheduler import pick_next_agent
from app.api.stream_bus import publish
from app.branching.manager import build_context
from app.config import settings
from app.database import SessionLocal
from app.execution import manager as execution_service
from app.execution import sandbox
from app.execution.requests import extract_run_requests
from app.graph.extractor import extract_snapshot
from app.graph.manager import get_graph, merge_snapshot, upsert_conclusion
from app.llm.router import get_provider, model_for
from app.models.branch import Branch
from app.models.message import Message, message_payload
from app.models.project import Project, utcnow
from app.project.context import load_context_text

_running: set[str] = set()
# Branch ids where the user pressed "결론 내리기" while a debate was running:
# the running loop concludes as soon as the current turn finishes.
_conclude_requested: set[str] = set()
# Branch ids with a conclusion being written right now (restart must not race it).
_concluding: set[str] = set()


def is_running(branch_id: str) -> bool:
    return branch_id in _running


def is_concluding(branch_id: str) -> bool:
    return branch_id in _concluding


def request_conclusion(branch_id: str) -> None:
    _conclude_requested.add(branch_id)


def clear_conclusion_request(branch_id: str) -> None:
    """Drop a queued 결론 내리기 request (the branch was restarted before it could run)."""
    _conclude_requested.discard(branch_id)


async def run_discussion(branch_id: str, turns: int = 10) -> None:
    """Run up to `turns` AI turns on a branch. Safe to call as a background task."""
    if branch_id in _running:
        return
    _running.add(branch_id)
    try:
        await _run(branch_id, turns)
    finally:
        _running.discard(branch_id)
        # A pending request that never got to run must not fire on the next debate.
        _conclude_requested.discard(branch_id)


async def _run(branch_id: str, turns: int) -> None:
    async with SessionLocal() as session:
        branch = await session.get(Branch, branch_id)
        if branch is None:
            return
        project = await session.get(Project, branch.project_id)
        topic = project.topic if project else ""

        # Project Analyzer: session-start analysis (once). If a background analysis is
        # still in flight we wait briefly; never re-analyze per turn.
        if project and project.project_path and not project.project_context:
            for _ in range(6):
                if project.context_status == "analyzing":
                    await session.refresh(project)
                    await asyncio.sleep(5)
                else:
                    break
            if not project.project_context:
                await publish(branch_id, "error", {"message": "프로젝트 폴더 분석이 실패해 프로젝트 맥락 없이 진행합니다"})
        project_ctx_text = load_context_text(project) if project else ""

        # Can this branch actually run code? One probe per run, never per turn.
        exec_available = False
        if project and project.project_path and settings.sandbox_enabled:
            try:
                exec_available = await sandbox.available()
            except Exception:
                exec_available = False
        if project and project.project_path and not exec_available:
            await publish(
                branch_id,
                "error",
                {
                    "message": "샌드박스(Docker)를 쓸 수 없어 코드 실행 없이 토론합니다. "
                    "실행 결과 없이 진행되며, 실행을 요청한 발언은 무시됩니다."
                },
            )

        branch.status = "running"
        await session.commit()

        agents = agents_for_count(branch.agent_count)
        cap = settings.max_turns_safety_cap
        limit = branch.max_turns if branch.max_turns and branch.max_turns > 0 else cap
        remaining_total = max(limit - branch.ai_turn_count, 0)
        todo = max(min(turns, remaining_total, cap), 0)
        if todo == 0:
            branch.status = "idle"
            await session.commit()
            await publish(branch_id, "done", {"reason": "turn_limit_reached"})
            return

        concluded = False
        for _ in range(todo):
            # Re-check stop flag (user may pause by starting another run? keep simple: status check)
            await session.refresh(branch)
            if branch.status == "stopped":
                break
            recent_ids_rows = (
                await session.execute(
                    select(Message.agent_id)
                    .where(Message.branch_id == branch_id, Message.role == "agent")
                    .order_by(Message.created_at.desc())
                    .limit(5)
                )
            ).all()
            recent_ids = [r[0] for r in reversed(recent_ids_rows) if r[0]]
            agent = pick_next_agent(agents, recent_ids, random.Random())

            msgs = (
                await session.execute(
                    select(Message).where(Message.branch_id == branch_id).order_by(Message.created_at)
                )
            ).scalars().all()
            graph = await get_graph(session, branch_id)
            recent_execs = (
                await execution_service.recent_executions(session, branch_id) if exec_available else []
            )
            ctx = build_context(
                topic,
                branch,
                list(msgs),
                project_context=project_ctx_text,
                execution_context=execution_service.render_context(recent_execs),
                executions_available=exec_available,
            )
            # ctx[0] = topic/branch system; prepend persona system, keep conversation tail
            graph_line = "; ".join(n["label"] for n in graph["nodes"][-10:])
            ctx = [
                ctx[0],  # system: topic + fork context
                {
                    "role": "system",
                    "content": debate_system_prompt(agent, topic, execution_available=exec_available),
                },
                *ctx[1:],
                {
                    "role": "user",
                    "content": continuation_prompt(
                        agent, topic, graph_line, execution_available=exec_available
                    ),
                },
            ]

            await publish(branch_id, "agent_start", {"agent_id": agent.id, "agent_name": agent.name})
            provider = get_provider()
            chunks: list[str] = []
            try:
                async for tok in provider.stream(
                    ctx, model=model_for("debate"), persona=agent.tendency, turn_hint=branch.ai_turn_count + 1
                ):
                    chunks.append(tok)
                    await publish(branch_id, "token", {"agent_id": agent.id, "token": tok})
            except Exception as e:
                # Skip failed agent, keep debate alive
                await publish(branch_id, "error", {"message": f"{agent.name} 발언 실패, 건너뜁니다: {e}"})
                continue

            # Stop (or restart) pressed while this turn was streaming: drop it instead of persisting.
            await session.refresh(branch)
            if branch.status == "stopped":
                break

            content = "".join(chunks).strip()
            # Strip echoed "[name] ..." / "name: ..." prefixes copied from context format
            for _ in range(3):
                stripped = False
                if content.startswith("["):
                    end = content.find("]")
                    if 0 < end <= 30 and len(content) > end + 1:
                        content = content[end + 1 :].strip()
                        stripped = True
                for pref in (f"{agent.name}:", f"{agent.name} :"):
                    if content.startswith(pref):
                        content = content[len(pref) :].strip()
                        stripped = True
                if not stripped:
                    break

            # Agent-requested verification: `@test` / `@run <cmd>` on its own line.
            # The marker is a control token, never part of what the agent said.
            run_requests, content = extract_run_requests(content)
            if run_requests and not (exec_available and settings.sandbox_agent_commands):
                run_requests = []
                content = (content + "\n\n(실행 요청은 지금 쓸 수 없어 실행하지 않았습니다.)").strip()

            if not content:
                await publish(branch_id, "error", {"message": f"{agent.name} 빈 답변을 반환해 건너뜁니다"})
                continue

            branch.ai_turn_count += 1
            msg = Message(
                branch_id=branch_id,
                role="agent",
                agent_id=agent.id,
                agent_name=agent.name,
                content=content,
                turn=branch.ai_turn_count,
            )
            session.add(msg)
            await session.commit()
            await session.refresh(msg)
            await publish(
                branch_id,
                "agent_message",
                {
                    "id": msg.id,
                    "role": "agent",
                    "agent_id": agent.id,
                    "agent_name": agent.name,
                    "content": content,
                    "turn": msg.turn,
                    "created_at": msg.created_at.isoformat() if msg.created_at else "",
                },
            )
            await publish(
                branch_id, "turn_complete", {"turn": branch.ai_turn_count, "max_turns": branch.max_turns}
            )

            # Verify what the agent claimed, before the next agent speaks: the result
            # lands in the conversation as real evidence for the following turns.
            if run_requests:
                kind, cmd = run_requests[0]
                try:
                    await execution_service.run_for_branch(
                        session, branch, kind=kind, command=cmd, requested_by="agent"
                    )
                except Exception as e:
                    await session.rollback()
                    await publish(branch_id, "error", {"message": f"코드 실행을 건너뜁니다: {e}"})

            # Moderator (silent; publishes only on trigger)
            all_texts = [m.content for m in list(msgs) + [msg] if m.role in ("agent", "user", "conclusion")]
            try:
                alert = await observe(topic, all_texts, project_context=project_ctx_text)
                if alert:
                    mod = Message(
                        branch_id=branch_id, role="moderator", agent_name="진행 도우미", content=alert["message"]
                    )
                    session.add(mod)
                    await session.commit()
                    await publish(branch_id, "moderator_alert", alert)
            except Exception:
                try:
                    await session.rollback()
                except Exception:
                    pass

            # Graph snapshot on cadence (user-configured interval, never hardcoded)
            try:
                if branch.graph_interval > 0 and branch.ai_turn_count % branch.graph_interval == 0:
                    await publish(branch_id, "graph_snapshot_start", {"turn": branch.ai_turn_count})
                    since = (
                        await session.execute(
                            select(Message)
                            .where(Message.branch_id == branch_id)
                            .order_by(Message.created_at.desc())
                            .limit(branch.graph_interval * 2 + 5)
                        )
                    ).scalars().all()
                    ordered = list(reversed(since))
                    new_payload = [
                        {
                            "id": m.id,
                            "role": m.role,
                            "agent_name": m.agent_name,
                            "content": m.content,
                        }
                        for m in ordered
                    ]
                    snap = await extract_snapshot(topic, new_payload, graph["nodes"])
                    # Attach real message ids: map LLM-less refs by appending recent agent msg ids
                    recent_agent_ids = [m.id for m in ordered if m.role == "agent"][-branch.graph_interval :]
                    for nd in snap.nodes:
                        if not nd.source_messages:
                            nd.source_messages = recent_agent_ids[-2:]
                    updated = await merge_snapshot(session, branch_id, snap)
                    await session.commit()
                    await publish(
                        branch_id,
                        "graph_update",
                        {"turn": branch.ai_turn_count, "graph": updated, "summary": snap.summary},
                    )
            except Exception as e:
                await session.rollback()
                await publish(branch_id, "error", {"message": f"지도 갱신 실패 (토론은 계속됩니다): {e}"})

            # Conclusion: only an explicit user request ends a debate. Never automatic.
            if branch_id in _conclude_requested:
                _conclude_requested.discard(branch_id)
                try:
                    await _write_conclusion(session, branch_id, topic, project_ctx_text)
                except Exception as e:
                    await session.rollback()
                    await publish(branch_id, "error", {"message": f"결론 생성 중 오류: {e}"})
                concluded = True
                break

            await asyncio.sleep(0)

        branch.status = "idle"
        await session.commit()
        await publish(
            branch_id,
            "done",
            {"turn": branch.ai_turn_count, "reason": "concluded" if concluded else "turn_complete"},
        )


async def _write_conclusion(
    session: AsyncSession, branch_id: str, topic: str, project_ctx_text: str
) -> None:
    """Stream the moderator's conclusion, store it as a message, and pin it on the idea graph."""
    msgs = (
        await session.execute(select(Message).where(Message.branch_id == branch_id).order_by(Message.created_at))
    ).scalars().all()
    texts: list[str] = []
    for m in msgs:
        if m.role == "execution":
            texts.append(m.content)  # real run output: evidence, not an opinion
        elif m.role in ("agent", "user", "conclusion"):
            texts.append(f"{m.agent_name or '나'}: {m.content}")
    graph = await get_graph(session, branch_id)

    await publish(branch_id, "agent_start", {"agent_id": "conclusion", "agent_name": "결론"})
    chunks: list[str] = []
    try:
        async for tok in stream_conclusion(topic, texts, graph["nodes"], project_ctx_text):
            chunks.append(tok)
            await publish(branch_id, "token", {"agent_id": "conclusion", "token": tok})
    except Exception as e:
        await publish(branch_id, "error", {"message": f"결론 생성 실패: {e}"})
        return

    content = "".join(chunks).strip()
    if not content:
        await publish(branch_id, "error", {"message": "결론이 비어 있어 저장하지 않았습니다"})
        return

    # Re-concluding a branch refreshes the same message instead of stacking duplicates.
    conclusion = next((m for m in msgs if m.role == "conclusion"), None)
    if conclusion is None:
        conclusion = Message(branch_id=branch_id, role="conclusion", agent_name="결론", content=content)
        session.add(conclusion)
    else:
        conclusion.content = content
        conclusion.created_at = utcnow()  # keep the refreshed conclusion at the end of the chat
    await session.commit()
    await session.refresh(conclusion)

    updated: dict | None = None
    try:
        updated = await upsert_conclusion(session, branch_id, content, [conclusion.id])
        await session.commit()
    except Exception as e:
        await session.rollback()
        await publish(branch_id, "error", {"message": f"결론을 지도에 고정하지 못했습니다: {e}"})

    payload: dict = {"message": message_payload(conclusion)}
    if updated:
        payload["graph"] = updated
    await publish(branch_id, "conclusion", payload)


async def run_conclusion(branch_id: str) -> None:
    """Conclude a branch. If a debate is live, ask it to conclude when the current turn ends."""
    if branch_id in _running:
        request_conclusion(branch_id)
        return
    _running.add(branch_id)
    _concluding.add(branch_id)
    try:
        async with SessionLocal() as session:
            branch = await session.get(Branch, branch_id)
            if branch is None:
                return
            project = await session.get(Project, branch.project_id)
            topic = project.topic if project else ""
            branch.status = "running"
            await session.commit()
            turn = branch.ai_turn_count
            try:
                await _write_conclusion(
                    session, branch_id, topic, load_context_text(project) if project else ""
                )
            except Exception as e:
                await session.rollback()
                await publish(branch_id, "error", {"message": f"결론 생성 중 오류: {e}"})
            # The UI waits for `done`; never leave it hanging on a failed conclusion.
            branch.status = "idle"
            await session.commit()
            await publish(branch_id, "done", {"turn": turn, "reason": "concluded"})
    finally:
        _running.discard(branch_id)
        _concluding.discard(branch_id)
        _conclude_requested.discard(branch_id)
