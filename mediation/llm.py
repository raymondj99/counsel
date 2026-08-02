"""LLM abstraction — OpenAI default for testing, mock available offline."""

from __future__ import annotations

import hashlib
import json
import os
import re
from typing import Protocol, runtime_checkable

# Cheapest widely-available OpenAI chat model (Aug 2026).
DEFAULT_OPENAI_MODEL = "gpt-4o-mini"


@runtime_checkable
class LLMClient(Protocol):
    """Any LLM backend must implement a single completion call."""

    def complete(
        self,
        prompt: str,
        *,
        system: str | None = None,
        max_tokens: int | None = None,
    ) -> str:
        ...


class OpenAILLMClient:
    """OpenAI chat completions backend."""

    def __init__(
        self,
        *,
        api_key: str | None = None,
        model: str = DEFAULT_OPENAI_MODEL,
        max_tokens: int = 512,
        temperature: float = 0.7,
    ):
        try:
            from openai import OpenAI
        except ImportError as exc:
            raise ImportError(
                "openai is required for OpenAILLMClient. "
                "Install with: pip install openai"
            ) from exc

        key = api_key or os.environ.get("OPENAI_API_KEY")
        if not key:
            raise ValueError(
                "OpenAI API key required. Set OPENAI_API_KEY or pass api_key=."
            )

        self.client = OpenAI(api_key=key)
        self.model = model
        self.max_tokens = max_tokens
        self.temperature = temperature

    def complete(
        self,
        prompt: str,
        *,
        system: str | None = None,
        max_tokens: int | None = None,
    ) -> str:
        messages: list[dict[str, str]] = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})

        response = self.client.chat.completions.create(
            model=self.model,
            messages=messages,
            max_tokens=max_tokens if max_tokens is not None else self.max_tokens,
            temperature=self.temperature,
        )
        content = response.choices[0].message.content
        if not content:
            raise RuntimeError("OpenAI returned empty content")
        return content.strip()


