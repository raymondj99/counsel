"""Data models for mediation sessions and traversable decision trees."""

from __future__ import annotations

from enum import Enum
from typing import Any, Literal, Optional
from uuid import uuid4

from pydantic import BaseModel, Field

OutcomeScore = Literal[1, -1]


class OpeningStrategy(str, Enum):
    """Three distinct opening angles derived from a user's psychology profile."""

    DIRECT = "direct"
    EMPATHETIC = "empathetic"
    NEEDS_FOCUSED = "needs_focused"


class NodeType(str, Enum):
    ROOT = "root"
    OPENING_BRANCH = "opening_branch"
    AGENT_TURN = "agent_turn"
    MEDIATOR_TRANSITION = "mediator_transition"
    MEDIATOR_PROMPT = "mediator_prompt"
    MEDIATOR_PEER_PROMPT = "mediator_peer_prompt"
    AGENT_RESPONSE = "agent_response"
    AGENT_REPLY = "agent_reply"


MEDIATOR_NODE_TYPES = frozenset(
    {
        NodeType.MEDIATOR_TRANSITION,
        NodeType.MEDIATOR_PROMPT,
        NodeType.MEDIATOR_PEER_PROMPT,
    }
)


Speaker = Literal["user1", "user2", "mediator"]


class UserInput(BaseModel):
    """Raw participant information supplied before psychology analysis."""

    name: str
    background: str
    stated_goals: list[str] = Field(default_factory=list)
    concerns: list[str] = Field(default_factory=list)


class UserProfile(BaseModel):
    """Psychology-informed persona used to initialise mediation agents."""

    name: str
    communication_style: str
    conflict_orientation: str
    emotional_triggers: list[str] = Field(default_factory=list)
    core_needs: list[str] = Field(default_factory=list)
    cognitive_patterns: list[str] = Field(default_factory=list)
    persona_summary: str

    def to_persona_context(self) -> str:
        return (
            f"Name: {self.name}\n"
            f"Communication style: {self.communication_style}\n"
            f"Conflict orientation: {self.conflict_orientation}\n"
            f"Emotional triggers: {', '.join(self.emotional_triggers) or 'none noted'}\n"
            f"Core needs: {', '.join(self.core_needs) or 'none noted'}\n"
            f"Cognitive patterns: {', '.join(self.cognitive_patterns) or 'none noted'}\n"
            f"Summary: {self.persona_summary}"
        )


class SessionInput(BaseModel):
    """Systematic input schema for building a mediation tree."""

    problem: str
    user1: UserInput
    user2: UserInput
    opening_variants: int = Field(default=3, ge=1, le=10)
    mediator_prompt_count: int = Field(default=5, ge=1, le=20)
    reply_rounds: int = Field(
        default=1,
        ge=0,
        le=8,
        description="Peer reply rounds after the mediated response (each round = both users speak once).",
    )


class Session(BaseModel):
    """A mediation session binding a shared problem to two profiled participants."""

    id: str = Field(default_factory=lambda: str(uuid4()))
    problem: str
    user1: UserProfile
    user2: UserProfile

    @classmethod
    def from_input(
        cls,
        session_input: SessionInput,
        user1_profile: UserProfile,
        user2_profile: UserProfile,
    ) -> Session:
        return cls(
            problem=session_input.problem,
            user1=user1_profile,
            user2=user2_profile,
        )


_CONTENT_NODE_TYPES = frozenset(
    {
        NodeType.ROOT,
        NodeType.AGENT_TURN,
        NodeType.MEDIATOR_TRANSITION,
        NodeType.MEDIATOR_PROMPT,
        NodeType.MEDIATOR_PEER_PROMPT,
        NodeType.AGENT_RESPONSE,
        NodeType.AGENT_REPLY,
    }
)


