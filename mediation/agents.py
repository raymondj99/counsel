"""Mediation agents initialised from user psychology profiles."""

from __future__ import annotations

from .llm import LLMClient
from .models import OpeningStrategy, UserProfile
from .persona_behavior import behavioral_instructions
from .prompt_templates import AGENT_MEDIATED_RESPONSE, AGENT_OPENING, OPENING_STRATEGY_LABELS


class MediationAgent:
    """Agent embodying one participant's persona."""

    def __init__(
        self,
        profile: UserProfile,
        llm: LLMClient,
        *,
        role: str,
        problem: str,
    ):
        self.profile = profile
        self.llm = llm
        self.role = role
        self.problem = problem

    @classmethod
    def for_user1(cls, profile: UserProfile, llm: LLMClient, problem: str) -> MediationAgent:
        return cls(profile, llm, role="user1", problem=problem)

    @classmethod
    def for_user2(cls, profile: UserProfile, llm: LLMClient, problem: str) -> MediationAgent:
        return cls(profile, llm, role="user2", problem=problem)

    def opening(self, strategy: OpeningStrategy, history: list[str] | None = None) -> str:
        prompt = AGENT_OPENING.format(
            speaker_name=self.profile.name,
            persona=self.profile.to_persona_context(),
            problem=self.problem,
            strategy_label=OPENING_STRATEGY_LABELS[strategy],
            behavioral_instructions=behavioral_instructions(
                self.profile,
                is_opening=True,
                history=history,
            ),
            history=self._format_history(history),
        )
        return self.llm.complete(prompt).strip()

    def speak_after_mediator(
        self,
        *,
        mediator_prompt: str,
        other_last_message: str,
        history: list[str] | None = None,
        recommended_tool: str | None = None,
        scenario: str | None = None,
    ) -> str:
        turn_number = self._speaker_turn_number(history)
        prompt = AGENT_MEDIATED_RESPONSE.format(
            speaker_name=self.profile.name,
            persona=self.profile.to_persona_context(),
            problem=self.problem,
            recommended_tool=recommended_tool or "none — focus on the mediator's understanding",
            scenario=scenario or "none — respond to what was said",
            other_last_message=other_last_message,
            mediator_prompt=mediator_prompt,
            turn_number=turn_number,
            behavioral_instructions=behavioral_instructions(
                self.profile,
                other_last_message=other_last_message,
                mediator_prompt=mediator_prompt,
                history=history,
                turn_number=turn_number,
            ),
            history=self._format_history(history),
        )
        return self.llm.complete(prompt).strip()

    def _speaker_turn_number(self, history: list[str] | None) -> int:
        if not history:
            return 1
        prefix = f"{self.profile.name}:"
        prior = sum(1 for line in history if line.startswith(prefix))
        return prior + 1

    @staticmethod
    def _format_history(history: list[str] | None) -> str:
        if not history:
            return "(none yet)"
        return "\n".join(f"- {line}" for line in history)
