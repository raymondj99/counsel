"""Inworld chat-completions client for live mediation."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

INWORLD_URL = "https://api.inworld.ai/v1/chat/completions"
DEFAULT_MODEL = "zhipu/glm-5.2"


class InworldClient:
    """Minimal wrapper around Inworld's OpenAI-compatible chat API."""

    def __init__(
        self,
        *,
        api_key: str | None = None,
        model: str = DEFAULT_MODEL,
    ):
        key = api_key or os.environ.get("INWORLD_API_KEY")
        if not key:
            raise ValueError(
                "Inworld API key required. Set INWORLD_API_KEY or pass api_key=."
            )
        self.api_key = key
        self.model = model

    def complete(
        self,
        *,
        system: str,
        user: str,
        max_tokens: int = 120,
    ) -> str:
        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "max_tokens": max_tokens,
        }
        req = urllib.request.Request(
            INWORLD_URL,
            data=json.dumps(payload).encode(),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Basic {self.api_key}",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = json.loads(resp.read().decode())
        except urllib.error.HTTPError as exc:
            body = exc.read().decode() if exc.fp else ""
            raise RuntimeError(f"Inworld API {exc.code}: {body}") from exc

        choices = data.get("choices") or []
        if not choices:
            raise RuntimeError("Inworld returned no choices")
        content = choices[0].get("message", {}).get("content")
        if not content:
            raise RuntimeError("Inworld returned empty content")
        return content.strip()