class MockLLMClient:
    """Deterministic stand-in for development and tests."""

    def complete(
        self,
        prompt: str,
        *,
        system: str | None = None,
        max_tokens: int | None = None,
    ) -> str:
        digest = hashlib.sha256(f"{system or ''}{prompt}".encode()).hexdigest()
        lowered = prompt.lower()

        if "analyze this participant" in lowered:
            return self._psychology_json(prompt, digest)

        if "evaluate this mediation conversation path" in lowered:
            return self._evaluation_json(prompt, digest)

        if system and "mediation facilitator" in system.lower():
            return self._mediator_speech(prompt, digest)

        if "you are role-playing" in lowered:
            if "the mediator just said" in lowered:
                return self._mediated_speech(prompt, digest)
            return self._opening(prompt, digest)

        return f"[mock completion {digest[:8]}]"

    def _psychology_json(self, prompt: str, digest: str) -> str:
        name_match = re.search(r"Name:\s*(.+)", prompt)
        name = name_match.group(1).strip() if name_match else "Participant"

        profile = {
            "name": name,
            "communication_style": "direct and detail-oriented",
            "conflict_orientation": "collaborative with defensive spikes under stress",
            "emotional_triggers": ["feeling dismissed", "unclear expectations"],
            "core_needs": ["fairness", "clarity", "respect"],
            "cognitive_patterns": ["frames issues as process failures", "seeks concrete next steps"],
            "persona_summary": (
                f"{name} prefers structured dialogue, reacts strongly when interrupted, "
                f"and moves toward resolution when goals are explicit."
            ),
        }
        return json.dumps(profile)

    def _evaluation_json(self, prompt: str, digest: str) -> str:
        lowered = prompt.lower()
        user_lines = sum(
            1
            for line in prompt.split("\n")
            if ": " in line and not line.startswith(("Mediator:", "Problem:"))
        )
        escalatory = any(
            phrase in lowered
            for phrase in (
                "not good enough",
                "shut down",
                "same conversation",
                "nothing changed",
                "you always",
                "you never",
            )
        )
        # Long / heated trajectories skew negative so deep trees show failed paths.
        if user_lines >= 10 or escalatory:
            result = -1 if int(digest[:8], 16) % 4 != 0 else 1
        else:
            result = 1 if int(digest[:8], 16) % 2 == 0 else -1
        if result == 1:
            reasoning = (
                "Both participants moved toward understanding and showed willingness "
                "to collaborate on next steps."
            )
        else:
            reasoning = (
                "The exchange remained defensive with little mutual understanding "
                "or progress toward resolution."
            )
        return json.dumps({"result": result, "reasoning": reasoning})

    def _opening(self, prompt: str, digest: str) -> str:
        if "direct" in prompt.lower():
            return (
                "I want to address the core issue directly. "
                "Here is what I believe happened and what I need to move forward."
            )
        return f"[mock opening {digest[:8]}]"

    def _mediator_speech(self, prompt: str, digest: str) -> str:
        target_match = re.search(r"Speak to (\w+)", prompt)
        other_match = re.search(r"Invite (\w+) to", prompt)
        target = target_match.group(1) if target_match else "you"
        other = other_match.group(1) if other_match else "you"

        if "Write your spoken transition" in prompt:
            return f"{other}, I'd like to hear your perspective when you're ready."
        if "Write your spoken mediation" in prompt:
            if "summarize" in prompt.lower():
                return f"{target}, what would you add or correct in how I heard that?"
            return f"{target}, what's your response to that?"
        return "What feels most important to say from here?"

    def _mediated_speech(self, prompt: str, digest: str) -> str:
        speaker = self._extract_field(prompt, r"You are role-playing as (\w+)")
        turn_number = self._extract_turn_number(prompt)
        other_msg = self._extract_quoted_block(prompt, "The other participant said")
        history_lines = self._extract_history_lines(prompt)
        prior_lines = [ln for ln in history_lines if ln.startswith(f"{speaker}:")]

        variants = self._speech_variants(
            speaker=speaker,
            turn_number=turn_number,
            digest=digest,
        )
        for candidate in variants:
            if not self._repeats_prior(candidate, prior_lines):
                return candidate
        return variants[int(digest[:4], 16) % len(variants)]

    @staticmethod
    def _extract_field(prompt: str, pattern: str) -> str:
        match = re.search(pattern, prompt)
        return match.group(1).strip() if match else "Participant"

    @staticmethod
    def _extract_turn_number(prompt: str) -> int:
        match = re.search(r"This is turn (\d+)", prompt)
        return int(match.group(1)) if match else 1

    @staticmethod
    def _extract_quoted_block(prompt: str, label: str) -> str:
        marker = f'{label}:\n"'
        start = prompt.find(marker)
        if start == -1:
            return ""
        start += len(marker)
        end = prompt.find('"\n', start)
        return prompt[start:end] if end != -1 else prompt[start : start + 200]

    @staticmethod
    def _extract_history_lines(prompt: str) -> list[str]:
        marker = "Conversation so far:\n"
        start = prompt.find(marker)
        if start == -1:
            return []
        block = prompt[start + len(marker) :]
        end = block.find("\n\nThis is turn")
        if end != -1:
            block = block[:end]
        lines: list[str] = []
        for raw in block.split("\n"):
            line = raw.strip()
            if line.startswith("- "):
                lines.append(line[2:])
        return lines

    @staticmethod
    def _repeats_prior(candidate: str, prior_lines: list[str]) -> bool:
        normalized = candidate.strip().lower()
        if len(normalized) < 24:
            return False
        snippet = normalized[:48]
        return any(snippet in prior.split(": ", 1)[-1].lower() for prior in prior_lines)

    def _speech_variants(
        self,
        *,
        speaker: str,
        turn_number: int,
        digest: str,
    ) -> list[str]:
        seed = int(digest[:6], 16)
        name = speaker.lower()

        if name in {"john", "maya", "alex"}:
            pools = [
                [
                    "When I saw the charge without a heads-up, it felt like I was the only one holding the financial line. I need us to agree on what counts as a big purchase before the next one.",
                    "I'm not trying to audit every dollar — I need to know I won't find out from the bank app again. Can we pick a number where we check in first?",
                    "You saying you're overwhelmed doesn't erase that I was blindsided. What would checking in before buying look like for you?",
                    "Maybe we start smaller: a shared note or text before anything over two hundred. Would that feel controlling or reasonable?",
                    "I hear that you wanted the PS5 for a long time. I still need transparency — can we talk about how we define ours vs mine on discretionary stuff?",
                ],
                [
                    "I pushed back hard earlier — I'm still hurt, but I don't want us spinning. What would make you feel trusted while I still get a warning?",
                    "Fine — the Sephora dig isn't the point. The point is I found out after the fact. How do we fix that pattern, not just this purchase?",
                    "If I sound like your mom, tell me. I want a rule we both accept, not me policing you.",
                ],
            ]
        elif name in {"mary", "dev", "jordan"}:
            pools = [
                [
                    "I bought it after sitting on the decision for two years — I didn't think it was a secret purchase. I get that the timing looked bad.",
                    "When you bring up Sephora, it feels like my one thing gets judged harder. I'm willing to talk thresholds if it's mutual.",
                    "I wasn't trying to hide it — I just didn't want another lecture before I could explain. Ask me next time and I'll answer.",
                    "Work's been crushing me and I wanted something for myself. That doesn't mean your feelings about the charge don't matter.",
                    "Okay — what number should we have picked where I'd loop you in? I can agree to that if it's the same for both of us.",
                ],
                [
                    "I'm defensive because it feels like a trap. If we set a dollar limit together, I'll stick to it — but don't move the goalposts.",
                    "You're right I deflected with Sephora. Fair. Can we separate that from whether I should've told you before the PS5?",
                    "I can say I should've mentioned it before the charge posted. I'm not saying the purchase itself was wrong.",
                ],
            ]
        else:
            pools = [
                [
                    "What you said lands differently than I expected — let me try to answer the actual question.",
                    "I'm not ready to agree yet, but I can name one thing I'd need to move forward.",
                    "Can we slow down and make sure we're arguing about the same thing?",
                ],
            ]

        tier = 0 if turn_number <= 2 else 1
        pool = pools[min(tier, len(pools) - 1)]
        offset = (seed + turn_number * 7) % len(pool)
        return pool[offset:] + pool[:offset]
