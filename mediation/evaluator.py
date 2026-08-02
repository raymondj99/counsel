"""Evaluate leaf outcomes for every conversation path in a mediation tree."""

from __future__ import annotations

import json
import re

from .llm import LLMClient
from .models import MediationTree, OutcomeScore
from .prompt_templates import EVALUATION_EVALUATE, EVALUATION_SYSTEM


class TreeEvaluator:
    """Scores each leaf path by analyzing the full conversation transcript."""

    def __init__(self, llm: LLMClient):
        self.llm = llm

    def evaluate(self, tree: MediationTree) -> MediationTree:
        """Score leaves, then backpropagate success_probability to all ancestors."""
        for path in tree.list_leaf_paths():
            leaf = tree.get_node(path)
            if not leaf.is_leaf:
                continue

            transcript = tree.transcript_for_path(path)
            score, reasoning = self._score_path(tree, transcript)
            leaf.result = score
            leaf.metadata["evaluation_reasoning"] = reasoning

        tree.propagate_success_probabilities()
        tree.evaluation = tree.build_evaluation_report()
        return tree

    def _score_path(self, tree: MediationTree, transcript: str) -> tuple[OutcomeScore, str]:
        prompt = EVALUATION_EVALUATE.format(
            problem=tree.session.problem,
            user1_name=tree.session.user1.name,
            user1_goals=", ".join(tree.session.user1.core_needs) or "none stated",
            user1_concerns=", ".join(tree.session.user1.emotional_triggers) or "none stated",
            user2_name=tree.session.user2.name,
            user2_goals=", ".join(tree.session.user2.core_needs) or "none stated",
            user2_concerns=", ".join(tree.session.user2.emotional_triggers) or "none stated",
            transcript=transcript or "(empty transcript)",
        )
        raw = self.llm.complete(prompt, system=EVALUATION_SYSTEM)
        payload = self._parse_json(raw)
        result = int(payload["result"])
        if result not in (1, -1):
            raise ValueError(f"Evaluator returned invalid result: {result!r}")
        reasoning = str(payload.get("reasoning", "")).strip()
        return result, reasoning  # type: ignore[return-value]

    @staticmethod
    def _parse_json(raw: str) -> dict:
        cleaned = raw.strip()
        fence_match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", cleaned, re.DOTALL)
        if fence_match:
            cleaned = fence_match.group(1)
        return json.loads(cleaned)
