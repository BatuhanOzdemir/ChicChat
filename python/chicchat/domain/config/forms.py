"""Config-editor input parsing (SPEC §8, Handbook §5) — port of config/forms.ts.

Pure: takes plain mappings (the web layer turns a submitted form into one) and
returns results, so every editor boundary is validated before anything reaches
the database — and the rules are unit-testable.
"""

from __future__ import annotations

import contextlib
import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal

from chicchat.domain.cases.workflow import PRIORITIES, is_priority
from chicchat.domain.config.keys import is_valid_key, slugify_key
from chicchat.domain.jscompat import (
    JsRegexError,
    is_js_integer,
    js_json_parse,
    js_number,
    js_regex,
    js_trim,
)
from chicchat.domain.result import Err, Ok, Result
from chicchat.domain.rules.validate import is_condition

__all__ = [
    "ACTION_TYPES",
    "FIELD_TYPES",
    "NORMALIZE_RULES",
    "PRIORITIES",
    "FieldInput",
    "FormValues",
    "NamedInput",
    "PolicyInput",
    "RuleInput",
    "parse_field",
    "parse_named",
    "parse_policy",
    "parse_rule",
]

FormValues = Mapping[str, str | None]

EditableFieldType = Literal["string", "enum", "media", "ref"]
FIELD_TYPES: tuple[EditableFieldType, ...] = ("string", "enum", "media", "ref")

# Normalization rules a merchant can attach to a field. Offered as a choice so
# nobody has to guess the string — a mistyped rule silently means "no
# normalization", which is how an order number ends up stored raw.
NORMALIZE_RULES: tuple[str, ...] = ("order_number",)

EditableActionType = Literal["route", "auto_reply", "request_info", "escalate"]
ACTION_TYPES: tuple[EditableActionType, ...] = (
    "route",
    "auto_reply",
    "request_info",
    "escalate",
)


def _text(values: FormValues, name: str) -> str:
    return js_trim(values.get(name) or "")


def _int(values: FormValues, name: str, fallback: int) -> int | None:
    raw = _text(values, name)
    if raw == "":
        return fallback
    number = js_number(raw)
    return int(number) if is_js_integer(number) and number >= 0 else None


# --- Policy ------------------------------------------------------------------


@dataclass(frozen=True)
class PolicyInput:
    return_window_days: int
    refund_sla_days: int
    nudge_after_minutes: int
    abandon_after_hours: int
    retention_months: int
    kvkk_url: str | None
    order_id_regex: str | None


_HTTP_URL = js_regex(r"^https?:\/\/\S+$")


def parse_policy(values: FormValues) -> Result[PolicyInput]:
    numbers = {
        "returnWindowDays": _int(values, "return_window_days", 30),
        "refundSlaDays": _int(values, "refund_sla_days", 14),
        "nudgeAfterMinutes": _int(values, "nudge_after_minutes", 5),
        "abandonAfterHours": _int(values, "abandon_after_hours", 24),
        "retentionMonths": _int(values, "retention_months", 12),
    }
    for key, value in numbers.items():
        if value is None:
            return Err(f"{key} must be a non-negative whole number")
    if numbers["nudgeAfterMinutes"] == 0:
        return Err("nudge_after_minutes must be at least 1")
    if numbers["abandonAfterHours"] == 0:
        return Err("abandon_after_hours must be at least 1")

    kvkk_url = _text(values, "kvkk_url")
    if kvkk_url != "" and not _HTTP_URL.search(kvkk_url):
        return Err("kvkk_url must be an http(s) URL")

    order_id_regex = _text(values, "order_id_regex")
    if order_id_regex != "":
        try:
            js_regex(order_id_regex)
        except JsRegexError:
            return Err("order_id_regex is not a valid expression")

    whole = {key: value for key, value in numbers.items() if value is not None}
    return Ok(
        PolicyInput(
            return_window_days=whole["returnWindowDays"],
            refund_sla_days=whole["refundSlaDays"],
            nudge_after_minutes=whole["nudgeAfterMinutes"],
            abandon_after_hours=whole["abandonAfterHours"],
            retention_months=whole["retentionMonths"],
            kvkk_url=None if kvkk_url == "" else kvkk_url,
            order_id_regex=None if order_id_regex == "" else order_id_regex,
        )
    )


# --- Categories & subcategories ----------------------------------------------


@dataclass(frozen=True)
class NamedInput:
    key: str
    label: str
    sort_order: int


