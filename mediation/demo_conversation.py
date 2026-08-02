"""Conversation demo — build mediation tree from a prepared session.

Usage:
  python mediation/demo_conversation.py --case case1
  python mediation/demo_conversation.py --case case1 --quick --mock
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from mediation import ensure_env_file, load_settings  # noqa: E402
from live.cases import MediationCase  # noqa: E402
from mediation.demo_utils import add_case_argument, make_llm, print_best_path, print_evaluation_report  # noqa: E402
from mediation.intake import IntakeTreeConfig, run_conversation_build  # noqa: E402


def main() -> None:
    ensure_env_file()
    settings = load_settings()

    parser = argparse.ArgumentParser(
        description="Build and evaluate a conversation tree from a prepared session"
    )
    add_case_argument(parser)
    parser.add_argument("--mock", action="store_true", help="Offline mock LLM")
    parser.add_argument("--model", default=None, help="OpenAI model override")
    parser.add_argument(
        "--quick",
        action="store_true",
        help="Smaller tree: 1 opening, 2 mediator prompts, 1 reply round",
    )
    parser.add_argument(
        "--deep",
        action="store_true",
        help="Deep tree: 3 mediator prompts, enough reply rounds for ≥10 user turns",
    )
    args = parser.parse_args()

    case = MediationCase.resolve(args.case)
    session = case.load_session()
    if args.quick:
        session.tree = IntakeTreeConfig.quick()
    elif args.deep:
        session.tree = IntakeTreeConfig.deep()

    llm = make_llm(mock=args.mock, settings=settings, model=args.model, repo_root=REPO_ROOT)

    print(f"=== Case: {case.name} ===")
    print(f"Problem: {session.problem[:120]}{'…' if len(session.problem) > 120 else ''}")
    print(f"User 1: {session.user1.name}")
    print(f"User 2: {session.user2.name}")
    print(f"Tree output: {case.tree_path}")

    tree, output_path = run_conversation_build(
        session,
        llm,
        tree_output=case.tree_path,
    )

    print_evaluation_report(tree)
    print_best_path(tree)

    print(f"\nDone. Navigate with: python live/serve.py --case {case.name}")


if __name__ == "__main__":
    main()
