"""Load and traverse a pre-built mediation tree during live sessions."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from mediation.models import MediationTree, NodeType, TreeNode

MEDIATOR_DECISION_TYPES = frozenset(
    {
        NodeType.MEDIATOR_PROMPT,
        NodeType.MEDIATOR_PEER_PROMPT,
    }
)
USER_TURN_TYPES = frozenset(
    {
        NodeType.AGENT_TURN,
        NodeType.AGENT_RESPONSE,
        NodeType.AGENT_REPLY,
    }
)
MEDIATOR_SPEAK_TYPES = frozenset(
    {
        NodeType.MEDIATOR_TRANSITION,
        NodeType.MEDIATOR_PROMPT,
        NodeType.MEDIATOR_PEER_PROMPT,
    }
)


def load_mediation_tree(path: Path | str) -> MediationTree:
    """Load a serialized tree and ensure success probabilities are present."""
    tree_path = Path(path)
    tree = MediationTree.from_dict(json.loads(tree_path.read_text()))
    if tree.root.success_probability is None:
        tree.propagate_success_probabilities()
    return tree


def _best_child(node: TreeNode) -> TreeNode | None:
    if not node.children:
        return None
    return max(node.children, key=lambda child: child.success_probability or 0.0)


class TreeNavigator:
    """Track position in a mediation tree against a live transcript."""

    def __init__(self, tree: MediationTree):
        self.tree = tree
        self.path = tree.root.id
        self.processed_lines = 0
        self._spoken_paths: set[str] = set()
        self.user1_name = tree.session.user1.name
        self.user2_name = tree.session.user2.name

    @classmethod
    def from_file(cls, path: Path | str) -> TreeNavigator:
        return cls(load_mediation_tree(path))

    def map_speaker(self, live_name: str) -> str | None:
        """Map a live participant name to user1, user2, or mediator."""
        normalized = live_name.strip().lower()
        if normalized == self.user1_name.lower():
            return "user1"
        if normalized == self.user2_name.lower():
            return "user2"
        if normalized == "mediator":
            return "mediator"
        return None

    def sync_transcript(self, lines: list[str]) -> None:
        """Advance tree position for any new transcript lines."""
        while self.processed_lines < len(lines):
            line = lines[self.processed_lines]
            self.processed_lines += 1
            self._apply_line(line)

    def _apply_line(self, line: str) -> None:
        if ":" not in line:
            return

        speaker_raw, _, text = line.partition(":")
        speaker = self.map_speaker(speaker_raw.strip())
        if speaker is None or speaker == "mediator":
            return

        self._advance_for_user_turn(speaker, text.strip())

    def _advance_for_user_turn(self, speaker: str, _text: str) -> None:
        node = self.current_node()

        if node.node_type == NodeType.ROOT:
            branch = _best_child(node)
            if branch is None:
                return
            self.path = f"{self.path}/{branch.id}"
            node = self.current_node()

        if node.node_type == NodeType.OPENING_BRANCH:
            opening = _best_child(node)
            if opening is None:
                return
            self.path = f"{self.path}/{opening.id}"
            node = self.current_node()

        if node.node_type in USER_TURN_TYPES and node.speaker == speaker:
            child = _best_child(node)
            if child is None:
                return
            self.path = f"{self.path}/{child.id}"
            return

        if node.node_type in MEDIATOR_DECISION_TYPES:
            if self.path not in self._spoken_paths:
                return
            user_child = _best_user_child_for_speaker(node, speaker)
            if user_child is None:
                return
            self.path = f"{self.path}/{user_child.id}"

    @property
    def current_path(self) -> str:
        return self.path

    def current_node(self) -> TreeNode:
        return self.tree.get_node(self.path)

    def pending_intervention(self) -> dict[str, Any] | None:
        """Return the next tree-guided mediator line, if any."""
        node = self.current_node()

        if node.node_type == NodeType.MEDIATOR_TRANSITION and self.path not in self._spoken_paths:
            return self._intervention_payload(node, reason="transition")

        if _has_mediator_choices(node):
            choice = _best_mediator_choice(node)
            if choice is None:
                return None
            choice_path = f"{self.path}/{choice.id}"
            if choice_path in self._spoken_paths:
                return None
            return self._intervention_payload(choice, reason="prompt", choice_path=choice_path)

        return None

    def mark_spoken(self, payload: dict[str, Any]) -> None:
        if payload.get("reason") == "transition":
            self._spoken_paths.add(self.path)
            return

        path = payload.get("path")
        if path:
            self._spoken_paths.add(path)
            self.path = path

    def tree_context_for_inworld(self) -> dict[str, Any]:
        """Session + branch metadata to inject into Inworld prompts."""
        node = self.current_node()
        choices = self.tree.get_choices(self.path)
        mediator_choices = [
            {
                "label": choice["label"],
                "style": (choice.get("metadata") or {}).get("style"),
                "success_probability": choice.get("success_probability"),
                "content_preview": choice.get("content_preview"),
            }
            for choice in choices
            if choice["node_type"] in {t.value for t in MEDIATOR_DECISION_TYPES}
        ]

        return {
            "problem": self.tree.session.problem,
            "user1": self.tree.session.user1.model_dump(),
            "user2": self.tree.session.user2.model_dump(),
            "current_path": self.path,
            "current_node_type": node.node_type.value,
            "current_label": node.label,
            "mediator_choices": mediator_choices,
            "current_success_probability": node.success_probability,
        }

    def _intervention_payload(
        self,
        node: TreeNode,
        *,
        reason: str,
        choice_path: str | None = None,
    ) -> dict[str, Any]:
        path = choice_path or self.path
        return {
            "path": path,
            "reason": reason,
            "label": node.label,
            "template": node.content,
            "style": node.metadata.get("style"),
            "tool": node.metadata.get("tool"),
            "scenario": node.metadata.get("scenario"),
            "success_probability": node.success_probability,
            "tree_context": self.tree_context_for_inworld(),
        }


def _has_mediator_choices(node: TreeNode) -> bool:
    return any(child.node_type in MEDIATOR_DECISION_TYPES for child in node.children)


def _best_mediator_choice(node: TreeNode) -> TreeNode | None:
    options = [child for child in node.children if child.node_type in MEDIATOR_DECISION_TYPES]
    if not options:
        return None
    return max(options, key=lambda child: child.success_probability or 0.0)


def _best_user_child_for_speaker(node: TreeNode, speaker: str) -> TreeNode | None:
    options = [
        child
        for child in node.children
        if child.node_type in USER_TURN_TYPES and child.speaker == speaker
    ]
    if not options:
        return None
    return max(options, key=lambda child: child.success_probability or 0.0)
