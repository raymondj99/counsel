"""Tree-guided live mediator backed by the Inworld chat API."""

from __future__ import annotations

from pathlib import Path

from mediation.config import Settings, load_settings
from mediation.prompt_templates.loader import load_text
from .inworld_client import InworldClient
from .tree_navigator import TreeNavigator, load_mediation_tree

MEDIATOR_SYSTEM = load_text("mediator", "agent_system.txt")

TREE_GUIDED_SYSTEM = (
    MEDIATOR_SYSTEM
    + "\n\nYou are facilitating a LIVE voice call. A pre-computed mediation tree "
    "has ranked intervention options by predicted success probability. Adapt the "
    "selected template to what participants actually said — do not read it verbatim "
    "if the conversation has moved. Keep replies to one or two short sentences. "
    "Stay with the conversation until a resolution is found — do not wrap up early. "
    "Reflect and clarify most turns; when they are stuck, occasionally offer a "
    "concrete suggestion they could try — not every turn. "
    "Never recap or paraphrase what was just said; one new move per turn. "
    "Reply CLOSE: when both have clearly accepted a shared plan or agreement. "
    "If the exchange is heated, treat [emotion: …] tags as information only — "
    "de-escalate and stay in the session; never pause or end the call."
)


class LiveMediator:
    """Use a serialized mediation tree to steer Inworld mediator responses."""

    def __init__(
        self,
        navigator: TreeNavigator,
        inworld: InworldClient | None,
        *,
        dry_run: bool = False,
    ):
        self.navigator = navigator
        self.inworld = inworld
        self.dry_run = dry_run

    @classmethod
    def from_tree_file(
        cls,
        tree_path: Path | str,
        settings: Settings | None = None,
        *,
        dry_run: bool = False,
    ) -> LiveMediator:
        cfg = settings or load_settings()
        navigator = TreeNavigator(load_mediation_tree(tree_path))
        inworld = None
        if not dry_run:
            inworld = InworldClient(
                api_key=cfg.inworld_api_key,
                model=cfg.inworld_model,
            )
        return cls(navigator, inworld, dry_run=dry_run)

    def consider(self, transcript: list[str], participants: list[str] | None = None) -> dict:
        """Return PASS or a tree-guided line adapted for the live transcript."""
        if participants:
            self.navigator.set_live_participants(participants)
        self.navigator.sync_transcript(transcript)

        pending = self.navigator.pending_intervention()
        if pending is None:
            return {
                "action": "pass",
                "reason": "no_pending_intervention",
                "tree": self.snapshot(),
            }

        recent = "\n".join(transcript[-30:])
        user_prompt = self._build_prompt(pending, recent)
        prompts = {
            "system": TREE_GUIDED_SYSTEM,
            "user": user_prompt,
            "path": pending["path"],
            "label": pending["label"],
            "template": pending.get("template"),
            "success_probability": pending.get("success_probability"),
            "style": pending.get("style"),
            "tree_context": pending.get("tree_context"),
        }

        reply = (
            pending["template"]
            if self.dry_run
            else self.inworld.complete(system=TREE_GUIDED_SYSTEM, user=user_prompt)
        )

        if not reply or reply.upper().startswith("PASS"):
            return {
                "action": "pass",
                "path": pending["path"],
                "label": pending["label"],
                "prompts": prompts,
                "inworld_reply": reply,
                "tree": self.snapshot(),
            }

        self.navigator.mark_spoken(pending)
        return {
            "action": "speak",
            "text": reply,
            "path": pending["path"],
            "label": pending["label"],
            "success_probability": pending.get("success_probability"),
            "template": pending.get("template"),
            "prompts": prompts,
            "inworld_reply": reply,
            "tree": self.snapshot(),
            "dry_run": self.dry_run,
        }

    def _build_prompt(self, pending: dict, recent_transcript: str) -> str:
        tree_context = pending["tree_context"]
        alternatives = tree_context.get("mediator_choices") or []
        alt_lines = []
        for choice in alternatives:
            prob = choice.get("success_probability")
            prob_label = f"{prob:.0%}" if isinstance(prob, (int, float)) else "unknown"
            alt_lines.append(
                f"- {choice['label']} (P={prob_label}): {choice.get('content_preview', '')}"
            )

        prob = pending.get("success_probability")
        prob_label = f"{prob:.0%}" if isinstance(prob, (int, float)) else "unknown"

        return (
            f"Shared problem:\n{tree_context['problem']}\n\n"
            f"Participant profiles:\n"
            f"- {tree_context['user1']['name']}: {tree_context['user1']['persona_summary']}\n"
            f"- {tree_context['user2']['name']}: {tree_context['user2']['persona_summary']}\n\n"
            f"Recent live transcript:\n{recent_transcript or '(none yet)'}\n\n"
            f"Tree position: {tree_context['current_path']} ({tree_context['current_label']})\n"
            f"Selected intervention ({pending['label']}, P={prob_label}):\n"
            f"\"{pending['template']}\"\n\n"
            f"Other ranked options from the tree:\n"
            f"{chr(10).join(alt_lines) if alt_lines else '(none)'}\n\n"
            f"Style: {pending.get('style') or 'unspecified'}\n"
            f"Optional tool: {pending.get('tool') or 'none'}\n"
            f"Optional scenario: {pending.get('scenario') or 'none'}\n\n"
            "Adapt the selected intervention for this live moment. "
            "Do not recap what participants just said — they heard it. "
            "Do not only ask them to resolve — when they are stuck, "
            "occasionally offer a concrete suggestion drawn from what they said. "
            "Stay with the conversation until they reach a resolution — do not wrap up early. "
            "If the exchange is heated, treat [emotion: …] tags as information only — "
            "de-escalate with a brief line and stay in the session; never pause or end the call. "
            "When both have clearly accepted a shared plan, reply with exactly CLOSE: and a warm closing. "
            "If speaking now would add nothing, reply with exactly PASS. "
            "Otherwise reply with only the words you would say aloud."
        )

    def snapshot(self) -> dict:
        node = self.navigator.current_node()
        return {
            "path": self.navigator.current_path,
            "node_type": node.node_type.value,
            "label": node.label,
            "success_probability": node.success_probability,
            "user1": self.navigator.user1_name,
            "user2": self.navigator.user2_name,
            "problem": self.navigator.tree.session.problem,
        }
