"""Project Analyzer: layered scan → metadata → important-file selection → context generation.

Runs ONCE per session start (never per turn). LLM-driven with a local
heuristic fallback so Nodus still works without an API key.
"""

from __future__ import annotations

import asyncio
import json
import os
import re

from app.llm.router import get_provider, model_for
from app.project.models import ImportantFile, ProjectContext, project_context_schema
from app.project import progress, scanner

_SYSTEM = (
    "당신은 소프트웨어 프로젝트 분석기입니다. 제공된 파일 구조와 파일 내용만 근거로 "
    "프로젝트의 구조를 분석하여 지정된 JSON 스키마로만 답합니다. "
    "파일에 없는 내용을 추측하지 말고, 한국어로 간결하게 작성하세요."
)


def select_important_files(paths: list[str]) -> list[str]:
    """Heuristic pre-selection before LLM ranking (cheap, deterministic)."""
    high_names = {
        "main.py", "app.py", "manage.py", "main.tsx", "main.ts", "main.go", "main.rs",
        "app.tsx", "App.tsx", "index.tsx", "index.ts", "index.js", "server.py", "server.ts",
        "wsgi.py", "asgi.py", "settings.py", "urls.py", "routes.py", "models.py",
        "schema.py", "schemas.py", "database.py", "db.py", "package.json", "Cargo.toml",
        "go.mod", "pyproject.toml", "docker-compose.yml", "Dockerfile", "README.md",
        "vite.config.ts", "next.config.js", "next.config.ts", "application.properties",
    }
    picked: list[str] = []
    for p in paths:
        name = os.path.basename(p).lower()
        if name in high_names or name.endswith(".sql") or "/migrations/" in p or p.startswith("alembic"):
            picked.append(p)
    return list(dict.fromkeys(picked))  # ordered unique


async def _llm_structured(messages: list[dict], schema: dict) -> dict:
    provider = get_provider()
    return await provider.generate_structured(messages, model=model_for("graph"), schema=schema, temperature=0.2)


def _extract_json(text: str) -> dict:
    text = (text or "").strip()
    try:
        return json.loads(text)
    except Exception:
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if m:
            return json.loads(m.group(0))
    raise ValueError("non-JSON analyzer output")


async def analyze_project(project_path: str, project_id: str) -> ProjectContext:
    """Full pipeline. Raises on hard failure; caller decides fallback."""
    root = os.path.abspath(project_path)
    paths = await asyncio.to_thread(scanner.scan_tree, root)
    meta = await asyncio.to_thread(scanner.read_meta, root)
    meta["languages"] = sorted(set(meta.get("languages") or []) | set(scanner.language_guess(paths)))
    progress.done(project_id, "scan", f"파일 {len(paths)}개", scanned=len(paths))

    # ── Step 1+2: rank important files with LLM (structure only, cheap)
    tree_text = "\n".join(paths[:400])
    meta_text = json.dumps({k: v for k, v in meta.items() if k != "notes"}, ensure_ascii=False)
    readme = next(iter(meta.get("notes") or []), "")
    path_set = set(paths)
    selection: list[ImportantFile] = []
    try:
        raw = await _llm_structured(
            [
                {"role": "system", "content": _SYSTEM},
                {
                    "role": "user",
                    "content": (
                        "1단계: 아래 파일 목록에서 프로젝트 이해에 가장 중요한 파일을 최대 15개 고르고 "
                        "각 파일의 용도를 한 줄로 설명하세요. importance는 high/medium/low.\n\n"
                        f"파일 목록:\n{tree_text}\n\n메타데이터:\n{meta_text}\n\nREADME 앞부분:\n{readme[:400]}"
                    ),
                },
            ],
            schema={
                "type": "object",
                "properties": {
                    "files": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "path": {"type": "string"},
                                "purpose": {"type": "string"},
                                "importance": {"type": "string", "enum": ["high", "medium", "low"]},
                            },
                            "required": ["path"],
                        },
                    }
                },
                "required": ["files"],
            },
        )
    except Exception:
        raw = {}
    raw_files = raw.get("files", []) if isinstance(raw, dict) else []

    def _match(rel: str) -> str | None:
        rel = rel.strip().replace("\\", "/").lstrip("./")
        if rel in path_set:
            return rel
        for p in paths:  # tolerate leading prefixes the model may add
            if p.endswith(rel):
                return p
        return None

    for f in raw_files[:15]:
        matched = _match(str(f.get("path", "")))
        if matched and not scanner.is_sensitive(matched):
            selection.append(ImportantFile(path=matched, purpose=f.get("purpose", ""), importance=f.get("importance", "high")))
    if not selection:  # heuristic fallback for file ranking
        for p in select_important_files(paths)[:15]:
            selection.append(ImportantFile(path=p, purpose="", importance="high"))
    progress.set_files(project_id, [f.model_dump() for f in selection])
    progress.done(project_id, "rank", f"{len(selection)}개 선택", selected=len(selection))

    # ── Step 3: read selected file contents (redacted, capped)
    contents: list[str] = []
    budget = 30000
    for f in selection:
        body = await asyncio.to_thread(scanner.read_file, root, f.path, 4000)
        progress.file_read(project_id, f.path, len(body))
        if not body:
            continue
        chunk = f"### {f.path}\n```\n{body[:3500]}\n```"
        if sum(len(c) for c in contents) + len(chunk) > budget:
            break
        contents.append(chunk)
    progress.done(project_id, "read")

    # ── Step 4: generate the structured Project Context
    try:
        data = await _llm_structured(
            [
                {"role": "system", "content": _SYSTEM},
                {
                    "role": "user",
                    "content": (
                        "아래 정보를 근거로 최종 Project Context JSON을 만드세요.\n\n"
                        f"메타데이터:\n{meta_text}\n\nREADME 앞부분:\n{readme[:400]}\n\n"
                        "중요 파일 목록:\n"
                        + "\n".join(f"- {f.path} ({f.importance}): {f.purpose}" for f in selection)
                        + "\n\n파일 내용 발췌:\n" + "\n\n".join(contents)
                    ),
                },
            ],
            schema=project_context_schema(),
        )
        ctx = ProjectContext.model_validate(data)
    except Exception:
        ctx = _local_fallback(paths, meta, selection)

    # Safety: drop any sensitive path the LLM might have hallucinated
    ctx.important_files = [f for f in ctx.important_files if not scanner.is_sensitive(f.path)]

    # Merge scanner ground truth over LLM output (LLM may hallucinate or drop the manifest facts)
    if not ctx.important_files and selection:
        ctx.important_files = selection
    if not ctx.stack.languages:
        ctx.stack.languages = meta.get("languages") or []
    if not ctx.stack.frameworks:
        ctx.stack.frameworks = meta.get("frameworks") or []
    if not ctx.stack.database:
        ctx.stack.database = meta.get("database") or []
    if not ctx.stack.infrastructure:
        ctx.stack.infrastructure = meta.get("infrastructure") or []
    if not ctx.project.name:
        ctx.project.name = meta.get("name") or ""
    progress.done(project_id, "context", "완료")
    return ctx


