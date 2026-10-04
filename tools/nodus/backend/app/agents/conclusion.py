"""Conclusion: a two-pass write-up (analyze the whole debate, then answer) on user request only.

Pass 1 sorts the debate into 합의 / 반박됨 / 미해결 / 제안. Pass 2 writes the final text from that
analysis, so a summary can never quietly promote a rebutted claim or the last message into a result.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator

from app.llm.router import get_provider, model_for

ANALYSIS_SYSTEM = (
    "You are the moderator of a multi-AI brainstorm. BEFORE any summary is written, sort out what the "
    "debate actually settled and what it did not. Judge the WHOLE conversation, never just the last message. "
    "Every value in Korean.\n\n"
    "Return ONLY this JSON object:\n"
    "{\n"
    '  "question_answered": true | false,  // did the debate deliver a judgment on the ORIGINAL question?\n'
    '  "agreed": ["..."],      // claims said or supported more than once and never rebutted\n'
    '  "rebutted": ["..."],    // claims later messages contradicted or knocked down\n'
    '  "unresolved": ["..."],  // disagreements still open at the end\n'
    '  "proposals": ["..."],   // execution ideas someone suggested but nobody agreed on\n'
    '  "topic_shift": ["..."]  // times the debate tried to swap the original question for another criterion\n'
    "}\n\n"
    "Rules:\n"
    "- A claim mentioned once and never confirmed is NOT agreed.\n"
    "- A proposal nobody agreed on belongs in proposals, never in agreed.\n"
    "- A claim repeated over and over but rebutted every time belongs in rebutted, not agreed.\n"
    "- Lines starting with '[실행 결과]' are real sandbox run output, not opinions. A claim those runs "
    "contradict belongs in rebutted even if nobody argued against it.\n"
    "- Use an empty array when a category does not apply. Output no text outside the JSON."
)

ANALYSIS_SCHEMA: dict = {
    "type": "object",
    "properties": {
        "question_answered": {"type": "boolean"},
        "agreed": {"type": "array", "items": {"type": "string"}},
        "rebutted": {"type": "array", "items": {"type": "string"}},
        "unresolved": {"type": "array", "items": {"type": "string"}},
        "proposals": {"type": "array", "items": {"type": "string"}},
        "topic_shift": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["question_answered", "agreed", "rebutted", "unresolved", "proposals"],
}

CONCLUSION_SYSTEM = (
    "You are the moderator of a multi-AI brainstorm. Write the FINAL conclusion of the debate in Korean.\n"
    "You are given a factual analysis of the whole debate (합의 / 반박됨 / 미해결 / 제안). Build on it, but "
    "check it against the conversation yourself — the analysis can miss something.\n\n"
    "Rules:\n"
    "- Answer the ORIGINAL question directly. If the debate drifted to another question or another criterion, "
    "still answer the original one.\n"
    "- Only claims that were repeated or supported across the debate AND never rebutted may be written as a "
    "result. A claim the debate knocked down is not a result.\n"
    "- If the debate never judged the original question, do not force an answer: write that 명확한 결론에 "
    "도달하지 못했다 with the one-line reason.\n"
    "- Never let the last message decide. Speaking last or sounding persuasive is not agreement.\n"
    "- Proposals ('~하자' 류 아이디어) are 제안, not results. Write them as results only if the participants agreed.\n"
    "- Where claims collide, write '의견이 갈렸다' instead of picking a winner.\n"
    "- Lines starting with '[실행 결과]' are real sandbox run output. A claim the actual runs contradict is "
    "not a result, no matter who said it or how often.\n"
    "- Use ONLY what the conversation and the idea graph contain. Never add facts, numbers, analogies, or new arguments.\n"
    "- 담백한 평문으로 쓰세요. 마크다운 장식(**, #) 금지, 놀리거나 건방진 말투 금지.\n"
    "- Absolutely never: swap the original question for another criterion, present a rebutted claim as agreed, "
    "treat the last message as the debate's conclusion, mix proposals into results, or add what the debate never had.\n\n"
    "Output EXACTLY this shape, nothing before or after:\n"
    "결론\n"
    "<1-3 sentences. If nothing has been discussed yet, say so. If no judgment was reached, say 명확한 결론에 "
    "도달하지 못했다.>\n"
    "\n"
    "남은 쟁점\n"
    "- <2-4 items, or '없음'>\n"
    "\n"
    "제안 / 다음 행동\n"
    "- <2-4 items, or '없음'>\n"
)

_LIST_KEYS = ("agreed", "rebutted", "unresolved", "proposals", "topic_shift")


def _graph_lines(nodes: list[dict]) -> str:
    return "\n".join(
        f"- ({n.get('type', 'idea')}/{n.get('status', 'active')}) {n.get('label', '')}" for n in nodes[-40:]
    )


def _transcript(messages: list[str], limit: int = 40, width: int = 400) -> str:
    return "\n".join(f"- {m[:width]}" for m in messages[-limit:])


async def analyze_debate(
    topic: str, messages: list[str], graph_nodes: list[dict], project_context: str = ""
) -> dict:
    """Pass 1: what the whole debate settled vs left open. Returns {} if the model delivers nothing usable."""
    provider = get_provider()
    sys = ANALYSIS_SYSTEM
    if project_context:
        sys += f"\n\n{project_context[:4000]}"
    graph = _graph_lines(graph_nodes)
    prompt = [
        {"role": "system", "content": sys},
        {
            "role": "user",
            "content": (
                f"Original question of the debate: {topic}\n"
                + (f"Idea graph:\n{graph}\n" if graph else "")
                + f"Debate:\n{_transcript(messages)}"
            ),
        },
    ]
    try:
        raw = await provider.generate_structured(
            prompt, model=model_for("moderator"), schema=ANALYSIS_SCHEMA, temperature=0.2
        )
    except Exception:
        return {}
    if not isinstance(raw, dict) or not any(k in raw for k in ("question_answered", *_LIST_KEYS)):
        return {}
    out: dict = {"question_answered": bool(raw.get("question_answered"))}
    for key in _LIST_KEYS:
        value = raw.get(key) or []
        if not isinstance(value, list):
            value = [value]
        out[key] = [str(v)[:300] for v in value if str(v).strip()][:8]
    return out


async def stream_conclusion(
    topic: str, messages: list[str], graph_nodes: list[dict] | None = None, project_context: str = ""
) -> AsyncIterator[str]:
    """Pass 2: stream the final conclusion, grounded in the pass-1 analysis."""
    analysis = await analyze_debate(topic, messages, graph_nodes or [], project_context)
    provider = get_provider()
    sys = CONCLUSION_SYSTEM
    if project_context:
        sys += f"\n\n{project_context[:4000]}"
    graph = _graph_lines(graph_nodes or [])
    user = f"Original question of the debate: {topic}\n"
    if graph:
        user += f"Idea graph:\n{graph}\n"
    if analysis:
        user += (
            "Moderator's analysis of the whole debate (합의 vs 미해결; follow it, but verify):\n"
            f"{json.dumps(analysis, ensure_ascii=False)}\n"
        )
    else:
        user += "No analysis block was produced: read the whole debate yourself and separate 합의/반박됨/미해결/제안 before writing.\n"
    user += f"Debate:\n{_transcript(messages)}"
    prompt = [{"role": "system", "content": sys}, {"role": "user", "content": user}]
    async for tok in provider.stream(prompt, model=model_for("moderator"), role="conclusion", temperature=0.3):
        yield tok