class TreeNode(BaseModel):
    """One node in the mediation decision tree."""

    id: str
    node_type: NodeType
    speaker: Optional[Speaker] = None
    label: str
    content: str = ""
    metadata: dict[str, Any] = Field(default_factory=dict)
    children: list[TreeNode] = Field(default_factory=list)
    result: Optional[OutcomeScore] = Field(
        default=None,
        description="Leaf outcome: 1 = positive mediation result, -1 = negative.",
    )
    success_probability: Optional[float] = Field(
        default=None,
        ge=0.0,
        le=1.0,
        description=(
            "Probability (0–1) that the conversation remains productive from this "
            "point onward, given the mediator's intervention at this node."
        ),
    )

    def add_child(self, child: TreeNode) -> TreeNode:
        self.children.append(child)
        return child

    @property
    def is_leaf(self) -> bool:
        return not self.children

    @property
    def is_mediator(self) -> bool:
        return self.node_type in MEDIATOR_NODE_TYPES

    def path_from(self, ancestor_path: str = "") -> str:
        segment = self.id if not ancestor_path else f"{ancestor_path}/{self.id}"
        return segment


class EvaluationSummary(BaseModel):
    """Aggregate scores after evaluating all leaf conversation paths."""

    total_leaves: int
    positive: int
    negative: int
    unevaluated: int
    success_rate: float = 0.0


class BranchEvaluation(BaseModel):
    """Opening-branch aggregate scores."""

    path: str
    label: str
    success_probability: float | None
    leaf_count: int
    positive: int
    negative: int


class TrajectoryEvaluation(BaseModel):
    """One fully simulated conversation path (leaf) and its outcome."""

    path: str
    result: OutcomeScore | None = None
    success_probability: float | None = None
    reasoning: str | None = None


class EvaluationReport(BaseModel):
    """Branch + trajectory evaluation written into the tree JSON."""

    summary: EvaluationSummary
    root_success_probability: float | None = None
    branches: list[BranchEvaluation] = Field(default_factory=list)
    trajectories: list[TrajectoryEvaluation] = Field(default_factory=list)


