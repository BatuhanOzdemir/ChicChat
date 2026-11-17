"""Turning matched routing rules into a case's queue, priority and status
(SPEC §3 → §9) — port of cases/routing.ts.

Precedence is **first match wins**: rules are evaluated in the merchant's
configured order and the first one that matches decides the queue, the
priority and the resulting status. Later matches are still reported, so the
console can show the agent what else applied without silently compounding
decisions. When nothing matches, the case stays `open` in the unrouted queue —
including the Tier-0 case where rules reference computed fields no integration
has supplied yet (SPEC §2 degradation).
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, NotRequired, TypedDict

from chicchat.domain.cases.workflow import CaseStatus, Priority, constrain_priority
from chicchat.domain.jscompat import js_trim
from chicchat.domain.rules import Rule, RuleContext, evaluate_condition


class LabelledRule(Rule):
    """A rule as stored, plus the label the editor gives it (SPEC §8)."""

    id: NotRequired[str | None]
    label: NotRequired[str | None]


class MatchedRule(TypedDict):
    id: str | None
    label: str
    action_type: str


class RoutingDecision(TypedDict):
    queue: str | None
    """Target queue, or None for the unrouted/general queue."""
    priority: Priority
    status: CaseStatus
    """The status the case is created with."""
    matched: list[MatchedRule]
    """The rule that decided, then any others that also matched, in order."""


UNROUTED_QUEUE_LABEL = "unrouted"


def _status_for(action_type: str) -> CaseStatus:
    """Status implied by a rule's action. Unknown actions leave the case open."""
    if action_type == "escalate":
        return "escalated"
    if action_type == "request_info":
        return "needs_info"
    return "open"


def _describe(rule: LabelledRule, index: int) -> MatchedRule:
    label = js_trim(rule.get("label") or "")
    return {
        "id": rule.get("id"),
        "label": label or f"rule {index + 1}",
        "action_type": rule["action_type"],
    }


def decide_routing(rules: Sequence[LabelledRule], ctx: RuleContext) -> RoutingDecision:
    matched = [
        (rule, _describe(rule, index))
        for index, rule in enumerate(rules)
        if evaluate_condition(rule["condition"], ctx)
    ]
    if not matched:
        return {"queue": None, "priority": "normal", "status": "open", "matched": []}
    winner = matched[0][0]
    return {
        "queue": js_trim(winner.get("target_queue") or "") or None,
        "priority": constrain_priority(winner.get("priority")),
        "status": _status_for(winner["action_type"]),
        "matched": [described for _, described in matched],
    }


class CapturedValue(TypedDict):
    key: str
    raw: str
    normalized: str | None


def routing_context(
    category: str,
    subcategory: str | None,
    fields: Sequence[CapturedValue],
    settings: Mapping[str, Any] | None = None,
) -> RuleContext:
    """The evaluation context for a finished Tier-0 intake.

    Every captured field by its normalized value (falling back to the raw one,
    so a field that failed normalization can still be routed on), plus
    `category`/`subcategory`, which the default rules key off. Computed fields
    are absent until a connector exists.
    """
    values: dict[str, Any] = {"category": category, "subcategory": subcategory}
    for field in fields:
        normalized = field["normalized"]
        values[field["key"]] = field["raw"] if normalized is None else normalized
    context: RuleContext = {"fields": values}
    if settings is not None:
        context["config"] = dict(settings)
    return context


def describe_routing(decision: RoutingDecision) -> str:
    """One line describing a decision, for the case timeline."""
    where = decision["queue"] if decision["queue"] is not None else UNROUTED_QUEUE_LABEL
    why = (
        "no rule matched"
        if len(decision["matched"]) == 0
        else "matched " + ", ".join(m["label"] for m in decision["matched"])
    )
    return (
        f"Routed to {where} ({decision['priority']} priority, "
        f"{decision['status']}) — {why}"
    )
