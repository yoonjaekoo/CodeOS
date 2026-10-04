"""Safe project directory scanning for the Project Analyzer.

- Excludes vendored/generated/binary junk.
- Never reads sensitive files (.env, keys, credentials, secrets).
- Redacts secret-looking strings from any content that IS read.
"""

from __future__ import annotations

import fnmatch
import json
import os
import re

EXCLUDED_DIRS = {
    ".git", "node_modules", "dist", "build", ".next", "coverage", "venv", ".venv",
    "__pycache__", ".pytest_cache", "target", ".cache", ".mypy_cache", ".ruff_cache",
    "out", ".turbo", "vendor", "site-packages", ".idea", ".vscode", "bower_components",
}

SENSITIVE_PATTERNS = [
    ".env", "*.env", ".env.*", "*.pem", "*.key", "credentials.*", "secrets.*",
    "*.p12", "*.pfx", "id_rsa*", "*.keystore", ".npmrc", ".netrc",
]

# Extensions we never treat as text
BINARY_EXTS = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".tar", ".gz",
    ".7z", ".rar", ".exe", ".dll", ".so", ".dylib", ".woff", ".woff2", ".ttf", ".otf",
    ".eot", ".mp3", ".mp4", ".mov", ".avi", ".sqlite", ".db", ".pyc", ".class", ".jar",
    ".wasm", ".bin", ".dat", ".lock", ".svgz",
}

# Secret redaction (applied to every file content that reaches the LLM)
_SECRET_RULES = [
    (re.compile(r"sk-[A-Za-z0-9_\-]{8,}"), "<REDACTED_KEY>"),
    (re.compile(r"(?i)(api[_-]?key\s*[=:]\s*['\"]?)[^\s'\",}]{4,}"), r"\1<REDACTED>"),
    (re.compile(r"(?i)(secret\s*[=:]\s*['\"]?)[^\s'\",}]{4,}"), r"\1<REDACTED>"),
    (re.compile(r"(?i)(password\s*[=:]\s*['\"]?)[^\s'\",}]{4,}"), r"\1<REDACTED>"),
    (re.compile(r"(?i)(token\s*[=:]\s*['\"]?)[^\s'\",}]{4,}"), r"\1<REDACTED>"),
    (re.compile(r"(?i)(authorization\s*[:=]\s*)(Bearer\s+)?[^\s'\",}]{4,}"), r"\1<REDACTED>"),
    (re.compile(r"(postgres(?:ql)?|mysql|mongodb)\+?\S*://[^\s'\"]+:[^@\s'\"]+@"), r"\1://<REDACTED>@"),
]

META_FILES = [
    "package.json", "requirements.txt", "pyproject.toml", "Cargo.toml", "go.mod",
    "Dockerfile", "docker-compose.yml", "docker-compose.yaml", "compose.yml",
    "README.md", "readme.md", "tsconfig.json", "vite.config.ts", "next.config.js",
    "next.config.ts", "nest-cli.json", "alembic.ini",
]


def is_sensitive(rel_path: str) -> bool:
    name = os.path.basename(rel_path).lower()
    for pat in SENSITIVE_PATTERNS:
        if fnmatch.fnmatch(name, pat.lower()):
            return True
    return False


def redact(text: str) -> str:
    for rx, repl in _SECRET_RULES:
        text = rx.sub(repl, text)
    return text


def scan_tree(root: str, max_files: int = 400, max_depth: int = 12) -> list[str]:
    """Return safe relative file paths, shallower-first, capped."""
    out: list[str] = []
    base_depth = root.rstrip(os.sep).count(os.sep)
    for dirpath, dirnames, filenames in os.walk(root):
        rel_dir = os.path.relpath(dirpath, root)
        depth = dirpath.count(os.sep) - base_depth
        if depth >= max_depth:
            dirnames[:] = []
        dirnames[:] = [d for d in sorted(dirnames) if d not in EXCLUDED_DIRS and not d.startswith(".git")]
        for f in sorted(filenames):
            rel = os.path.normpath(os.path.join(rel_dir, f)) if rel_dir != "." else f
            if is_sensitive(rel):
                continue
            out.append(rel.replace("\\", "/"))
            if len(out) >= max_files:
                return out
    return out


