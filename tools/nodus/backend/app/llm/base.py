"""LLM provider abstraction. Frontend never sees keys; all calls happen here."""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from typing import Any


class LLMProvider(ABC):
    @abstractmethod
    async def generate(self, messages: list[dict[str, str]], model: str, **kwargs: Any) -> str:
        ...

    @abstractmethod
    async def generate_structured(
        self, messages: list[dict[str, str]], model: str, schema: dict[str, Any], **kwargs: Any
    ) -> dict[str, Any]:
        ...

    @abstractmethod
    async def stream(self, messages: list[dict[str, str]], model: str, **kwargs: Any) -> AsyncIterator[str]:
        ...
