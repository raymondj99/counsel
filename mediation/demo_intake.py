"""Intake demo — analyze participant forms and save psychology profiles.

Usage:
  python mediation/demo_intake.py --case case1
  python mediation/demo_intake.py --new-case case3
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from mediation import ensure_env_file, load_settings  # noqa: E402
from live.cases import MediationCase  # noqa: E402
from mediation.demo_utils import add_case_argument, make_llm  # noqa: E402
from mediation.intake import run_intake_analysis  # noqa: E402


def main() -> None:
    ensure_env_file()
    settings = load_settings()

    parser = argparse.ArgumentParser(
        description="Run intake analysis and save prepared session profiles"
    )
    add_case_argument(parser, required=False)
    parser.add_argument(
        "--new-case",
        metavar="NAME",
        help="Create live/cases/NAME/ from _template and exit",
    )
    parser.add_argument("--mock", action="store_true", help="Offline mock LLM")
    parser.add_argument("--model", default=None, help="OpenAI model override")
    args = parser.parse_args()

    if args.new_case:
        case = MediationCase.create_from_template(args.new_case)
        print(f"Created case folder: {case.path}")
        print(f"Edit {case.intake_path}, then run:")
        print(f"  python mediation/demo_intake.py --case {case.name}")
        return

    case = MediationCase.resolve(args.case)
    intake = case.load_intake()
    llm = make_llm(mock=args.mock, settings=settings, model=args.model, repo_root=REPO_ROOT)

    print(f"=== Case: {case.name} ===")
    print(f"Problem: {intake.problem[:120]}{'…' if len(intake.problem) > 120 else ''}")
    print(f"User 1: {intake.user1.name}")
    print(f"User 2: {intake.user2.name}")
    print(f"Session output: {case.session_path}")

    run_intake_analysis(
        intake,
        llm,
        session_path=case.session_path,
        case_name=case.name,
        intake_path=case.intake_path,
    )


if __name__ == "__main__":
    main()
