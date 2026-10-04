"""Read an agent turn for sandbox run requests.

An agent asks for real evidence by ending a line with `@test` or `@run <command>`.
Those lines are control tokens, not speech: they are stripped from the stored
message so the chat shows only what the agent actually said.
"""

from __future__ import annotations

import re

# A whole line that is just the marker (optionally indented).
RUN_LINE_RE = re.compile(r"^[ \t]*@(run|test)\b[ \t]*(.*?)[ \t]*$", re.IGNORECASE | re.MULTILINE)

MAX_REQUESTS_PER_TURN = 1


def extract_run_requests(content: str) -> tuple[list[tuple[str, str | None]], str]:
    """Return ([(kind, command), ...], cleaned_content)."""
    requests: list[tuple[str, str | None]] = []

    def _take(match: re.Match) -> str:
        if len(requests) >= MAX_REQUESTS_PER_TURN:
            return ""
        kind = match.group(1).lower()
        arg = (match.group(2) or "").strip().strip("`").strip()
        if kind == "test" and not arg:
            requests.append(("test", None))
        elif arg:
            requests.append(("run", arg))
        else:  # bare "@run" with no command is meaningless
            return ""
        return ""

    cleaned = RUN_LINE_RE.sub(_take, content or "")
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip()
    return requests, cleaned
