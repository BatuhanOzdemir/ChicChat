"""Condition-tree validation — port of rules/validate.ts.

Bound both depth and work; stored configuration is an untrusted boundary too.
"""

from __future__ import annotations

from typing import Any

from chicchat.domain.jscompat import is_js_number, js_trim

_OPS = frozenset(
    ["eq", "neq", "gt", "gte", "lt", "lte", "in", "nin", "present", "absent"]
)
_GROUP_KEYS = ("all", "any", "not")
_COMPARISON_KEYS = frozenset(["field", "op", "value", "ref"])


def is_condition(value: object) -> bool:
    remaining = 256

    def visit(node: object, depth: int) -> bool:
        nonlocal remaining
        remaining -= 1
        # `!node` in JavaScript: only None can reach here falsy among objects.
        if remaining < 0 or depth > 16 or not isinstance(node, dict):
            return False
        obj: dict[str, Any] = node
        groups = [key for key in _GROUP_KEYS if key in obj]
        if groups:
            if len(groups) != 1 or len(obj) != 1:
                return False
            key = groups[0]
            if key == "not":
                return visit(obj["not"], depth + 1)
            children = obj[key]
            return isinstance(children, list) and all(
                visit(child, depth + 1) for child in children
            )
        field = obj.get("field")
        op = obj.get("op")
        if (
            not isinstance(field, str)
            or not js_trim(field)
            or not isinstance(op, str)
            or op not in _OPS
        ):
            return False
        if any(key not in _COMPARISON_KEYS for key in obj):
            return False
        if op in ("present", "absent"):
            return "value" not in obj and "ref" not in obj
        if "ref" in obj:
            ref = obj["ref"]
            return isinstance(ref, str) and bool(js_trim(ref)) and "value" not in obj
        if "value" not in obj:
            return False
        literal = obj["value"]
        if op in ("in", "nin"):
            return isinstance(literal, list) and len(literal) <= 100
        return (
            literal is None or isinstance(literal, str | bool) or is_js_number(literal)
        )

    return visit(value, 0)