def parse_named(
    values: FormValues, what: Literal["category", "subcategory"]
) -> Result[NamedInput]:
    """Shared parser for a category or subcategory: label required, key derived."""
    label = _text(values, "label")
    if label == "":
        return Err(f"{what} label is required")
    provided = _text(values, "key")
    key = slugify_key(label) if provided == "" else slugify_key(provided)
    if not is_valid_key(key):
        return Err(
            f'could not derive a valid key from "{label}" — add a key with letters'
        )
    sort_order = _int(values, "sort_order", 0)
    if sort_order is None:
        return Err("sort_order must be a non-negative number")
    return Ok(NamedInput(key=key, label=label, sort_order=sort_order))


# --- Fields ------------------------------------------------------------------


@dataclass(frozen=True)
class FieldInput:
    key: str
    label: str | None
    type: EditableFieldType
    required: bool
    enum_values: list[str] | None
    normalize_rule: str | None
    sort_order: int


_VALUE_SEPARATORS = re.compile(r"[\n,]")


def parse_field(values: FormValues) -> Result[FieldInput]:
    label = _text(values, "label")
    provided = _text(values, "key")
    key = slugify_key(label) if provided == "" else slugify_key(provided)
    if not is_valid_key(key):
        return Err("field key is required (letters, digits, _)")

    field_type = _text(values, "type")
    if field_type not in FIELD_TYPES:
        return Err(f"field type must be one of {'|'.join(FIELD_TYPES)}")

    # One value per line, or comma separated — merchants type both.
    raw_values = _text(values, "enum_values")
    enum_values = (
        None
        if raw_values == ""
        else [
            slug
            for slug in (slugify_key(v) for v in _VALUE_SEPARATORS.split(raw_values))
            if slug != ""
        ]
    )
    if field_type == "enum" and enum_values and len(enum_values) > 10:
        # WhatsApp list messages cap at 10 rows (SPEC §6).
        return Err("an enum field can offer at most 10 values")

    sort_order = _int(values, "sort_order", 0)
    if sort_order is None:
        return Err("sort_order must be a non-negative number")

    normalize_rule = _text(values, "normalize_rule")
    if normalize_rule != "" and normalize_rule not in NORMALIZE_RULES:
        return Err(
            f"normalize rule must be empty or one of {'|'.join(NORMALIZE_RULES)}"
        )

    return Ok(
        FieldInput(
            key=key,
            label=None if label == "" else label,
            type=field_type,  # type: ignore[arg-type]
            required=_text(values, "required") != "",
            enum_values=enum_values,
            normalize_rule=None if normalize_rule == "" else normalize_rule,
            sort_order=sort_order,
        )
    )


# --- Routing rules -----------------------------------------------------------


@dataclass(frozen=True)
class RuleInput:
    label: str | None
    condition: Any
    action_type: EditableActionType
    target_queue: str | None
    priority: str | None
    sort_order: int
    """Evaluation order: rules are first-match-wins, lowest first."""


def _condition_from_simple_fields(values: FormValues) -> Any | None:
    """The plain-language editor's field/op/value, or None when unused."""
    field = _text(values, "condition_field")
    if not field:
        return None
    op = _text(values, "condition_op") or "eq"
    raw = _text(values, "condition_value")
    value: Any = raw
    with contextlib.suppress(ValueError):  # Plain text values need no JSON syntax.
        value = js_json_parse(raw)
    condition: dict[str, Any] = {"field": field, "op": op}
    if op not in ("present", "absent"):
        condition["value"] = value
    return condition


def parse_rule(values: FormValues) -> Result[RuleInput]:
    action_type = _text(values, "action_type")
    if action_type not in ACTION_TYPES:
        return Err(f"action must be one of {'|'.join(ACTION_TYPES)}")

    condition = _condition_from_simple_fields(values)
    if condition is None:
        try:
            condition = js_json_parse(_text(values, "condition") or '{"all":[]}')
        except ValueError:
            return Err("condition must be valid JSON")
    if not is_condition(condition):
        return Err(
            "condition must be a valid, bounded rule tree "
            "(all, any, not, or field comparison)"
        )

    label = _text(values, "label")
    target_queue = _text(values, "target_queue")

    # Priority reaches a case's queue ordering, so a typo here would quietly
    # mis-sort real work — constrain it to the known set at the boundary.
    priority = _text(values, "priority")
    if priority != "" and not is_priority(priority):
        return Err(f"priority must be one of {'|'.join(PRIORITIES)}")

    if action_type in ("route", "escalate") and target_queue == "":
        return Err(f"{action_type} needs a target queue")

    # Evaluation is first-match-wins, so this is the merchant's precedence.
    sort_order = _int(values, "sort_order", 0)
    if sort_order is None:
        return Err("sort_order must be a non-negative number")

    return Ok(
        RuleInput(
            label=None if label == "" else label,
            condition=condition,
            action_type=action_type,  # type: ignore[arg-type]
            target_queue=None if target_queue == "" else target_queue,
            priority=None if priority == "" else priority,
            sort_order=sort_order,
        )
    )