def _local_fallback(paths: list[str], meta: dict, selection: list[ImportantFile]) -> ProjectContext:
    """No-LLM/offline context so analysis never blocks debate entirely."""
    entry = [p for p in paths if os.path.basename(p).lower() in {"main.py", "app.py", "main.tsx", "index.ts", "app.tsx"}][:5]
    files = selection or [ImportantFile(path=p, purpose="", importance="high") for p in select_important_files(paths)[:10]]
    return ProjectContext(
        project={"name": meta.get("name") or os.path.basename(meta.get("root", "프로젝트")) or "프로젝트", "description": "", "purpose": ""},
        stack={
            "languages": meta.get("languages") or [],
            "frameworks": meta.get("frameworks") or [],
            "database": meta.get("database") or [],
            "infrastructure": meta.get("infrastructure") or [],
        },
        architecture={"overview": "", "components": [], "data_flow": []},
        entry_points=entry,
        important_files=files,
        context_summary="로컬 휴리스틱으로 생성된 요약입니다 (LLM 분석 실패).",
    )


def render_context_text(ctx: ProjectContext) -> str:
    """The [PROJECT CONTEXT] block injected into every agent/moderator system prompt."""
    lines: list[str] = ["[PROJECT CONTEXT]"]
    p = ctx.project
    if p.name:
        lines.append(f"프로젝트: {p.name}")
    if p.description:
        lines.append(f"설명: {p.description}")
    if p.purpose:
        lines.append(f"목적: {p.purpose}")
    s = ctx.stack
    stack_bits = []
    if s.languages:
        stack_bits.append("언어: " + ", ".join(s.languages))
    if s.frameworks:
        stack_bits.append("프레임워크: " + ", ".join(s.frameworks))
    if s.database:
        stack_bits.append("DB: " + ", ".join(s.database))
    if s.infrastructure:
        stack_bits.append("인프라: " + ", ".join(s.infrastructure))
    lines += stack_bits
    if ctx.architecture.overview:
        lines.append(f"아키텍처: {ctx.architecture.overview}")
    if ctx.architecture.components:
        lines.append("구성요소: " + "; ".join(ctx.architecture.components[:8]))
    if ctx.entry_points:
        lines.append("시작점: " + ", ".join(ctx.entry_points[:6]))
    if ctx.important_files:
        lines.append(
            "중요 파일:\n"
            + "\n".join(f"- {f.path} ({f.importance}) — {f.purpose}" for f in ctx.important_files[:12])
        )
    if ctx.apis:
        lines.append("API: " + "; ".join(ctx.apis[:8]))
    if ctx.database.technology or ctx.database.important_entities:
        lines.append(f"DB: {ctx.database.technology} — {ctx.database.schema_summary[:300]}")
        if ctx.database.important_entities:
            lines.append("핵심 엔티티: " + ", ".join(ctx.database.important_entities[:10]))
    if ctx.workflows:
        lines.append("주요 흐름: " + "; ".join(ctx.workflows[:6]))
    if ctx.technical_concerns:
        lines.append("기술적 주의사항:\n" + "\n".join(f"- {c}" for c in ctx.technical_concerns[:8]))
    if ctx.development_notes:
        lines.append("개발 참고:\n" + "\n".join(f"- {n}" for n in ctx.development_notes[:6]))
    if ctx.context_summary:
        lines.append(f"요약: {ctx.context_summary}")
    lines.append("[END PROJECT CONTEXT]")
    return "\n".join(lines)
