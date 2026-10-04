"""Silent moderator: observes, tracks state, intervenes only on trigger conditions."""

from __future__ import annotations

import re
from collections import Counter

from app.llm.router import get_provider, model_for


def heuristic_check(messages: list[str]) -> dict | None:
    """Cheap local checks for repetition / deadlock. Returns alert dict or None."""
    if len(messages) < 6:
        return None
    recent = messages[-6:]
    norm = [" ".join(m.split())[:120] for m in recent]
    counts = Counter(norm)
    if counts.most_common(1)[0][1] >= 3:
        return {
            "type": "repetition",
            "message": "비슷한 이야기가 반복되고 있어요. 관점을 바꾸거나, 특정 아이디어에서 분기해 보세요.",
        }
    # Deadlock: same two claims alternating (rough proxy: low lexical diversity)
    words: list[str] = []
    for m in recent:
        words += re.findall(r"[가-힣a-zA-Z]{2,}", m)
    if words:
        top_ratio = Counter(words).most_common(1)[0][1] / max(len(words), 1)
        if top_ratio > 0.25:
            return {
                "type": "deadlock",
                "message": "논의가 한 지점에서 맴돌고 있어요. 새로운 분기를 만들거나 사용자 의견을 입력해 보세요.",
            }
    return None


async def llm_check(topic: str, messages: list[str], project_context: str = "") -> dict | None:
    """Ask the moderator model for drift / critical-conflict / decision-point alerts."""
    if len(messages) < 8:
        return None
    provider = get_provider()
    convo = "\n".join(f"- {m[:300]}" for m in messages[-12:])
    sys = (
        "You are a silent debate moderator. Reply with exactly one line: "
        "'OK' if the debate is healthy, or 'ALERT: <short Korean message>' only when one of these holds: "
        "(a) drift far from topic, (b) critical logical conflict needing user call, "
        "(c) a decision only the user can make. No other output."
    )
    if project_context:
        sys += f"\n\n{project_context[:4000]}\nThe debate concerns the project above; judge drift against it."
    prompt = [
        {"role": "system", "content": sys},
        {"role": "user", "content": f"Topic: {topic}\nRecent messages:\n{convo}"},
    ]
    try:
        out = (await provider.generate(prompt, model=model_for("moderator"), temperature=0.2)).strip()
    except Exception:
        return None
    if out.startswith("ALERT:"):
        text = out[len("ALERT:") :].strip()
        kind = "drift" if "벗어" in text or "drift" in text.lower() else "user_decision"
        return {"type": kind, "message": text[:300]}
    return None


async def observe(topic: str, messages: list[str], project_context: str = "") -> dict | None:
    """Run cheap heuristics first, then (sparingly) the LLM moderator."""
    hit = heuristic_check(messages)
    if hit:
        return hit
    # LLM check at most every 20 messages to save cost
    if len(messages) % 20 == 0:
        return await llm_check(topic, messages, project_context)
    return None
