"""Local folder browser for the Project Analyzer path picker.

The frontend runs on the same machine as this backend in local dev, so the
backend exposes directory listing: drives + subfolders only (never files).
"""

from __future__ import annotations

import os
import string

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/api/fs", tags=["fs"])


class ValidateBody(BaseModel):
    path: str


def _drives() -> list[str]:
    if os.name == "nt":
        out = []
        for letter in string.ascii_uppercase:
            drive = f"{letter}:\\"
            if os.path.isdir(drive):
                out.append(drive)
        return out or ["C:\\"]
    # POSIX (Linux/macOS): the home folder is the useful starting point; "/" stays available.
    home = os.path.expanduser("~")
    roots = [home] if home and os.path.isdir(home) else []
    roots.append("/")
    return roots


def _safe_list(path: str, limit: int = 500) -> list[dict[str, str]]:
    try:
        entries = sorted(os.listdir(path))
    except OSError:
        raise HTTPException(403, "이 폴더에 접근할 수 없습니다")
    dirs: list[dict[str, str]] = []
    for name in entries:
        full = os.path.join(path, name)
        try:
            if os.path.isdir(full) and not os.path.islink(full):
                dirs.append({"name": name, "path": full})
        except OSError:
            continue
        if len(dirs) >= limit:
            break
    return dirs


@router.get("/drives")
async def list_drives():
    return {"drives": _drives()}


@router.get("/browse")
async def browse(path: str = ""):
    path = os.path.expanduser((path or "").strip())  # "~" works on Linux/macOS
    if not path:
        return {"path": "", "parent": None, "dirs": [{"name": d, "path": d} for d in _drives()]}
    if not os.path.isdir(path):
        raise HTTPException(400, "존재하지 않는 폴더입니다")
    abspath = os.path.abspath(path)
    parent = os.path.dirname(abspath)
    return {
        "path": abspath,
        "parent": parent if parent and parent != abspath else None,
        "dirs": _safe_list(abspath),
    }


@router.post("/validate")
async def validate(body: ValidateBody):
    path = os.path.expanduser((body.path or "").strip())
    if not path or not os.path.isdir(path):
        return {"ok": False}
    # rough file count (bounded) so the UI can preview the target
    count = 0
    try:
        for _dir, _sub, files in os.walk(path):
            if any(seg in {"node_modules", ".git", ".venv", "venv", "__pycache__", "dist", "target"} for seg in _dir.replace("\\", "/").split("/")):
                continue
            count += len(files)
            if count > 2000:
                break
    except OSError:
        return {"ok": True, "file_count": -1}
    return {"ok": True, "file_count": count}
