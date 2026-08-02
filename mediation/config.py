"""Load repo configuration from .env (secrets) and optional overrides."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

from .llm import DEFAULT_OPENAI_MODEL

REPO_ROOT = Path(__file__).resolve().parents[1]
ENV_FILE = REPO_ROOT / ".env"
ENV_EXAMPLE_FILE = REPO_ROOT / "config.env.example"


@dataclass(frozen=True)
class Settings:
    openai_api_key: str | None
    openai_model: str
    openai_max_tokens: int
    openai_temperature: float
    inworld_api_key: str | None
    inworld_model: str
    port: int

    @property
    def has_openai_key(self) -> bool:
        return bool(self.openai_api_key and self.openai_api_key.strip())


def load_settings(*, env_file: Path | None = None) -> Settings:
    """Load settings from .env then process environment."""
    path = env_file or ENV_FILE
    if path.exists():
        load_dotenv(path, override=False)
    else:
        # Still pick up exported shell vars if .env is missing.
        load_dotenv(override=False)

    return Settings(
        openai_api_key=os.getenv("OPENAI_API_KEY"),
        openai_model=os.getenv("OPENAI_MODEL", DEFAULT_OPENAI_MODEL),
        openai_max_tokens=int(os.getenv("OPENAI_MAX_TOKENS", "512")),
        openai_temperature=float(os.getenv("OPENAI_TEMPERATURE", "0.7")),
        inworld_api_key=os.getenv("INWORLD_API_KEY"),
        inworld_model=os.getenv("INWORLD_MODEL", "zhipu/glm-5.2"),
        port=int(os.getenv("PORT", "3000")),
    )


def ensure_env_file() -> Path:
    """Create .env from config.env.example if missing."""
    if ENV_FILE.exists():
        return ENV_FILE
    if not ENV_EXAMPLE_FILE.exists():
        raise FileNotFoundError(
            f"Missing {ENV_FILE.name} and {ENV_EXAMPLE_FILE.name}. "
            "Add config.env.example to the repo root."
        )
    ENV_FILE.write_text(ENV_EXAMPLE_FILE.read_text())
    return ENV_FILE
