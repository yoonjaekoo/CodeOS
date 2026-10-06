"""Concrete LLM providers.

- OpenAICompatibleProvider: works with OpenAI, OpenRouter, Groq, Gemini
  (OpenAI-compatible endpoint), vLLM, Ollama, etc. via /chat/completions.
- MockProvider: deterministic offline fallback so the app (and Docker demo)
  runs without an API key. Debate still flows, graph still updates.
"""

from __future__ import annotations

import json
import random
import re
import uuid
from collections.abc import AsyncIterator
from typing import Any

import httpx

from app.llm.base import LLMProvider

# Stable session id for OpenCode Go routing (x-opencode-session); ignored by other providers.
_SESSION_ID = uuid.uuid4().hex


class OpenAICompatibleProvider(LLMProvider):
    def __init__(self, api_key: str, base_url: str, timeout_sec: float = 60.0):
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout_sec

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "x-opencode-session": _SESSION_ID,
            "User-Agent": "nodus/0.1",
        }

    async def generate(self, messages: list[dict[str, str]], model: str, **kwargs: Any) -> str:
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            resp = await client.post(
                f"{self.base_url}/chat/completions",
                headers=self._headers(),
                json={"model": model, "messages": messages, "temperature": kwargs.get("temperature", 0.8)},
            )
            resp.raise_for_status()
            data = resp.json()
            return data["choices"][0]["message"]["content"] or ""

    async def generate_structured(
        self, messages: list[dict[str, str]], model: str, schema: dict[str, Any], **kwargs: Any
    ) -> dict[str, Any]:
        """Use response_format json_schema when available; fall back to json_object + repair."""
        payload: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "temperature": kwargs.get("temperature", 0.3),
        }
        # Try strict json_schema first
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                resp = await client.post(
                    f"{self.base_url}/chat/completions",
                    headers=self._headers(),
                    json={
                        **payload,
                        "response_format": {
                            "type": "json_schema",
                            "json_schema": {"name": "graph_snapshot", "strict": False, "schema": schema},
                        },
                    },
                )
                resp.raise_for_status()
                content = resp.json()["choices"][0]["message"]["content"]
                return _parse_json(content)
        except Exception:
            pass
        # Fallback: plain JSON mode
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            resp = await client.post(
                f"{self.base_url}/chat/completions",
                headers=self._headers(),
                json={**payload, "response_format": {"type": "json_object"}},
            )
            resp.raise_for_status()
            content = resp.json()["choices"][0]["message"]["content"]
            return _parse_json(content)

    async def stream(self, messages: list[dict[str, str]], model: str, **kwargs: Any) -> AsyncIterator[str]:
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            async with client.stream(
                "POST",
                f"{self.base_url}/chat/completions",
                headers=self._headers(),
                json={
                    "model": model,
                    "messages": messages,
                    "temperature": kwargs.get("temperature", 0.8),
                    "stream": True,
                },
            ) as resp:
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    if not line or not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        chunk = json.loads(data)
                        delta = chunk["choices"][0].get("delta", {}).get("content")
                        if delta:
                            yield delta
                    except Exception:
                        continue


def _parse_json(content: str) -> dict[str, Any]:
    content = (content or "").strip()
    try:
        return json.loads(content)
    except Exception:
        pass
    # Repair: extract first {...} block (handles markdown fences)
    m = re.search(r"\{.*\}", content, re.DOTALL)
    if m:
        return json.loads(m.group(0))
    raise ValueError(f"LLM returned non-JSON structured output: {content[:500]}")