class MediationTree(BaseModel):
    """Fully built tree the mediator can traverse branch-by-branch."""

    session: Session
    root: TreeNode
    opening_variants: int
    mediator_prompt_count: int
    reply_rounds: int
    evaluation: EvaluationReport | None = None

    def get_node(self, path: str) -> TreeNode:
        if not path or path == self.root.id:
            return self.root

        parts = path.split("/")
        if parts[0] != self.root.id:
            raise KeyError(f"Unknown root segment in path: {path!r}")

        node = self.root
        for part in parts[1:]:
            matched = next((child for child in node.children if child.id == part), None)
            if matched is None:
                raise KeyError(f"No child {part!r} under path {path!r}")
            node = matched
        return node

    def get_children(self, path: str) -> list[TreeNode]:
        return self.get_node(path).children

    def get_choices(self, path: str) -> list[dict[str, Any]]:
        """Return mediator-facing choices at a node."""
        node = self.get_node(path)
        return [
            {
                "path": f"{path}/{child.id}" if path else child.id,
                "id": child.id,
                "node_type": child.node_type.value,
                "speaker": child.speaker,
                "label": child.label,
                "content_preview": child.content[:160],
                "metadata": child.metadata,
                "success_probability": child.success_probability,
            }
            for child in node.children
        ]

    def list_leaf_paths(self, path: str | None = None) -> list[str]:
        start_path = path or self.root.id
        node = self.get_node(start_path)
        if not node.children:
            return [start_path]
        leaves: list[str] = []
        for child in node.children:
            child_path = f"{start_path}/{child.id}"
            leaves.extend(self.list_leaf_paths(child_path))
        return leaves

    def nodes_on_path(self, path: str) -> list[TreeNode]:
        """Return nodes from root to the node at ``path`` (inclusive)."""
        if not path or path == self.root.id:
            return [self.root]

        parts = path.split("/")
        if parts[0] != self.root.id:
            raise KeyError(f"Unknown root segment in path: {path!r}")

        nodes = [self.root]
        current = self.root
        for part in parts[1:]:
            matched = next((child for child in current.children if child.id == part), None)
            if matched is None:
                raise KeyError(f"No child {part!r} under path {path!r}")
            nodes.append(matched)
            current = matched
        return nodes

    def transcript_for_path(self, path: str) -> str:
        """Format the full conversation along a branch for outcome evaluation."""
        lines: list[str] = []
        for node in self.nodes_on_path(path):
            if node.node_type not in _CONTENT_NODE_TYPES or not node.content.strip():
                continue

            if node.node_type == NodeType.ROOT:
                lines.append(f"Problem: {node.content.strip()}")
                continue

            speaker_label = self._speaker_label(node.speaker)
            lines.append(f"{speaker_label}: {node.content.strip()}")

        return "\n".join(lines)

    def _speaker_label(self, speaker: Optional[Speaker]) -> str:
        if speaker == "user1":
            return self.session.user1.name
        if speaker == "user2":
            return self.session.user2.name
        return "Mediator"

    def summarize_evaluation(self) -> EvaluationSummary:
        leaves = [self.get_node(path) for path in self.list_leaf_paths()]
        positive = sum(1 for node in leaves if node.result == 1)
        negative = sum(1 for node in leaves if node.result == -1)
        scored = positive + negative
        success_rate = (positive / scored) if scored else 0.0
        return EvaluationSummary(
            total_leaves=len(leaves),
            positive=positive,
            negative=negative,
            unevaluated=len(leaves) - scored,
            success_rate=round(success_rate, 4),
        )

    def build_evaluation_report(self) -> EvaluationReport:
        """Summarize branch and trajectory scores after leaf evaluation."""
        summary = self.summarize_evaluation()

        branches: list[BranchEvaluation] = []
        for child in self.root.children:
            if child.node_type != NodeType.OPENING_BRANCH:
                continue
            branch_path = f"{self.root.id}/{child.id}"
            leaf_paths = self.list_leaf_paths(branch_path)
            positive = sum(1 for path in leaf_paths if self.get_node(path).result == 1)
            negative = sum(1 for path in leaf_paths if self.get_node(path).result == -1)
            branches.append(
                BranchEvaluation(
                    path=branch_path,
                    label=child.label,
                    success_probability=child.success_probability,
                    leaf_count=len(leaf_paths),
                    positive=positive,
                    negative=negative,
                )
            )

        trajectories: list[TrajectoryEvaluation] = []
        for path in self.list_leaf_paths():
            leaf = self.get_node(path)
            trajectories.append(
                TrajectoryEvaluation(
                    path=path,
                    result=leaf.result,
                    success_probability=leaf.success_probability,
                    reasoning=leaf.metadata.get("evaluation_reasoning"),
                )
            )

        return EvaluationReport(
            summary=summary,
            root_success_probability=self.root.success_probability,
            branches=branches,
            trajectories=trajectories,
        )

    def propagate_success_probabilities(self) -> None:
        """Backpropagate leaf scores to assign success_probability on every ancestor."""
        _propagate_success_probabilities(self.root)

    def to_dict(self) -> dict[str, Any]:
        payload = self.model_dump()
        _strip_unset_scores(payload["root"])
        return payload

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> MediationTree:
        return cls.model_validate(payload)


def _propagate_success_probabilities(node: TreeNode) -> tuple[int, int]:
    """Return (positive_leaf_count, total_scored_leaf_count) for this subtree."""
    if node.is_leaf:
        if node.result == 1:
            node.success_probability = 1.0
            return 1, 1
        if node.result == -1:
            node.success_probability = 0.0
            return 0, 1
        return 0, 0

    positive = 0
    total = 0
    for child in node.children:
        child_pos, child_total = _propagate_success_probabilities(child)
        positive += child_pos
        total += child_total

    if total > 0:
        node.success_probability = round(positive / total, 4)

    return positive, total


def _strip_unset_scores(node: dict[str, Any]) -> None:
    if node.get("result") is None:
        node.pop("result", None)
    if node.get("success_probability") is None:
        node.pop("success_probability", None)
    for child in node.get("children", []):
        _strip_unset_scores(child)
