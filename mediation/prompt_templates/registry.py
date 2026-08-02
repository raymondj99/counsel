"""Prompt registry — loads templates and exposes format helpers."""

from __future__ import annotations

from enum import Enum
from typing import TYPE_CHECKING

from ..models import OpeningStrategy
from .loader import load_lines, load_text

if TYPE_CHECKING:
    from ..models import UserProfile

MEDIATOR_TRANSITION = load_text("mediator", "transition.txt")
MEDIATOR_INITIAL = load_text("mediator", "initial_intervention.txt")
MEDIATOR_PEER = load_text("mediator", "peer_intervention.txt")

AGENT_OPENING = load_text("agent", "opening.txt")
AGENT_MEDIATED_RESPONSE = load_text("agent", "mediated_response.txt")

PSYCHOLOGY_SYSTEM = load_text("psychology", "system.txt")
PSYCHOLOGY_ANALYZE = load_text("psychology", "analyze.txt")

EVALUATION_SYSTEM = load_text("evaluation", "system.txt")
EVALUATION_EVALUATE = load_text("evaluation", "evaluate.txt")

MEDIATION_TOOLS = load_lines("data", "tools.txt")
SCENARIO_PROMPTS = load_lines("data", "scenarios.txt")


class MediatorStyle(str, Enum):
    REFLECTIVE = "reflective"
    CLARIFYING = "clarifying"
    REFRAME = "reframe"
    SUMMARIZE = "summarize"
    FUTURE_FOCUS = "future_focus"


MEDIATOR_STYLES: list[MediatorStyle] = [
    MediatorStyle.REFLECTIVE,
    MediatorStyle.CLARIFYING,
    MediatorStyle.REFRAME,
    MediatorStyle.SUMMARIZE,
    MediatorStyle.FUTURE_FOCUS,
]

MEDIATOR_STYLE_LABELS: dict[MediatorStyle, str] = {
    MediatorStyle.REFLECTIVE: "Reflective — name what landed emotionally",
    MediatorStyle.CLARIFYING: "Clarifying — understand before responding",
    MediatorStyle.REFRAME: "Reframe — surface underlying needs",
    MediatorStyle.SUMMARIZE: "Summarize — check the shared picture",
    MediatorStyle.FUTURE_FOCUS: "Future focus — identify a next step",
}


def _load_opening_strategy_labels() -> dict[OpeningStrategy, str]:
    labels: dict[OpeningStrategy, str] = {}
    for line in load_lines("data", "opening_strategies.txt"):
        key, _, label = line.partition("|")
        labels[OpeningStrategy(key.strip())] = label.strip()
    return labels


OPENING_STRATEGY_LABELS = _load_opening_strategy_labels()
OPENING_STRATEGIES = list(OPENING_STRATEGY_LABELS.keys())


def perspective_summary(profile: UserProfile) -> str:
    needs = ", ".join(profile.core_needs) or "to feel understood"
    triggers = ", ".join(profile.emotional_triggers[:2]) or "feeling dismissed"
    return (
        f"{profile.name} communicates in a {profile.communication_style} way, "
        f"especially needs {needs}, and is sensitive to {triggers}. "
        f"{profile.persona_summary}"
    )


def style_instruction(style: MediatorStyle, *, other_name: str, problem_short: str = "") -> str:
    if style == MediatorStyle.SUMMARIZE:
        return load_text("mediator", "styles", "summarize.txt").format(
            other_name=other_name,
            problem_short=problem_short,
        )
    return load_text("mediator", "styles", f"{style.value}.txt").format(other_name=other_name)


def pick_tool(index: int) -> str:
    return MEDIATION_TOOLS[index % len(MEDIATION_TOOLS)]


def pick_scenario(index: int) -> str:
    return SCENARIO_PROMPTS[index % len(SCENARIO_PROMPTS)]


def pick_tool_optional(index: int) -> str | None:
    """Offer a tool on roughly half of turns — not every intervention."""
    if index % 2 == 0:
        return pick_tool(index)
    return None


def pick_scenario_optional(index: int) -> str | None:
    """Offer a scenario on a different subset — sometimes neither tool nor scenario."""
    if index % 3 == 1:
        return pick_scenario(index)
    return None


def format_tool_block(tool: str | None) -> str:
    if not tool:
        return ""
    return f"\nIf it feels useful, one tool we could try together: {tool}\n"


def format_scenario_block(scenario: str | None) -> str:
    if not scenario:
        return ""
    return f"\nYou might also take a quiet moment to imagine: {scenario}\n"


def format_transition(
    *,
    speaker_name: str,
    other_name: str,
    problem_short: str,
) -> str:
    return MEDIATOR_TRANSITION.format(
        speaker_name=speaker_name,
        other_name=other_name,
        problem_short=problem_short,
    )


def format_initial_intervention(
    *,
    target_name: str,
    other_name: str,
    problem_short: str,
    style: MediatorStyle,
    target_profile: UserProfile,
    other_profile: UserProfile,
    tool: str | None = None,
    scenario: str | None = None,
) -> str:
    return MEDIATOR_INITIAL.format(
        target_name=target_name,
        other_name=other_name,
        problem_short=problem_short,
        other_perspective=perspective_summary(other_profile),
        target_perspective=perspective_summary(target_profile),
        style_instruction=style_instruction(style, other_name=other_name, problem_short=problem_short),
        tool_block=format_tool_block(tool),
        scenario_block=format_scenario_block(scenario),
    )


def format_peer_intervention(
    *,
    target_name: str,
    other_name: str,
    other_last_message: str,
    style: MediatorStyle,
    target_profile: UserProfile,
    other_profile: UserProfile,
    tool: str | None = None,
    scenario: str | None = None,
    problem_short: str = "",
) -> str:
    return MEDIATOR_PEER.format(
        target_name=target_name,
        other_name=other_name,
        other_last_message=other_last_message,
        understanding_of_other=(
            f"{other_name} may be expressing {other_profile.conflict_orientation}; "
            f"core needs around {', '.join(other_profile.core_needs[:2]) or 'being understood'}."
        ),
        understanding_of_target=(
            f"you may be feeling the weight of {', '.join(target_profile.emotional_triggers[:2]) or 'this conflict'} "
            f"given your need for {', '.join(target_profile.core_needs[:2]) or 'fairness'}."
        ),
        style_instruction=style_instruction(style, other_name=other_name, problem_short=problem_short),
        tool_block=format_tool_block(tool),
        scenario_block=format_scenario_block(scenario),
    )