class MockProvider(LLMProvider):
    """Offline fallback: generates plausible debate turns + graph JSON without network."""

    _OPENERS = [
        "이 관점에서 한 걸음 더 들어가 보자. {topic}의 핵심은 결국 트레이드오프를 어디에 둘 것인가이다.",
        "{topic}에 대해 지금까지 나온 이야기와는 다른 각도로 접근해 보고 싶다.",
        "앞선 의견을 받아서 구체화해 보자. {topic}을 실제로 동작하게 하려면 무엇이 필요할까?",
        "{topic}을 처음 접하는 사용자의 입장에서 다시 생각해 보자.",
    ]
    _MOVES = [
        "앞선 의견에 동의하면서도 한 가지 보완점을 제안하고 싶다. {prev}라는 지적은 유효하지만, 이를 해결하는 방법으로 모듈 분리를 고려할 수 있다.",
        "반대 관점에서 짚어보자. {prev}라는 주장에는 숨은 전제가 있다. 그 전제가 깨지는 경우를 먼저 검토해야 한다.",
        "새로운 대안을 제시한다. 기존 논의를 {frame} 관점으로 재구성하면 전혀 다른 해법이 보인다.",
        "구체화해 보자. 추상적인 원칙을 넘어서, 2주 안에 검증 가능한 작은 실험으로 쪼개는 것이 먼저다.",
        "앞선 두 의견을 결합할 수 있다. A의 확장성과 B의 비판을 모두 살리는 절충안이 가능하다.",
        "질문을 던지고 싶다. 우리가 아직 답하지 못한 것은, 이 아이디어가 실패하는 조건이 무엇인가이다.",
    ]

    async def generate(self, messages: list[dict[str, str]], model: str, **kwargs: Any) -> str:
        return "".join([c async for c in self.stream(messages, model, **kwargs)])

    async def generate_structured(
        self, messages: list[dict[str, str]], model: str, schema: dict[str, Any], **kwargs: Any
    ) -> dict[str, Any]:
        # Derive simple nodes from recent user/assistant messages
        texts = [m.get("content", "") for m in messages if m.get("role") != "system"][-6:]
        nodes, edges = [], []
        for i, t in enumerate(texts):
            if not t.strip():
                continue
            label = t.strip().replace("\n", " ")[:42]
            ntype = ["idea", "question", "objection", "problem", "decision", "conclusion"][i % 6]
            nodes.append(
                {
                    "id": f"node_m{i}",
                    "type": ntype,
                    "label": label,
                    "description": t.strip()[:300],
                    "status": "active",
                    "source_messages": [],
                }
            )
        for i in range(1, len(nodes)):
            edges.append(
                {
                    "id": f"edge_m{i}",
                    "source": nodes[i - 1]["id"],
                    "target": nodes[i]["id"],
                    "type": ["refines", "supports", "contradicts", "related_to"][i % 4],
                }
            )
        if not nodes:
            nodes = [
                {
                    "id": "node_m0",
                    "type": "idea",
                    "label": "초기 아이디어",
                    "description": "토론 시작점",
                    "status": "active",
                    "source_messages": [],
                }
            ]
        return {
            "nodes": nodes[:12],
            "edges": edges[:15],
            "summary": "오프라인 모의 그래프 스냅샷이다.",
            "open_questions": ["무엇을 먼저 검증할 것인가?"],
            "conflicts": [],
        }

    async def stream(self, messages: list[dict[str, str]], model: str, **kwargs: Any) -> AsyncIterator[str]:
        if kwargs.get("role") == "conclusion":
            text = (
                "[오프라인 데모 정리]\n"
                "결론\n"
                "아이디어를 작은 실험부터 검증하자는 쪽으로 의견이 모였지만, 원래 질문에 대한 확정된 판단은 없습니다.\n"
                "남은 쟁점\n"
                "- 범위를 어디까지 잡을지\n"
                "- 우선순위를 누가 정할지\n"
                "제안 / 다음 행동\n"
                "- 2주 안에 끝낼 수 있는 실험 하나를 정해 결과를 확인한다"
            )
            for w in text.split(" "):
                yield w + " "
            return
        topic = "이 주제"
        prev = "앞선 의견"
        for m in reversed(messages):
            if m.get("role") == "user" and m.get("content", "").strip():
                topic = m["content"][:60]
                break
        hist = [m.get("content", "") for m in messages if m.get("role") == "assistant"]
        if hist and hist[-1].strip():
            prev = hist[-1].strip().replace("\n", " ")[:80]
        persona = kwargs.get("persona", "")
        turn = kwargs.get("turn_hint", 1)
        if turn <= 2:
            text = random.choice(self._OPENERS).format(topic=topic)
        else:
            text = random.choice(self._MOVES).format(prev=prev, frame=persona or "사용자 경험")
        if persona:
            text = f"({persona} 관점) " + text
        # word-chunked streaming to mimic tokens
        for w in text.split(" "):
            yield w + " "
