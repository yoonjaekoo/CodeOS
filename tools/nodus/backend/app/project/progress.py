"""Live progress for the Project Analyzer.

In-process and transient by design: the generated context is persisted on the
Project row (`project_context`), this registry only exists so the UI can show
what the analysis is doing right now. A missing entry (e.g. after a restart)
just means "no live run to display".
"""

from __future__ import annotations

import copy
from datetime import datetime, timezone
from typing import Any

STAGES: tuple[tuple[str, str], ...] = (
    ("scan", "폴더 스캔"),
    ("rank", "중요 파일 선정"),
    ("read", "파일 내용 읽기"),
    ("context", "프로젝트 맥락 생성"),
)

_STAGE_KEYS = [key for key, _ in STAGES]

_runs: dict[str, dict[str, Any]] = {}


def begin(project_id: str, project_path: str) -> None:
    _runs[project_id] = {
        "project_id": project_id,
        "project_path": project_path,
        "status": "running",
        "stage": STAGES[0][0],
        "stages": [
            {"key": key, "label": label, "status": "running" if i == 0 else "pending", "detail": ""}
            for i, (key, label) in enumerate(STAGES)
        ],
        "files": [],
        "counts": {"scanned": 0, "selected": 0, "read": 0, "chars": 0},
        "started_at": datetime.now(timezone.utc).isoformat(),
        "finished_at": None,
        "error": None,
    }


def _set_detail(run: dict[str, Any], key: str, detail: str) -> None:
    for s in run["stages"]:
        if s["key"] == key:
            s["detail"] = detail
            return


def done(project_id: str, key: str, detail: str = "", **counters: int) -> None:
    """Finish `key` (with a human-readable detail) and start the next stage."""
    run = _runs.get(project_id)
    if run is None:
        return
    run["counts"].update(counters)
    if detail:
        _set_detail(run, key, detail)
    index = _STAGE_KEYS.index(key)
    next_key = _STAGE_KEYS[index + 1] if index + 1 < len(_STAGE_KEYS) else None
    for s in run["stages"]:
        if s["key"] == key:
            s["status"] = "done"
        elif s["key"] == next_key:
            s["status"] = "running"
    run["stage"] = next_key or key


def set_files(project_id: str, files: list[dict[str, Any]]) -> None:
    """Publish the ranked file list so the UI can show it while files are read."""
    run = _runs.get(project_id)
    if run is None:
        return
    run["files"] = [
        {
            "path": f.get("path", ""),
            "purpose": f.get("purpose", ""),
            "importance": f.get("importance", "high"),
            "read": False,
            "chars": 0,
        }
        for f in files
    ]


def file_read(project_id: str, rel_path: str, chars: int) -> None:
    """Mark one selected file as read (or skipped when `chars` is 0)."""
    run = _runs.get(project_id)
    if run is None:
        return
    for f in run["files"]:
        if f["path"] == rel_path:
            f["read"] = True
            f["chars"] = chars
            break
    run["counts"]["read"] += 1
    run["counts"]["chars"] += chars
    _set_detail(run, "read", f"{run['counts']['read']}/{len(run['files'])}개 · {run['counts']['chars']:,}자")


def finish(project_id: str, status: str, error: str | None = None) -> None:
    run = _runs.get(project_id)
    if run is None:
        return
    run["status"] = status
    run["error"] = error
    run["finished_at"] = datetime.now(timezone.utc).isoformat()
    for s in run["stages"]:
        if s["status"] == "running":
            s["status"] = "done" if status == "done" else "pending"


def is_running(project_id: str) -> bool:
    run = _runs.get(project_id)
    return bool(run and run["status"] == "running")


def snapshot(project_id: str) -> dict[str, Any] | None:
    """Deep copy so an in-flight run cannot mutate the payload mid-serialization."""
    run = _runs.get(project_id)
    return copy.deepcopy(run) if run else None
