"""Pure rule evaluation (SPEC.md §3) — port of rules/evaluate.ts.

`evaluate(rule, context) -> action`. Evaluation never raises on missing data —
a condition referencing a field that isn't present (e.g. a computed field with
no integration) simply doesn't match, so the case still forms and routes with
less context (§2 degradation).
"""

from __future__ import annotations

import math
from collections.abc import Iterable
from typing import Any

from chicchat.domain.jscompat import (
    is_js_number,
    js_includes,
    js_number,
    js_strict_equal,
    js_trim,
)
from chicchat.domain.rules.types import Rule, RuleAction, RuleContext
from chicchat.domain.rules.validate import is_condition


def _is_group(condition: dict[str, Any]) -> bool:
    return "all" in condition or "any" in condition or "not" in condition


def _to_number(value: object) -> float | None:
    if is_js_number(value):
        number = float(value)  # type: ignore[arg-type]
        return None if math.isnan(number) else number
    if isinstance(value, str) and js_trim(value) != "":
        number = js_number(value)
        return None if math.isnan(number) else number
    return None


def _is_present(value: object) -> bool:
    return value is not None and value != ""


_MISSING = object()


def _evaluate_comparison(cmp: dict[str, Any], ctx: RuleContext) -> bool:
    # A missing field is `undefined` in JavaScript: distinct from null for eq.
    actual: object = ctx["fields"].get(cmp["field"], _MISSING)
    op = cmp["op"]

    if op == "present":
        return actual is not _MISSING and _is_present(actual)
    if op == "absent":
        return actual is _MISSING or not _is_present(actual)

    if "ref" in cmp:
        config = ctx.get("config") or {}
        expected: object = config.get(cmp["ref"], _MISSING)
    else:
        expected = cmp.get("value", _MISSING)

    if op in ("eq", "neq"):
        same = (actual is _MISSING and expected is _MISSING) or (
            actual is not _MISSING
            and expected is not _MISSING
            and js_strict_equal(actual, expected)
        )
        return same if op == "eq" else not same
    if op in ("in", "nin"):
        if not isinstance(expected, list):
            return False
        # `undefined` is never an element of a JSON array.
        found = actual is not _MISSING and js_includes(expected, actual)
        return found if op == "in" else not found
    if op in ("gt", "gte", "lt", "lte"):
        a = _to_number(None if actual is _MISSING else actual)
        e = _to_number(None if expected is _MISSING else expected)
        if a is None or e is None:
            return False
        if op == "gt":
            return a > e
        if op == "gte":
            return a >= e
        if op == "lt":
            return a < e
        return a <= e
    return False


def _evaluate_validated(condition: dict[str, Any], ctx: RuleContext) -> bool:
    if _is_group(condition):
        # After validation the group value is a list/dict: truthy in JavaScript
        # even when empty, so test for the key, not the value's truthiness.
        if "all" in condition:
            return all(_evaluate_validated(c, ctx) for c in condition["all"])
        if "any" in condition:
            return any(_evaluate_validated(c, ctx) for c in condition["any"])
        if "not" in condition:
            return not _evaluate_validated(condition["not"], ctx)
        return True
    return _evaluate_comparison(condition, ctx)


def evaluate_condition(condition: object, ctx: RuleContext) -> bool:
    """Evaluate a condition tree to a boolean. Empty `all` groups match."""
    if not is_condition(condition):
        return False
    assert isinstance(condition, dict)
    return _evaluate_validated(condition, ctx)


def _to_action(rule: Rule) -> RuleAction:
    target_queue = rule.get("target_queue")
    priority = rule.get("priority")
    auto_resolve = rule.get("auto_resolve")
    return {
        "action_type": rule["action_type"],
        "target_queue": target_queue,
        "priority": priority,
        "auto_resolve": False if auto_resolve is None else auto_resolve,
    }


def evaluate(rule: Rule, ctx: RuleContext) -> RuleAction | None:
    """Evaluate a single rule: its action when the condition matches, else None."""
    return _to_action(rule) if evaluate_condition(rule["condition"], ctx) else None


def evaluate_rules(rules: Iterable[Rule], ctx: RuleContext) -> list[RuleAction]:
    """Actions of every matching rule, in input order."""
    return [
        _to_action(rule) for rule in rules if evaluate_condition(rule["condition"], ctx)
    ]
