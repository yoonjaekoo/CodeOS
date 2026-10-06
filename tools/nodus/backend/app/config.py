from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "sqlite+aiosqlite:///./nodus.db"
    llm_api_key: str = ""
    llm_base_url: str = "https://api.openai.com/v1"
    llm_model: str = "gpt-4o-mini"
    # Optional per-role overrides (fall back to llm_model)
    llm_debate_model: str = ""
    llm_graph_model: str = ""
    llm_moderator_model: str = ""
    llm_timeout_sec: float = 60.0
    # Safety cap for "Unlimited" discussions
    max_turns_safety_cap: int = 500
    cors_origins: str = "http://localhost:5173,http://localhost:3000"

    # ── Sandboxed code execution ────────────────────────────────────────────
    # Every command runs in a throwaway container. There is intentionally no
    # host-execution driver: if the sandbox is unavailable we refuse to run.
    sandbox_enabled: bool = True
    sandbox_driver: str = "docker"
    sandbox_default_image: str = "python:3.12-slim"
    sandbox_image: str = ""  # override; empty = auto-detect from the project stack
    sandbox_network: str = "none"  # "none" | "bridge"
    sandbox_memory: str = "1g"
    sandbox_cpus: str = "1.0"
    sandbox_pids_limit: int = 256
    sandbox_user: str = ""  # e.g. "1000:1000"; empty = the image's own user
    # Project folder is mounted read-only by default so a run can never modify the host tree.
    sandbox_writable: bool = False
    # Bind source override. Needed only when this backend itself runs in a container
    # while the Docker daemon is on the host (the daemon resolves paths on the host).
    sandbox_mount_source: str = ""
    sandbox_timeout_sec: float = 120.0
    sandbox_max_output_chars: int = 20000
    # Let debate agents request a run with `@test` / `@run <command>`.
    sandbox_agent_commands: bool = True

    @property
    def debate_model(self) -> str:
        return self.llm_debate_model or self.llm_model

    @property
    def graph_model(self) -> str:
        return self.llm_graph_model or self.llm_model

    @property
    def moderator_model(self) -> str:
        return self.llm_moderator_model or self.llm_model

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    class Config:
        env_file = ".env"
        extra = "ignore"


settings = Settings()
