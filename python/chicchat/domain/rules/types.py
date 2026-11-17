"""Rule-engine types (SPEC.md §3) — port of rules/types.ts.

A rule is condition(s) -> action. Conditions reference captured fields,
computed fields, and merchant config. These shapes match the
`routing_rules.condition` jsonb exactly, so they are TypedDicts (plain dicts
with the stored keys), not classes.
"""

from __future__ import annotations

from typing import Any, Literal, NotRequired, TypedDict

ComparisonOp = Literal[
    "eq", "neq", "gt", "gte", "lt", "lte", "in", "nin", "present", "absent"
]

ActionType = Literal["route", "auto_reply", "request_info", "escalate", "auto_resolve"]

Condition = dict[str, Any]
"""A comparison `{field, op, value? | ref?}` or a group `{all | any | not}`.

Stored configuration is untrusted, so conditions stay plain dicts and are
checked with `is_condition` before use.
"""


class RuleAction(TypedDict):
    """The outcome of a matching rule."""

    action_type: str
    target_queue: str | None
    priority: str | None
    auto_resolve: bool


class Rule(TypedDict):
    """A rule as stored in `routing_rules` (condition + flattened action fields)."""

    condition: Any
    action_type: str
    target_queue: NotRequired[str | None]
    priority: NotRequired[str | None]
    auto_resolve: NotRequired[bool]


class RuleContext(TypedDict):
    """Inputs to evaluation.

    `fields` holds captured + computed values; computed fields absent in
    zero-integration mode are simply missing (conditions on them don't match,
    per the §2 degradation rule). `config` holds merchant settings referenced
    via `ref`.
    """

    fields: dict[str, Any]
    config: NotRequired[dict[str, Any] | None]