def read_meta(root: str) -> dict:
    """Lightweight manifest parsing (no LLM)."""
    meta: dict = {"name": None, "languages": [], "frameworks": [], "database": [], "infrastructure": [], "notes": []}

    def _try(path):
        try:
            with open(os.path.join(root, path), "r", encoding="utf-8", errors="replace") as fh:
                return redact(fh.read(20000))
        except Exception:
            return None

    pkg = _try("package.json")
    if pkg:
        try:
            data = json.loads(pkg)
            meta["name"] = data.get("name") or meta["name"]
            deps = {**(data.get("dependencies") or {}), **(data.get("devDependencies") or {})}
            for kw, label in [
                ("react", "React"), ("next", "Next.js"), ("vue", "Vue"), ("svelte", "Svelte"),
                ("express", "Express"), ("nest", "NestJS"), ("vite", "Vite"), ("prisma", "Prisma"),
            ]:
                if kw in deps:
                    meta["frameworks"].append(label)
        except Exception:
            pass
    reqs = _try("requirements.txt")
    if reqs:
        for kw, label in [
            ("fastapi", "FastAPI"), ("django", "Django"), ("flask", "Flask"),
            ("sqlalchemy", "SQLAlchemy"), ("asyncpg", "PostgreSQL"), ("psycopg", "PostgreSQL"),
        ]:
            if kw in reqs.lower():
                meta["frameworks" if kw in ("fastapi", "django", "flask") else "database"].append(label)
    pyproject = _try("pyproject.toml")
    if pyproject and "fastapi" in pyproject.lower() and "FastAPI" not in meta["frameworks"]:
        meta["frameworks"].append("FastAPI")
    gomod = _try("go.mod")
    if gomod:
        meta["languages"].append("Go")
        first = gomod.splitlines()[0] if gomod else ""
        if "module " in first:
            meta["name"] = meta["name"] or first.split("module ")[-1].strip().split("/")[-1]
    cargo = _try("Cargo.toml")
    if cargo:
        meta["languages"].append("Rust")
    compose = _try("docker-compose.yml") or _try("compose.yml")
    if compose:
        meta["infrastructure"].append("Docker Compose")
        low = compose.lower()
        if "postgres" in low and "PostgreSQL" not in meta["database"]:
            meta["database"].append("PostgreSQL")
        if "mysql" in low and "MySQL" not in meta["database"]:
            meta["database"].append("MySQL")
        if "mongo" in low and "MongoDB" not in meta["database"]:
            meta["database"].append("MongoDB")
        if "redis" in low:
            meta["database"].append("Redis")
    if _try("Dockerfile"):
        meta["infrastructure"].append("Docker")
    readme = _try("README.md") or _try("readme.md")
    if readme:
        first = next((l.strip() for l in readme.splitlines() if l.strip().startswith("#")), "")
        meta["name"] = meta["name"] or first.lstrip("# ").strip()[:60] or None
        meta["notes"].append(readme[:400])
    return meta


def read_file(root: str, rel: str, max_chars: int = 8000) -> str:
    """Safely read a text file (sensitive files always refused)."""
    full = _resolve(root, rel)
    if full is None or is_sensitive(rel):
        raise ValueError(f"unsafe or sensitive path: {rel}")
    ext = os.path.splitext(rel)[1].lower()
    if ext in BINARY_EXTS:
        return ""
    try:
        with open(full, "rb") as fh:
            raw = fh.read(max_chars * 4 + 1024)
    except OSError:
        return ""
    if b"\x00" in raw[:1024]:  # binary heuristic
        return ""
    text = raw.decode("utf-8", errors="replace")[:max_chars]
    return redact(text)


def _resolve(root: str, rel: str) -> str | None:
    root_abs = os.path.abspath(root)
    full = os.path.abspath(os.path.join(root_abs, rel))
    if not full.startswith(root_abs + os.sep) and full != root_abs:
        return None
    return full


def language_guess(paths: list[str]) -> list[str]:
    counts: dict[str, int] = {}
    ext_map = {
        ".py": "Python", ".ts": "TypeScript", ".tsx": "TypeScript", ".js": "JavaScript",
        ".jsx": "JavaScript", ".go": "Go", ".rs": "Rust", ".java": "Java", ".kt": "Kotlin",
        ".rb": "Ruby", ".php": "PHP", ".cs": "C#", ".swift": "Swift", ".c": "C", ".cpp": "C++",
    }
    for p in paths:
        ext = os.path.splitext(p)[1].lower()
        if ext in ext_map:
            counts[ext_map[ext]] = counts.get(ext_map[ext], 0) + 1
    return [k for k, _ in sorted(counts.items(), key=lambda x: -x[1])]
