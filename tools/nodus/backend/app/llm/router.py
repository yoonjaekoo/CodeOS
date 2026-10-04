"""Role-separated LLM routing. Debate / moderator / graph can use different models."""

from __future__ import annotations

from app.config import settings
from app.llm.base import LLMProvider
from app.llm.providers import MockProvider, OpenAICompatibleProvider

_provider: LLMProvider | None = None


def get_provider() -> LLMProvider:
    global _provider
    if _provider is not None:
        return _provider
    if settings.llm_api_key:
        _provider = OpenAICompatibleProvider(
            api_key=settings.llm_api_key,
            base_url=settings.llm_base_url,
            timeout_sec=settings.llm_timeout_sec,
        )
    else:
        _provider = MockProvider()
    return _provider


def reset_provider() -> None:
    global _provider
    _provider = None


def model_for(role: str) -> str:
    if role == "graph":
        return settings.graph_model
    if role == "moderator":
        return settings.moderator_model
    return settings.debate_model
