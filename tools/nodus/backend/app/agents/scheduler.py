"""Weighted next-speaker selection. Light touch: never a fixed rotation."""

from __future__ import annotations

import random

from app.agents.base import Agent


def pick_next_agent(
    agents: list[Agent],
    recent_agent_ids: list[str | None],
    rng: random.Random | None = None,
) -> Agent:
    rng = rng or random
    weights: list[float] = []
    for a in agents:
        w = 1.0
        # Penalize whoever spoke most recently (avoid same-agent streaks)
        if recent_agent_ids:
            if recent_agent_ids[-1] == a.id:
                w *= 0.15
            if a.id in recent_agent_ids[-2:]:
                w *= 0.5
        # Slightly favor agents that haven't spoken recently
        if a.id not in recent_agent_ids[-len(agents) :]:
            w *= 1.6
        weights.append(max(w, 0.05))
    return rng.choices(agents, weights=weights, k=1)[0]
