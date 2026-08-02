"""LLM-driven mediator agent — generates natural facilitation speech."""

from __future__ import annotations

from .llm import LLMClient
from .models import Session, UserProfile
from .prompt_templates import (
    MEDIATOR_STYLE_LABELS,
    MediatorStyle,
    perspective_summary,
    style_instruction,
)
from .prompt_templates.loader import load_text

MEDIATOR_SYSTEM = load_text("mediator", "agent_system.txt")
GENERATE_TRANSITION = load_text("mediator", "generate_transition.txt")
GENERATE_INITIAL = load_text("mediator", "generate_initial.txt")
GENERATE_PEER = load_text("mediator", "generate_peer.txt")

# Keep mediator turns short at the token level as well as in prompts.
MEDIATOR_MAX_TOKENS = 120


class MediatorAgent:
    """Agent embodying the session mediator."""

    def __init__(
        self,
        llm: LLMClient,
        *,
        problem: str,
        user1: UserProfile,
        user2: UserProfile,
    ):
        self.llm = llm
        self.problem = problem
        self.user1 = user1
        self.user2 = user2

    @classmethod
    def from_session(cls, session: Session, llm: LLMClient) -> MediatorAgent:
        return cls(llm, problem=session.problem, user1=session.user1, user2=session.user2)

    def transition(
        self,
        *,
        speaker_name: str,
        other_name: str,
        problem_short: str,
        history: list[str] | None = None,
    ) -> str:
        prompt = GENERATE_TRANSITION.format(
            problem=self.problem,
            history=self._format_history(history),
            speaker_name=speaker_name,
            other_name=other_name,
        )
        return self.llm.complete(
            prompt, system=MEDIATOR_SYSTEM, max_tokens=MEDIATOR_MAX_TOKENS
        ).strip()

    def initial_intervention(
        self,
        *,
        target_name: str,
        other_name: str,
        other_opening: str,
        target_profile: UserProfile,
        other_profile: UserProfile,
        style: MediatorStyle,
        problem_short: str,
        history: list[str] | None = None,
        tool: str | None = None,
        scenario: str | None = None,
    ) -> str:
        prompt = GENERATE_INITIAL.format(
            problem=self.problem,
            user1_name=self.user1.name,
            user1_perspective=perspective_summary(self.user1),
            user2_name=self.user2.name,
            user2_perspective=perspective_summary(self.user2),
            history=self._format_history(history),
            target_name=target_name,
            other_name=other_name,
            other_opening=other_opening,
            style_label=MEDIATOR_STYLE_LABELS[style],
            style_instruction=style_instruction(
                style, other_name=other_name, problem_short=problem_short
            ),
            tool_instruction=tool or "none — do not mention a tool this turn",
            scenario_instruction=scenario or "none — do not mention a scenario this turn",
        )
        return self.llm.complete(
            prompt, system=MEDIATOR_SYSTEM, max_tokens=MEDIATOR_MAX_TOKENS
        ).strip()

    def peer_intervention(
        self,
        *,
        target_name: str,
        other_name: str,
        other_last_message: str,
        target_profile: UserProfile,
        other_profile: UserProfile,
        style: MediatorStyle,
        problem_short: str,
        history: list[str] | None = None,
        tool: str | None = None,
        scenario: str | None = None,
    ) -> str:
        prompt = GENERATE_PEER.format(
            problem=self.problem,
            user1_name=self.user1.name,
            user1_perspective=perspective_summary(self.user1),
            user2_name=self.user2.name,
            user2_perspective=perspective_summary(self.user2),
            history=self._format_history(history),
            target_name=target_name,
            other_name=other_name,
            other_last_message=other_last_message,
            understanding_of_other=(
                f"{other_name} — {other_profile.conflict_orientation}; "
                f"needs: {', '.join(other_profile.core_needs[:2]) or 'to be understood'}"
            ),
            understanding_of_target=(
                f"{target_name} — sensitive to "
                f"{', '.join(target_profile.emotional_triggers[:2]) or 'feeling dismissed'}; "
                f"needs: {', '.join(target_profile.core_needs[:2]) or 'fairness'}"
            ),
            style_label=MEDIATOR_STYLE_LABELS[style],
            style_instruction=style_instruction(
                style, other_name=other_name, problem_short=problem_short
            ),
            tool_instruction=tool or "none — do not mention a tool this turn",
            scenario_instruction=scenario or "none — do not mention a scenario this turn",
        )
        return self.llm.complete(
            prompt, system=MEDIATOR_SYSTEM, max_tokens=MEDIATOR_MAX_TOKENS
        ).strip()

    @staticmethod
    def _format_history(history: list[str] | None) -> str:
        if not history:
            return "(none yet)"
        return "\n".join(f"- {line}" for line in history)
