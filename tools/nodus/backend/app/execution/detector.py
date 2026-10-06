"""Detect the project's run/test commands from its own manifests.

Pure filesystem heuristics — no LLM, no execution. The result is a suggestion the
user can override (`Project.run_command` / `Project.test_command`).
"""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass

_IMAGE = {
    "python": "python:3.12-slim",
    "node": "node:20-alpine",
    "go": "golang:1.22-alpine",
    "rust": "rust:1.83-slim",
    "java": "eclipse-temurin:21-jdk",
    "maven": "maven:3.9-eclipse-temurin-21",
}


@dataclass
class DetectedCommand:
    kind: str  # run | test
    command: str
    image: str
    reason: str
    confidence: str  # high | medium | low

    def as_dict(self) -> dict:
        return asdict(self)


def _exists(root: str, *names: str) -> str | None:
    for name in names:
        if os.path.isfile(os.path.join(root, name)):
            return name
    return None


def _read_text(root: str, name: str, limit: int = 200_000) -> str:
    try:
        with open(os.path.join(root, name), "r", encoding="utf-8", errors="replace") as fh:
            return fh.read(limit)
    except OSError:
        return ""


def _read_package_scripts(root: str) -> dict[str, str]:
    try:
        data = json.loads(_read_text(root, "package.json"))
    except Exception:
        return {}
    scripts = data.get("scripts")
    return scripts if isinstance(scripts, dict) else {}


def _makefile_has_target(root: str, target: str) -> bool:
    text = _read_text(root, "Makefile") or _read_text(root, "makefile")
    if not text:
        return False
    return any(line.startswith(f"{target}:") for line in text.splitlines())


def detect(project_path: str) -> list[DetectedCommand]:
    """Ordered suggestions: tests first (the whole point of verification), then run."""
    if not project_path or not os.path.isdir(project_path):
        return []
    root = os.path.abspath(project_path)
    tests: list[DetectedCommand] = []
    runs: list[DetectedCommand] = []

    # ── Node / npm ─────────────────────────────────────────────────────────
    scripts = _read_package_scripts(root)
    if scripts:
        image = _IMAGE["node"]
        if "test" in scripts:
            tests.append(DetectedCommand("test", "npm test --silent", image, "package.json의 test 스크립트", "high"))
        if "build" in scripts:
            runs.append(DetectedCommand("run", "npm run build", image, "package.json의 build 스크립트", "medium"))
        elif "start" in scripts:
            runs.append(DetectedCommand("run", "npm start", image, "package.json의 start 스크립트", "low"))

    # ── Python ─────────────────────────────────────────────────────────────
    py_markers = [
        m
        for m in ("pyproject.toml", "setup.py", "setup.cfg", "pytest.ini", "tox.ini", "requirements.txt")
        if _exists(root, m)
    ]
    has_python = bool(py_markers) or os.path.isdir(os.path.join(root, "tests")) or any(
        os.path.isfile(os.path.join(root, n)) for n in ("main.py", "app.py", "manage.py")
    )
    if has_python:
        image = _IMAGE["python"]
        if _exists(root, "manage.py"):
            tests.append(
                DetectedCommand("test", "python manage.py test", image, "Django manage.py", "high")
            )
        if os.path.isdir(os.path.join(root, "tests")) or {"pyproject.toml", "pytest.ini"} & set(py_markers):
            tests.append(
                DetectedCommand(
                    "test",
                    "python -m pytest -q",
                    image,
                    f"pytest 구성 발견 ({', '.join(py_markers) or 'tests/'})",
                    "high" if os.path.isdir(os.path.join(root, "tests")) else "medium",
                )
            )
        for entry in ("main.py", "app.py"):
            if _exists(root, entry):
                runs.append(DetectedCommand("run", f"python {entry}", image, f"{entry} 진입점", "low"))
                break
        if _makefile_has_target(root, "test"):
            tests.append(DetectedCommand("test", "make test", image, "Makefile의 test 타깃", "medium"))

    # ── Go ─────────────────────────────────────────────────────────────────
    if _exists(root, "go.mod"):
        image = _IMAGE["go"]
        tests.append(DetectedCommand("test", "go test ./...", image, "go.mod", "high"))
        runs.append(DetectedCommand("run", "go build ./...", image, "go.mod", "medium"))

    # ── Rust ───────────────────────────────────────────────────────────────
    if _exists(root, "Cargo.toml"):
        image = _IMAGE["rust"]
        tests.append(DetectedCommand("test", "cargo test", image, "Cargo.toml", "high"))
        runs.append(DetectedCommand("run", "cargo build", image, "Cargo.toml", "medium"))

    # ── JVM ────────────────────────────────────────────────────────────────
    if _exists(root, "pom.xml"):
        tests.append(
            DetectedCommand("test", "mvn -q -B test", _IMAGE["maven"], "Maven pom.xml", "high")
        )
        runs.append(
            DetectedCommand(
                "run", "mvn -q -B package -DskipTests", _IMAGE["maven"], "Maven pom.xml", "medium"
            )
        )
    if _exists(root, "build.gradle", "build.gradle.kts"):
        gradlew = "./gradlew" if _exists(root, "gradlew") else "gradle"
        tests.append(
            DetectedCommand("test", f"{gradlew} test", _IMAGE["java"], "Gradle 빌드 스크립트", "medium")
        )
        runs.append(
            DetectedCommand("run", f"{gradlew} build -x test", _IMAGE["java"], "Gradle 빌드 스크립트", "low")
        )

    # ── Makefile만 있는 경우 ────────────────────────────────────────────────
    if not tests and _makefile_has_target(root, "test"):
        tests.append(
            DetectedCommand("test", "make test", _IMAGE["python"], "Makefile의 test 타깃", "low")
        )

    return tests + runs


def detect_kind(project_path: str, kind: str) -> DetectedCommand | None:
    return next((c for c in detect(project_path) if c.kind == kind), None)
