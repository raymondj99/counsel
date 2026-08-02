"""Profile-driven behavioral instructions for mediation participant agents."""

from __future__ import annotations

import re

from .models import UserProfile

_AVOIDANT_MARKERS = ("avoidant", "indirect", "withdraw", "withdrawal", "deflect")
_ACKNOWLEDGMENT_TERMS = (
    "recogni",
    "acknowledg",
    "valid",
    "appreciat",
    "unpaid",
    "contribution",
    "effort",
    "valued",
    "labor",
    "labour",
    "work you do",
    "weight of",
    "division of",
    "split ",
    "transparen",
)
_WEAK_ACK_PHRASES = (
    "hear you",
    "heard you",
    "i understand",
    "i get it",
    "i appreciate",
)
_VAGUE_DEFLECTION_TERMS = (
    "maybe we can",
    "i guess",
    "i'll try",
    "when i can",
    "if i can",
    "not sure",
    "overwhelmed",
    "stressed",
    "work has been",
    "longer hours",
    "need time",
    "talk later",
    "figure it out",
)


def _profile_text(profile: UserProfile) -> str:
    return " ".join(
        [
            profile.communication_style,
            profile.conflict_orientation,
            profile.persona_summary,
            " ".join(profile.cognitive_patterns),
        ]
    ).lower()


def is_avoidant_profile(profile: UserProfile) -> bool:
    text = _profile_text(profile)
    return any(marker in text for marker in _AVOIDANT_MARKERS)


def _trigger_keywords(profile: UserProfile) -> list[str]:
    keywords: list[str] = []
    for phrase in profile.emotional_triggers + profile.core_needs:
        for token in re.findall(r"[a-z]{4,}", phrase.lower()):
            if token not in {
                "feeling",
                "being",
                "their",
                "with",
                "from",
                "that",
                "this",
                "have",
                "when",
                "into",
                "about",
            }:
                keywords.append(token)
    return list(dict.fromkeys(keywords))


def triggers_feel_unaddressed(
    profile: UserProfile,
    *,
    other_last_message: str = "",
    mediator_prompt: str = "",
    history: list[str] | None = None,
) -> bool:
    """Heuristic: core triggers/needs are not reflected in the latest exchange."""
    if not profile.emotional_triggers and not profile.core_needs:
        return False

    latest = f"{other_last_message} {mediator_prompt}".lower()
    if not latest.strip() and not history:
        return False

    keywords = _trigger_keywords(profile)
    if not keywords:
        return False

    hits = sum(1 for kw in keywords if kw in latest)
    min_hits = max(1, len(keywords) // 3)
    # Only the other person's reply and mediator move count as acknowledgment —
    # not the speaker's own earlier lines in history.
    strong_ack = any(term in latest for term in _ACKNOWLEDGMENT_TERMS) or any(
        phrase in latest
        for phrase in ("feel seen", "feeling seen", "blindsided", "without telling", "hear how")
    )
    weak_ack_only = (
        any(phrase in latest for phrase in _WEAK_ACK_PHRASES) and not strong_ack
    )
    needs_acknowledged = strong_ack or (hits >= min_hits and not weak_ack_only)

    other_lower = other_last_message.lower()
    other_deflects = any(term in other_lower for term in _VAGUE_DEFLECTION_TERMS)
    other_self_focused = (
        other_lower.count(" i ") + other_lower.count("i'm") + other_lower.count("my ")
        > other_lower.count("you") + other_lower.count("your ") + 1
    )

    if not needs_acknowledged and (other_deflects or other_self_focused or weak_ack_only):
        return True

    return False


def avoidant_instructions(*, is_opening: bool) -> str:
    if is_opening:
        return (
            "You tend to avoid direct conflict. Open indirectly: minimize the problem, "
            "focus on external stressors (work, fatigue), or frame things as temporary. "
            "Do not lead with emotional honesty or concrete commitments."
        )
    return (
        "You are avoidant under pressure. Do NOT agree quickly or offer tidy compromises.\n"
        "- Deflect: stay vague, change subject, or answer a different question than the one asked\n"
        "- Withdraw: go short, say you need time, or that you can't talk about this right now\n"
        "- Minimize: downplay the conflict ('it's not that bad', 'we'll figure it out later')\n"
        "- Resist concrete plans unless your core stress is explicitly acknowledged first\n"
        "- Avoid validating language that feels performative — a brief 'I hear you' then pivot away is in character\n"
        "Do not end with enthusiastic teamwork or a neat chore list unless you have genuinely shifted."
    )


def escalation_instructions(profile: UserProfile) -> str:
    triggers = ", ".join(profile.emotional_triggers[:4]) or "your sensitivities"
    needs = ", ".join(profile.core_needs[:4]) or "your core needs"
    return (
        f"The last exchange did NOT adequately address what matters to you ({needs}). "
        f"Your triggers ({triggers}) are active.\n"
        "Escalate in character — do not soften or accept vague reassurance:\n"
        "- Name what was skipped or glossed over; reference a past example if that fits your pattern\n"
        "- Push back on deflection, empty empathy, or chore-list talk that ignores your underlying need\n"
        "- Sound more frustrated, hurt, or sharp — not abusive, but clearly less cooperative\n"
        "- Reject 'we'll figure it out' without specifics; demand recognition, not just process\n"
        "Do not default to gratitude, compromise, or 'let's make a list' this turn."
    )


def baseline_instructions(profile: UserProfile) -> str:
    return (
        f"Stay fully in character as {profile.name}. "
        f"Let your conflict orientation ({profile.conflict_orientation}) and "
        f"communication style ({profile.communication_style}) drive word choice. "
        "Do not perform harmony or conflict for its own sake."
    )


def behavioral_instructions(
    profile: UserProfile,
    *,
    is_opening: bool = False,
    other_last_message: str = "",
    mediator_prompt: str = "",
    history: list[str] | None = None,
    turn_number: int = 1,
) -> str:
    """Compose persona-specific guidance injected into agent prompts."""
    parts = [baseline_instructions(profile)]

    if is_avoidant_profile(profile):
        parts.append(avoidant_instructions(is_opening=is_opening))

    if not is_opening and turn_number <= 2 and triggers_feel_unaddressed(
        profile,
        other_last_message=other_last_message,
        mediator_prompt=mediator_prompt,
        history=history,
    ):
        parts.append(escalation_instructions(profile))
    elif not is_opening and turn_number >= 3:
        parts.append(
            "Later in the conversation: do not repeat your earlier lines verbatim. "
            "Build on what was just said — add a new detail, ask a question, name a "
            "specific next step, or shift tone if the exchange is stuck."
        )

    return "\n\n".join(parts)
