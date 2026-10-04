"""Docker-isolated command execution.

Every command runs in a throwaway container: no network by default, all
capabilities dropped, no-new-privileges, capped memory/CPU/PIDs, an ephemeral
container filesystem, a wall-clock timeout, and the project mounted **read-only**
unless the operator opts in. Host execution is deliberately not implemented —
if the sandbox is unavailable, the caller gets `unavailable` and nothing runs.
"""

from __future__ import annotations

import asyncio
import shutil
import time
import uuid
from dataclasses import dataclass

from app.config import settings

WORKDIR = "/workspace"
_NAME_PREFIX = "nodus-sbx-"


@dataclass
class SandboxResult:
    status: str  # ok | failed | timeout | error | unavailable
    command: str
    image: str
    exit_code: int | None = None
    stdout: str = ""
    stderr: str = ""
    duration_ms: int = 0
    timed_out: bool = False
    truncated: bool = False
    detail: str = ""


def docker_path() -> str | None:
    return shutil.which("docker")


async def available(timeout: float = 8.0) -> bool:
    """True when a Docker daemon answers. Cached briefly by the caller, not here."""
    docker = docker_path()
    if not docker:
        return False
    try:
        proc = await asyncio.create_subprocess_exec(
            docker,
            "version",
            "--format",
            "{{.Server.Version}}",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
    except OSError:
        return False
    try:
        await asyncio.wait_for(proc.wait(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        return False
    return proc.returncode == 0


def clip(text: str, limit: int) -> str:
    """Keep the head (command overview) and the tail (failure summary)."""
    text = text or ""
    if len(text) <= limit:
        return text
    head = int(limit * 0.6)
    tail = limit - head
    return f"{text[:head]}\n… (중략 {len(text) - limit}자) …\n{text[-tail:]}"


def bind_source(project_path: str) -> str:
    """Bind source as the Docker daemon will see it.

    Windows paths contain a drive-letter colon, which volume parsing dislikes;
    forward slashes are accepted everywhere, so normalize rather than abspath
    (abspath would mangle a host path when this backend runs on Linux).
    """
    override = (settings.sandbox_mount_source or "").strip()
    path = override or (project_path or "").strip()
    if len(path) > 1 and path[1] == ":":
        return path.replace("\\", "/")
    return path


def build_args(command: str, *, image: str, project_path: str, name: str, env: dict[str, str] | None) -> list[str]:
    """Argument vector for `docker run`. No shell is involved on the host side."""
    docker = docker_path() or "docker"
    source = bind_source(project_path)
    mode = "rw" if settings.sandbox_writable else "ro"
    args = [
        docker,
        "run",
        "--rm",
        "--name",
        name,
        "--network",
        settings.sandbox_network or "none",
        "--memory",
        settings.sandbox_memory,
        "--cpus",
        settings.sandbox_cpus,
        "--pids-limit",
        str(settings.sandbox_pids_limit),
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--tmpfs",
        "/tmp:rw,size=256m",
        "-v",
        f"{source}:{WORKDIR}:{mode}",
        "-w",
        WORKDIR,
        "-e",
        "HOME=/tmp",
        "-e",
        "PYTHONDONTWRITEBYTECODE=1",
        "-e",
        "PYTHONUNBUFFERED=1",
        "-e",
        "PIP_NO_CACHE_DIR=1",
        "-e",
        "npm_config_cache=/tmp/.npm",
        "-e",
        "CI=1",
        "-e",
        "NO_COLOR=1",
    ]
    if settings.sandbox_user:
        args += ["--user", settings.sandbox_user]
    for key, value in (env or {}).items():
        args += ["-e", f"{key}={value}"]
    args += [image, "/bin/sh", "-lc", command]
    return args


async def run(
    command: str,
    *,
    project_path: str,
    image: str = "",
    timeout_sec: float | None = None,
    env: dict[str, str] | None = None,
) -> SandboxResult:
    """Run `command` inside a disposable container against the project folder."""
    command = command.strip()
    if not command:
        return SandboxResult(status="error", command=command, image=image, detail="실행할 명령이 비어 있습니다")

    resolved_image = (image or settings.sandbox_image or settings.sandbox_default_image).strip()
    if not settings.sandbox_enabled:
        return SandboxResult(
            status="unavailable",
            command=command,
            image=resolved_image,
            detail="코드 실행 기능이 꺼져 있습니다 (SANDBOX_ENABLED=false)",
        )

    docker = docker_path()
    if docker is None:
        return SandboxResult(
            status="unavailable",
            command=command,
            image=resolved_image,
            detail="docker 실행 파일을 찾을 수 없습니다. 격리 실행에는 Docker가 필요합니다.",
        )

    timeout = float(timeout_sec or settings.sandbox_timeout_sec)
    name = f"{_NAME_PREFIX}{uuid.uuid4().hex[:12]}"
    args = build_args(command, image=resolved_image, project_path=project_path, name=name, env=env)
    started = time.monotonic()

    try:
        proc = await asyncio.create_subprocess_exec(
            *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
    except OSError as e:
        return SandboxResult(
            status="unavailable",
            command=command,
            image=resolved_image,
            duration_ms=int((time.monotonic() - started) * 1000),
            detail=f"샌드박스를 시작하지 못했습니다: {e}",
        )

    timed_out = False
    try:
        out_bytes, err_bytes = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        timed_out = True
        await _force_remove(docker, name)
        try:
            out_bytes, err_bytes = await asyncio.wait_for(proc.communicate(), timeout=15)
        except Exception:
            out_bytes, err_bytes = b"", b""
        if proc.returncode is None:
            try:
                proc.kill()
            except ProcessLookupError:
                pass

    duration_ms = int((time.monotonic() - started) * 1000)
    stdout = out_bytes.decode("utf-8", "replace") if out_bytes else ""
    stderr = err_bytes.decode("utf-8", "replace") if err_bytes else ""

    limit = settings.sandbox_max_output_chars
    truncated = len(stdout) > limit or len(stderr) > limit
    stdout = clip(stdout, limit)
    stderr = clip(stderr, limit)

    exit_code = proc.returncode
    if timed_out:
        status = "timeout"
        detail = f"{timeout:.0f}초를 넘겨 강제 종료했습니다"
    elif exit_code == 0:
        status = "ok"
        detail = ""
    elif exit_code is None:
        status = "error"
        detail = "종료 코드를 받지 못했습니다"
    else:
        status = "failed"
        detail = ""

    return SandboxResult(
        status=status,
        command=command,
        image=resolved_image,
        exit_code=exit_code,
        stdout=stdout,
        stderr=stderr,
        duration_ms=duration_ms,
        timed_out=timed_out,
        truncated=truncated,
        detail=detail,
    )


async def _force_remove(docker: str, name: str) -> None:
    """Killing the `docker run` client does not stop the container — remove it explicitly."""
    try:
        proc = await asyncio.create_subprocess_exec(
            docker,
            "rm",
            "-f",
            name,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await asyncio.wait_for(proc.wait(), timeout=15)
    except Exception:
        pass


async def sandbox_info() -> dict:
    """Small status block for the UI / API."""
    docker = docker_path()
    is_up = await available() if docker else False
    return {
        "enabled": settings.sandbox_enabled,
        "driver": settings.sandbox_driver,
        "available": is_up,
        "image": settings.sandbox_image or settings.sandbox_default_image,
        "network": settings.sandbox_network,
        "writable": settings.sandbox_writable,
        "timeout_sec": settings.sandbox_timeout_sec,
        "agent_commands": settings.sandbox_agent_commands,
        "detail": ""
        if is_up
        else ("docker 실행 파일을 찾을 수 없습니다" if not docker else "Docker 데몬에 연결할 수 없습니다"),
    }
