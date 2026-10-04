"""Graph extraction via LLM structured output, with retry + repair."""

from __future__ import annotations

import json
import re

from app.graph.models import GRAPH_JSON_SCHEMA, GraphSnapshot
from app.llm.router import get_provider, model_for

SYSTEM = (
    "You are an idea-graph extractor. Read the debate and update the idea graph.\n"
    "Rules:\n"
    "- INCREMENTAL update: reuse existing node ids when a node still applies; only add genuinely new nodes.\n"
    "- Never delete: mark superseded ideas status='refined' or 'merged', rejected ones 'dropped'.\n"
    "- Node types: idea, question, objection, problem, decision, conclusion, evidence.\n"
    "- 'evidence' nodes are REAL sandbox run results already in the graph (labels starting with '실행 근거').\n"
    "  Never invent them and never delete them; when a claim is backed or broken by one, connect it\n"
    "  with a 'verifies' edge from the evidence node. If a run failed, still link it with 'verifies'\n"
    "  so the claim carries the counter-evidence.\n"
    "- Edge types: supports, contradicts, refines, derives_from, related_to, duplicates, verifies.\n"
    "- Keep labels short (<=12 Korean words). Max ~20 nodes, ~30 edges.\n"
    "- source_messages: list the message ids (e.g. 'msg_abc') each node came from.\n"
    "- Output ONLY the JSON object matching the schema."
)


def _parse_json(text: str) -> dict:
    text = (text or "").strip()
    try:
        return json.loads(text)
    except Exception:
        pass
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if m:
        return json.loads(m.group(0))
    raise ValueError("non-JSON graph output")


async def extract_snapshot(
    topic: str,
    new_messages: list[dict],
    existing_nodes: list[dict],
    existing_summary: str = "",
) -> GraphSnapshot:
    provider = get_provider()
    convo = "\n".join(
        f"[{m.get('agent_name', m.get('role', '?'))} | {m.get('id', '')}] {m.get('content', '')[:400]}"
        for m in new_messages[-30:]
    )
    exist = json.dumps(existing_nodes[-40:], ensure_ascii=False)[:6000]
    user_msgs = [
        {"role": "system", "content": SYSTEM},
        {
            "role": "user",
            "content": (
                f"Topic: {topic}\nExisting graph summary: {existing_summary[:800]}\n"
                f"Existing nodes (reuse ids!): {exist}\n\n"
                f"New messages since last snapshot:\n{convo}\n\nReturn the UPDATED full node/edge list as JSON."
            ),
        },
    ]
    last_err: Exception | None = None
    for attempt in range(3):
        try:
            if attempt < 2:
                raw = await provider.generate_structured(
                    user_msgs, model=model_for("graph"), schema=GRAPH_JSON_SCHEMA, temperature=0.3
                )
            else:  # final attempt: plain text + local repair parse
                text = await provider.generate(user_msgs, model=model_for("graph"), temperature=0.3)
                raw = _parse_json(text)
            return GraphSnapshot.model_validate(raw)
        except Exception as e:  # retry with a nudge
            last_err = e
            user_msgs.append(
                {
                    "role": "user",
                    "content": f"Your last output failed validation ({e}). Return ONLY valid JSON matching the schema.",
                }
            )
    raise RuntimeError(f"Graph extraction failed after retries: {last_err}")
