"""Load prompt text files from the prompt_templates directory."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

TEMPLATES_ROOT = Path(__file__).resolve().parent


@lru_cache(maxsize=None)
def load_text(*parts: str) -> str:
    path = TEMPLATES_ROOT.joinpath(*parts)
    if not path.exists():
        raise FileNotFoundError(f"Prompt template not found: {path}")
    return path.read_text().strip()


@lru_cache(maxsize=None)
def load_lines(*parts: str) -> list[str]:
    raw = load_text(*parts)
    return [line.strip() for line in raw.splitlines() if line.strip() and not line.strip().startswith("#")]
