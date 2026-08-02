"""Builds the full mediation decision tree from systematic session input."""

from __future__ import annotations

from typing import Literal

from .agents import MediationAgent
from .llm import LLMClient
from .mediator_agent import MediatorAgent
from .models import (
    MediationTree,
    NodeType,
    OpeningStrategy,
    Session,
    SessionInput,
    TreeNode,
    UserProfile,
)
from .prompt_templates import (
    MEDIATOR_STYLES,
    MEDIATOR_STYLE_LABELS,
    OPENING_STRATEGIES,
    OPENING_STRATEGY_LABELS,
    pick_scenario_optional,
    pick_tool_optional,
)
from .psychology import PsychologyAnalyzer

SpeakerKey = Literal["user1", "user2"]


class MediationTreeBuilder:
    """
    Orchestrates psychology profiling, agent simulation, and tree assembly.

    MediatorAgent (LLM) generates natural facilitation; participant agents
    respond from their psychology profiles.
    """

    def __init__(self, llm: LLMClient):
        self.llm = llm
        self.analyzer = PsychologyAnalyzer(llm)

    def build(
        self,
        session_input: SessionInput,
        *,
        profiles: tuple[UserProfile, UserProfile] | None = None,
    ) -> MediationTree:
        if profiles is not None:
            user1_profile, user2_profile = profiles
        else:
            user1_profile, user2_profile = self.analyzer.analyze_pair(
                session_input.user1,
                session_input.user2,
            )
        session = Session.from_input(session_input, user1_profile, user2_profile)

        agent1 = MediationAgent.for_user1(user1_profile, self.llm, session.problem)
        agent2 = MediationAgent.for_user2(user2_profile, self.llm, session.problem)
        mediator = MediatorAgent.from_session(session, self.llm)

        root = TreeNode(
            id="root",
            node_type=NodeType.ROOT,
            label="Session root",
            content=session.problem,
            metadata={
                "session_id": session.id,
                "user1": user1_profile.model_dump(),
                "user2": user2_profile.model_dump(),
            },
        )

        strategies = OPENING_STRATEGIES[: session_input.opening_variants]
        prompt_count = session_input.mediator_prompt_count

        for strategy in strategies:
            self._build_user1_first_branch(
                root=root,
                session=session,
                agent1=agent1,
                agent2=agent2,
                mediator=mediator,
                strategy=strategy,
                prompt_count=prompt_count,
                reply_rounds=session_input.reply_rounds,
            )

        for strategy in strategies:
            self._build_user2_first_branch(
                root=root,
                session=session,
                agent1=agent1,
                agent2=agent2,
                mediator=mediator,
                strategy=strategy,
                prompt_count=prompt_count,
                reply_rounds=session_input.reply_rounds,
            )

        return MediationTree(
            session=session,
            root=root,
            opening_variants=session_input.opening_variants,
            mediator_prompt_count=prompt_count,
            reply_rounds=session_input.reply_rounds,
        )

    def _build_user1_first_branch(
        self,
        *,
        root: TreeNode,
        session: Session,
        agent1: MediationAgent,
        agent2: MediationAgent,
        mediator: MediatorAgent,
        strategy: OpeningStrategy,
        prompt_count: int,
        reply_rounds: int,
    ) -> None:
        branch_id = f"u1_first_{strategy.value}"
        branch = TreeNode(
            id=branch_id,
            node_type=NodeType.OPENING_BRANCH,
            speaker="user1",
            label=f"User 1 speaks first — {OPENING_STRATEGY_LABELS[strategy]}",
            metadata={"first_speaker": "user1", "opening_strategy": strategy.value},
        )
        root.add_child(branch)

        opening_text = agent1.opening(strategy)
        history = [f"{session.user1.name}: {opening_text}"]

        agent_node = TreeNode(
            id="agent1_opening",
            node_type=NodeType.AGENT_TURN,
            speaker="user1",
            label=f"{session.user1.name} opening",
            content=opening_text,
            metadata={"opening_strategy": strategy.value},
        )
        branch.add_child(agent_node)

        problem_short = self._short_problem(session.problem)
        transition_text = mediator.transition(
            speaker_name=session.user1.name,
            other_name=session.user2.name,
            problem_short=problem_short,
            history=history,
        )
        transition_node = TreeNode(
            id="mediator_transition",
            node_type=NodeType.MEDIATOR_TRANSITION,
            speaker="mediator",
            label="Mediator handoff to User 2",
            content=transition_text,
        )
        agent_node.add_child(transition_node)

        for index in range(prompt_count):
            style = MEDIATOR_STYLES[index % len(MEDIATOR_STYLES)]
            tool = pick_tool_optional(index)
            scenario = pick_scenario_optional(index)

            branch_history = history + [f"Mediator: {transition_text}"]
            intervention_text = mediator.initial_intervention(
                target_name=session.user2.name,
                other_name=session.user1.name,
                other_opening=opening_text,
                target_profile=session.user2,
                other_profile=session.user1,
                style=style,
                problem_short=problem_short,
                history=branch_history,
                tool=tool,
                scenario=scenario,
            )
            prompt_node = TreeNode(
                id=f"m2_{style.value}_{index}",
                node_type=NodeType.MEDIATOR_PROMPT,
                speaker="mediator",
                label=MEDIATOR_STYLE_LABELS[style],
                content=intervention_text,
                metadata={
                    "style": style.value,
                    "tool": tool,
                    "scenario": scenario,
                    "generated_by": "mediator_agent",
                },
            )
            transition_node.add_child(prompt_node)

            branch_history = branch_history + [f"Mediator: {intervention_text}"]
            response_text = agent2.speak_after_mediator(
                mediator_prompt=intervention_text,
                other_last_message=opening_text,
                history=branch_history,
                recommended_tool=tool,
                scenario=scenario,
            )
            branch_history.append(f"{session.user2.name}: {response_text}")

            response_node = TreeNode(
                id="user2_response",
                node_type=NodeType.AGENT_RESPONSE,
                speaker="user2",
                label=f"{session.user2.name} response",
                content=response_text,
                metadata={"style": style.value, "tool": tool},
            )
            prompt_node.add_child(response_node)

            self._append_reply_chain(
                parent=response_node,
                session=session,
                agent1=agent1,
                agent2=agent2,
                mediator=mediator,
                history=branch_history,
                first_replier="user1",
                reply_rounds=reply_rounds,
                style_offset=index + 1,
                problem_short=problem_short,
            )

    def _build_user2_first_branch(
        self,
        *,
        root: TreeNode,
        session: Session,
        agent1: MediationAgent,
        agent2: MediationAgent,
        mediator: MediatorAgent,
        strategy: OpeningStrategy,
        prompt_count: int,
        reply_rounds: int,
    ) -> None:
        branch_id = f"u2_first_{strategy.value}"
        branch = TreeNode(
            id=branch_id,
            node_type=NodeType.OPENING_BRANCH,
            speaker="user2",
            label=f"User 2 speaks first — {OPENING_STRATEGY_LABELS[strategy]}",
            metadata={"first_speaker": "user2", "opening_strategy": strategy.value},
        )
        root.add_child(branch)

        opening_text = agent2.opening(strategy)
        history = [f"{session.user2.name}: {opening_text}"]

        agent_node = TreeNode(
            id="agent2_opening",
            node_type=NodeType.AGENT_TURN,
            speaker="user2",
            label=f"{session.user2.name} opening",
            content=opening_text,
            metadata={"opening_strategy": strategy.value},
        )
        branch.add_child(agent_node)

        problem_short = self._short_problem(session.problem)
        transition_text = mediator.transition(
            speaker_name=session.user2.name,
            other_name=session.user1.name,
            problem_short=problem_short,
            history=history,
        )
        transition_node = TreeNode(
            id="mediator_transition",
            node_type=NodeType.MEDIATOR_TRANSITION,
            speaker="mediator",
            label="Mediator handoff to User 1",
            content=transition_text,
        )
        agent_node.add_child(transition_node)

        for index in range(prompt_count):
            style = MEDIATOR_STYLES[index % len(MEDIATOR_STYLES)]
            tool = pick_tool_optional(index + 2)
            scenario = pick_scenario_optional(index + 2)

            branch_history = history + [f"Mediator: {transition_text}"]
            intervention_text = mediator.initial_intervention(
                target_name=session.user1.name,
                other_name=session.user2.name,
                other_opening=opening_text,
                target_profile=session.user1,
                other_profile=session.user2,
                style=style,
                problem_short=problem_short,
                history=branch_history,
                tool=tool,
                scenario=scenario,
            )
            prompt_node = TreeNode(
                id=f"m1_{style.value}_{index}",
                node_type=NodeType.MEDIATOR_PROMPT,
                speaker="mediator",
                label=MEDIATOR_STYLE_LABELS[style],
                content=intervention_text,
                metadata={
                    "style": style.value,
                    "tool": tool,
                    "scenario": scenario,
                    "generated_by": "mediator_agent",
                },
            )
            transition_node.add_child(prompt_node)

            branch_history = branch_history + [f"Mediator: {intervention_text}"]
            response_text = agent1.speak_after_mediator(
                mediator_prompt=intervention_text,
                other_last_message=opening_text,
                history=branch_history,
                recommended_tool=tool,
                scenario=scenario,
            )
            branch_history.append(f"{session.user1.name}: {response_text}")

            response_node = TreeNode(
                id="user1_response",
                node_type=NodeType.AGENT_RESPONSE,
                speaker="user1",
                label=f"{session.user1.name} response",
                content=response_text,
                metadata={"style": style.value, "tool": tool},
            )
            prompt_node.add_child(response_node)

            self._append_reply_chain(
                parent=response_node,
                session=session,
                agent1=agent1,
                agent2=agent2,
                mediator=mediator,
                history=branch_history,
                first_replier="user2",
                reply_rounds=reply_rounds,
                style_offset=index + 1,
                problem_short=problem_short,
            )

    def _append_reply_chain(
        self,
        *,
        parent: TreeNode,
        session: Session,
        agent1: MediationAgent,
        agent2: MediationAgent,
        mediator: MediatorAgent,
        history: list[str],
        first_replier: SpeakerKey,
        reply_rounds: int,
        style_offset: int,
        problem_short: str,
    ) -> None:
        if reply_rounds <= 0:
            return

        turn_order: list[tuple[SpeakerKey, MediationAgent, str, str, str]] = [
            ("user1", agent1, session.user1.name, session.user2.name, "user1_reply"),
            ("user2", agent2, session.user2.name, session.user1.name, "user2_reply"),
        ]
        if first_replier == "user2":
            turn_order = [turn_order[1], turn_order[0]]

        parent_node = parent
        current_history = list(history)
        step_index = style_offset

        for round_num in range(1, reply_rounds + 1):
            for speaker_key, agent, name, other_name, id_prefix in turn_order:
                other_last = self._last_peer_message(current_history, speaker_name=name)
                style = MEDIATOR_STYLES[step_index % len(MEDIATOR_STYLES)]
                target_profile = session.user1 if name == session.user1.name else session.user2
                other_profile = session.user2 if name == session.user1.name else session.user1
                tool = pick_tool_optional(step_index)
                scenario = pick_scenario_optional(step_index)

                intervention_text = mediator.peer_intervention(
                    target_name=name,
                    other_name=other_name,
                    other_last_message=other_last,
                    target_profile=target_profile,
                    other_profile=other_profile,
                    style=style,
                    problem_short=problem_short,
                    history=current_history,
                    tool=tool,
                    scenario=scenario,
                )
                intervention_node = TreeNode(
                    id=f"mediator_peer_{id_prefix}_{round_num}",
                    node_type=NodeType.MEDIATOR_PEER_PROMPT,
                    speaker="mediator",
                    label=f"Mediator — {MEDIATOR_STYLE_LABELS[style]}",
                    content=intervention_text,
                    metadata={
                        "style": style.value,
                        "tool": tool,
                        "scenario": scenario,
                        "round": round_num,
                        "generated_by": "mediator_agent",
                    },
                )
                parent_node.add_child(intervention_node)
                current_history.append(f"Mediator: {intervention_text}")

                reply_text = agent.speak_after_mediator(
                    mediator_prompt=intervention_text,
                    other_last_message=other_last,
                    history=current_history,
                    recommended_tool=tool,
                    scenario=scenario,
                )
                current_history.append(f"{name}: {reply_text}")

                reply_node = TreeNode(
                    id=f"{id_prefix}_{round_num}",
                    node_type=NodeType.AGENT_REPLY,
                    speaker=speaker_key,
                    label=f"{name} reply (round {round_num})",
                    content=reply_text,
                    metadata={
                        "round": round_num,
                        "style": style.value,
                        "tool": tool,
                        "reply_to": other_last[:120],
                    },
                )
                intervention_node.add_child(reply_node)
                parent_node = reply_node
                step_index += 1

    @staticmethod
    def _last_peer_message(history: list[str], *, speaker_name: str) -> str:
        for line in reversed(history):
            if line.startswith("Mediator:"):
                continue
            if not line.startswith(f"{speaker_name}:"):
                _, _, content = line.partition(": ")
                return content
        return ""

    @staticmethod
    def _short_problem(problem: str, max_len: int = 80) -> str:
        if len(problem) <= max_len:
            return problem
        return problem[: max_len - 3].rstrip() + "..."
