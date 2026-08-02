"""Shared helpers for intake and conversation demos."""

from __future__ import annotations

import argparse
from pathlib import Path

from live.cases import list_cases
from .config import Settings
from .llm import LLMClient, MockLLMClient, OpenAILLMClient
from .models import MediationTree


def add_case_argument(parser: argparse.ArgumentParser, *, required: bool = True) -> None:
    available = ", ".join(list_cases()) or "case1"
    parser.add_argument(
        "--case",
        required=required,
        default="case1" if not required else None,
        help=f"Case folder under live/cases/ (available: {available})",
    )


def make_llm(
    *,
    mock: bool,
    settings: Settings,
    model: str | None,
    repo_root: Path,
) -> LLMClient:
    if mock:
        print("Using MockLLMClient (offline)")
        return MockLLMClient()
    if not settings.has_openai_key:
        raise SystemExit(
            f"OPENAI_API_KEY is not set.\n"
            f"Add your key to {repo_root / '.env'} (see config.env.example), or pass --mock."
        )
    model_name = model or settings.openai_model
    print(f"Using OpenAI model: {model_name}")
    return OpenAILLMClient(
        api_key=settings.openai_api_key,
        model=model_name,
        max_tokens=settings.openai_max_tokens,
        temperature=settings.openai_temperature,
    )


def print_evaluation_report(tree: MediationTree) -> None:
    report = tree.evaluation
    if report is None:
        print("\n=== Evaluation ===\n  (not evaluated)")
        return

    print("\n=== Branch evaluation ===")
    for branch in report.branches:
        prob = branch.success_probability
        suffix = f"  P={prob:.0%}" if prob is not None else ""
        print(
            f"  {branch.label}\n"
            f"    paths={branch.leaf_count}  +{branch.positive} / -{branch.negative}{suffix}"
        )

    print("\n=== Trajectory evaluation ===")
    for traj in report.trajectories:
        outcome = "+1" if traj.result == 1 else "-1" if traj.result == -1 else "?"
        prob = traj.success_probability
        prob_suffix = f"  P={prob:.0%}" if prob is not None else ""
        print(f"  [{outcome}]{prob_suffix}  {traj.path}")
        if traj.reasoning:
            print(f"    {traj.reasoning[:200]}{'…' if len(traj.reasoning) > 200 else ''}")


def print_best_path(tree: MediationTree) -> None:
    leaves = tree.list_leaf_paths()
    if not leaves:
        return

    def leaf_score(path: str) -> float:
        node = tree.get_node(path)
        if node.result == 1:
            return 1.0
        if node.result == -1:
            return 0.0
        return node.success_probability or 0.0

    best = max(leaves, key=leaf_score)
    print(f"\n=== Best-scoring trajectory ===\n{best}")
    transcript = tree.transcript_for_path(best)
    print(transcript[:2500] + ("…" if len(transcript) > 2500 else ""))
