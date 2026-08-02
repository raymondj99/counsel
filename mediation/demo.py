"""Run intake + conversation for a case folder.

Usage:
  python mediation/demo.py --case case1
  python mediation/demo.py --case case2 --mock --quick
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
from mediation.intake import IntakeTreeConfig, run_conversation_build, run_intake_analysis  # noqa: E402


def main() -> None:
    ensure_env_file()
    settings = load_settings()

    parser = argparse.ArgumentParser(
        description="Run intake analysis then conversation build for a case folder"
    )
    add_case_argument(parser)
    parser.add_argument("--mock", action="store_true")
    parser.add_argument("--model", default=None)
    parser.add_argument("--quick", action="store_true")
    parser.add_argument(
        "--deep",
        action="store_true",
        help="Deep tree: 3 mediator prompts, enough reply rounds for ≥10 user turns",
    )
    args = parser.parse_args()

    case = MediationCase.resolve(args.case)
    intake = case.load_intake()
    if args.quick:
        intake.tree = IntakeTreeConfig.quick()
    elif args.deep:
        intake.tree = IntakeTreeConfig.deep()

    llm = make_llm(mock=args.mock, settings=settings, model=args.model, repo_root=REPO_ROOT)

    print(f"=== Case: {case.name} ===")
    print(f"Folder: {case.path}")

    session, session_path = run_intake_analysis(
        intake,
        llm,
        session_path=case.session_path,
        case_name=case.name,
        intake_path=case.intake_path,
    )
    tree, tree_path = run_conversation_build(
        session,
        llm,
        tree_output=case.tree_path,
    )

    print_evaluation_report(tree)
    print_best_path(tree)

    print(f"\nCase: {case.name}")
    print(f"Session: {session_path}")
    print(f"Tree: {tree_path}")
    print(f"\nNavigate: python live/serve.py --case {case.name}")


if __name__ == "__main__":
    main()
