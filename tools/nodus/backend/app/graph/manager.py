"""Incremental graph persistence: merge snapshots, never wipe history."""

from __future__ import annotations

import json
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.graph.models import GraphSnapshot
from app.models.graph import GraphEdge, GraphNode


async def get_graph(session: AsyncSession, branch_id: str) -> dict:
    nodes = (await session.execute(select(GraphNode).where(GraphNode.branch_id == branch_id))).scalars().all()
    edges = (await session.execute(select(GraphEdge).where(GraphEdge.branch_id == branch_id))).scalars().all()
    return {
        "nodes": [
            {
                "id": n.id,
                "type": n.type,
                "label": n.label,
                "description": n.description,
                "status": n.status,
                "source_messages": json.loads(n.source_messages or "[]"),
            }
            for n in nodes
        ],
        "edges": [{"id": e.id, "source": e.source, "target": e.target, "type": e.type} for e in edges],
    }


async def merge_snapshot(session: AsyncSession, branch_id: str, snap: GraphSnapshot) -> dict:
    """Upsert nodes/edges from an LLM snapshot. Existing rows are updated, never deleted."""
    existing_nodes = {
        n.id: n
        for n in (await session.execute(select(GraphNode).where(GraphNode.branch_id == branch_id))).scalars().all()
    }
    by_label = {n.label.strip(): n for n in existing_nodes.values()}
    id_map: dict[str, str] = {}  # llm id -> db id

    for nd in snap.nodes:
        target = None
        if nd.id and nd.id in existing_nodes:
            target = existing_nodes[nd.id]
        elif nd.label.strip() in by_label:
            target = by_label[nd.label.strip()]
        if target is None:
            db_id = nd.id if nd.id and nd.id not in existing_nodes else f"node_{uuid.uuid4().hex[:10]}"
            target = GraphNode(
                id=db_id,
                branch_id=branch_id,
                type=nd.type,
                label=nd.label[:120],
                description=nd.description[:500],
                status=nd.status,
                source_messages=json.dumps(nd.source_messages, ensure_ascii=False),
            )
            session.add(target)
            existing_nodes[db_id] = target
            by_label[target.label.strip()] = target
        else:
            target.type = nd.type
            target.label = nd.label[:120]
            target.description = nd.description[:500]
            target.status = nd.status
            # union source messages
            try:
                old = set(json.loads(target.source_messages or "[]"))
            except Exception:
                old = set()
            target.source_messages = json.dumps(sorted(old | set(nd.source_messages)), ensure_ascii=False)
        if nd.id:
            id_map[nd.id] = target.id

    # Resolve edge endpoints through id_map (LLM may reference temp ids)
    existing_edges = {
        (e.source, e.target, e.type): e
        for e in (await session.execute(select(GraphEdge).where(GraphEdge.branch_id == branch_id))).scalars().all()
    }
    valid_ids = set(existing_nodes.keys())
    for ed in snap.edges:
        src = id_map.get(ed.source, ed.source)
        tgt = id_map.get(ed.target, ed.target)
        # LLM sometimes emits label-based refs ("node_1" style is fine; labels are not)
        if src not in valid_ids or tgt not in valid_ids or src == tgt:
            continue
        key = (src, tgt, ed.type)
        if key not in existing_edges:
            row = GraphEdge(
                id=ed.id or f"edge_{uuid.uuid4().hex[:10]}",
                branch_id=branch_id,
                source=src,
                target=tgt,
                type=ed.type,
            )
            session.add(row)
            existing_edges[key] = row
    await session.flush()
    return await get_graph(session, branch_id)


async def upsert_conclusion(
    session: AsyncSession, branch_id: str, description: str, source_messages: list[str]
) -> dict:
    """Pin/refresh the branch's conclusion node (stable id), then return the full graph."""
    node_id = f"node_conclusion_{branch_id}"
    node = await session.get(GraphNode, node_id)
    sources = json.dumps(source_messages, ensure_ascii=False)
    if node is None:
        session.add(
            GraphNode(
                id=node_id,
                branch_id=branch_id,
                type="conclusion",
                label="토론 결론",
                description=description[:500],
                status="active",
                source_messages=sources,
            )
        )
    else:
        node.type = "conclusion"
        node.description = description[:500]
        node.status = "active"
        node.source_messages = sources
    await session.flush()
    return await get_graph(session, branch_id)


async def upsert_evidence(
    session: AsyncSession,
    branch_id: str,
    *,
    execution_id: str,
    label: str,
    description: str,
    source_messages: list[str],
) -> dict:
    """Record a sandbox run as an `evidence` node (stable id per execution)."""
    node_id = f"node_ev_{execution_id}"
    node = await session.get(GraphNode, node_id)
    sources = json.dumps(source_messages, ensure_ascii=False)
    if node is None:
        session.add(
            GraphNode(
                id=node_id,
                branch_id=branch_id,
                type="evidence",
                label=label[:120],
                description=description[:500],
                status="active",
                source_messages=sources,
            )
        )
    else:
        node.type = "evidence"
        node.label = label[:120]
        node.description = description[:500]
        node.status = "active"
        node.source_messages = sources
    await session.flush()
    return await get_graph(session, branch_id)


async def clone_graph(session: AsyncSession, from_branch: str, to_branch: str) -> dict[str, str]:
    """Copy graph to a new branch with fresh ids (PK is global). Returns old->new id map."""
    nodes = (await session.execute(select(GraphNode).where(GraphNode.branch_id == from_branch))).scalars().all()
    edges = (await session.execute(select(GraphEdge).where(GraphEdge.branch_id == from_branch))).scalars().all()
    id_map: dict[str, str] = {}
    for n in nodes:
        new_id = f"node_{uuid.uuid4().hex[:10]}"
        id_map[n.id] = new_id
        session.add(
            GraphNode(
                id=new_id,
                branch_id=to_branch,
                type=n.type,
                label=n.label,
                description=n.description,
                status=n.status,
                source_messages=n.source_messages,
            )
        )
    for e in edges:
        session.add(
            GraphEdge(
                id=f"edge_{uuid.uuid4().hex[:10]}",
                branch_id=to_branch,
                source=id_map.get(e.source, e.source),
                target=id_map.get(e.target, e.target),
                type=e.type,
            )
        )
    await session.flush()
    return id_map
