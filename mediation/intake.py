"""Intake form and prepared session artifacts."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from uuid import uuid4

from pydantic import BaseModel, Field, field_validator

from .builder import MediationTreeBuilder
from .evaluator import TreeEvaluator
from .llm import LLMClient
from .models import MediationTree, SessionInput, UserInput, UserProfile
from .psychology import PsychologyAnalyzer


def _coerce_list(value: str | list[str] | None) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    if isinstance(value, str):
        return [part.strip() for part in value.replace("\n", ",").split(",") if part.strip()]
    return []


class IntakePerson(BaseModel):
    """One participant's intake fields."""

    name: str
    background: str
    stated_goals: list[str] = Field(default_factory=list)
    concerns: list[str] = Field(default_factory=list)

    @field_validator("stated_goals", "concerns", mode="before")
    @classmethod
    def normalize_lists(cls, value: Any) -> list[str]:
        return _coerce_list(value)

    def to_user_input(self) -> UserInput:
        return UserInput(
            name=self.name.strip(),
            background=self.background.strip(),
            stated_goals=self.stated_goals,
            concerns=self.concerns,
        )


class IntakeTreeConfig(BaseModel):
    """Controls how large the decision tree grows."""

    opening_variants: int = Field(default=3, ge=1, le=10)
    mediator_prompt_count: int = Field(default=5, ge=1, le=20)
    reply_rounds: int = Field(default=2, ge=0, le=8)

    @classmethod
    def quick(cls) -> IntakeTreeConfig:
        return cls(opening_variants=1, mediator_prompt_count=2, reply_rounds=1)

    @classmethod
    def deep(cls, *, min_user_turns: int = 10) -> IntakeTreeConfig:
        """Deep conversation preset: ≥min_user_turns participant lines per trajectory."""
        # User lines per path = 2 (opening + first response) + 2 * reply_rounds
        needed_rounds = max(1, (min_user_turns - 2 + 1) // 2)
        reply_rounds = min(needed_rounds, 8)
        return cls(opening_variants=1, mediator_prompt_count=3, reply_rounds=reply_rounds)

    @property
    def user_turns_per_path(self) -> int:
        return 2 + 2 * self.reply_rounds


class IntakeForm(BaseModel):
    """
    Raw intake submitted before psychology analysis.

    Lives at ``live/cases/<name>/intake.json``.
    """

    problem: str
    user1: IntakePerson
    user2: IntakePerson
    tree: IntakeTreeConfig = Field(default_factory=IntakeTreeConfig)

    @classmethod
    def from_json_file(cls, path: Path | str) -> IntakeForm:
        payload = json.loads(Path(path).read_text())
        return cls.model_validate(payload)

    def write_json(self, path: Path | str) -> Path:
        out = Path(path)
        out.write_text(json.dumps(self.model_dump(), indent=2) + "\n")
        return out


class PreparedSession(BaseModel):
    """
    Output of the intake demo — psychology profiles ready for tree building.

    Lives at ``live/cases/<name>/session.json``.
    """

    id: str = Field(default_factory=lambda: str(uuid4()))
    problem: str
    user1: UserProfile
    user2: UserProfile
    tree: IntakeTreeConfig = Field(default_factory=IntakeTreeConfig)
    case: str | None = None
    intake_source: str | None = None

    def to_session_input(self) -> SessionInput:
        return SessionInput(
            problem=self.problem,
            user1=UserInput(
                name=self.user1.name,
                background=self.user1.persona_summary,
                stated_goals=self.user1.core_needs,
                concerns=self.user1.emotional_triggers,
            ),
            user2=UserInput(
                name=self.user2.name,
                background=self.user2.persona_summary,
                stated_goals=self.user2.core_needs,
                concerns=self.user2.emotional_triggers,
            ),
            opening_variants=self.tree.opening_variants,
            mediator_prompt_count=self.tree.mediator_prompt_count,
            reply_rounds=self.tree.reply_rounds,
        )

    @classmethod
    def from_json_file(cls, path: Path | str) -> PreparedSession:
        payload = json.loads(Path(path).read_text())
        return cls.model_validate(payload)

    def write_json(self, path: Path | str) -> Path:
        out = Path(path)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(self.model_dump(), indent=2) + "\n")
        return out


def resolve_repo_path(relative_or_absolute: str, repo_root: Path) -> Path:
    path = Path(relative_or_absolute)
    if path.is_absolute():
        return path
    return repo_root / path


def run_intake_analysis(
    intake: IntakeForm,
    llm: LLMClient,
    *,
    session_path: Path,
    case_name: str | None = None,
    intake_path: Path | None = None,
) -> tuple[PreparedSession, Path]:
    """Analyze intake forms and save psychology profiles."""
    analyzer = PsychologyAnalyzer(llm)
    user1_profile, user2_profile = analyzer.analyze_pair(
        intake.user1.to_user_input(),
        intake.user2.to_user_input(),
    )

    session = PreparedSession(
        problem=intake.problem.strip(),
        user1=user1_profile,
        user2=user2_profile,
        tree=intake.tree,
        case=case_name,
        intake_source=str(intake_path) if intake_path else None,
    )

    session_path.parent.mkdir(parents=True, exist_ok=True)
    session.write_json(session_path)

    print(f"\n{user1_profile.name}:")
    print(f"  {user1_profile.persona_summary}")
    print(f"\n{user2_profile.name}:")
    print(f"  {user2_profile.persona_summary}")
    print(f"\nSession saved to {session_path}")
    if case_name:
        print(f"Next: python mediation/demo_conversation.py --case {case_name}")
    return session, session_path


def run_conversation_build(
    session: PreparedSession,
    llm: LLMClient,
    *,
    tree_output: Path,
) -> tuple[MediationTree, Path]:
    """Build conversation tree, evaluate branches/trajectories, and save."""
    session_input = session.to_session_input()
    tree_output.parent.mkdir(parents=True, exist_ok=True)

    print("\n=== Building conversation tree ===")
    builder = MediationTreeBuilder(llm)
    tree = builder.build(
        session_input,
        profiles=(session.user1, session.user2),
    )
    print(f"  Opening variants: {tree.opening_variants} per side")
    print(f"  Mediator prompts: {tree.mediator_prompt_count} per branch")
    print(f"  Peer reply rounds: {tree.reply_rounds}")
    print(f"  Leaf paths: {len(tree.list_leaf_paths())}")
    user_turns = 2 + 2 * tree.reply_rounds
    print(f"  User turns per trajectory: {user_turns}")

    print("\n=== Evaluating branches and trajectories ===")
    tree = TreeEvaluator(llm).evaluate(tree)
    report = tree.evaluation
    assert report is not None
    summary = report.summary
    print(f"  Positive trajectories: {summary.positive}")
    print(f"  Negative trajectories: {summary.negative}")
    print(f"  Success rate: {summary.success_rate:.0%}")
    if report.root_success_probability is not None:
        print(f"  Root P(productive): {report.root_success_probability:.0%}")
    for branch in report.branches:
        prob = branch.success_probability
        suffix = f"  P={prob:.0%}" if prob is not None else ""
        print(
            f"  Branch {branch.label}: {branch.positive}+ / {branch.negative}- "
            f"({branch.leaf_count} paths){suffix}"
        )

    tree_output.write_text(json.dumps(tree.to_dict(), indent=2))
    print(f"\nTree written to {tree_output}")
    return tree, tree_output
