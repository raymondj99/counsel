"""Psychology analysis — produces UserProfile objects from raw UserInput."""

from __future__ import annotations

import json
import re

from .llm import LLMClient
from .models import UserInput, UserProfile
from .prompt_templates import PSYCHOLOGY_ANALYZE, PSYCHOLOGY_SYSTEM


class PsychologyAnalyzer:
    def __init__(self, llm: LLMClient):
        self.llm = llm

    def analyze(self, user_input: UserInput) -> UserProfile:
        prompt = PSYCHOLOGY_ANALYZE.format(
            name=user_input.name,
            background=user_input.background,
            goals=", ".join(user_input.stated_goals) or "none stated",
            concerns=", ".join(user_input.concerns) or "none stated",
        )
        raw = self.llm.complete(prompt, system=PSYCHOLOGY_SYSTEM)
        payload = self._parse_json(raw)
        payload["name"] = user_input.name
        return UserProfile.model_validate(payload)

    def analyze_pair(self, user1: UserInput, user2: UserInput) -> tuple[UserProfile, UserProfile]:
        return self.analyze(user1), self.analyze(user2)

    @staticmethod
    def _parse_json(raw: str) -> dict:
        cleaned = raw.strip()
        fence_match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", cleaned, re.DOTALL)
        if fence_match:
            cleaned = fence_match.group(1)
        return json.loads(cleaned)
