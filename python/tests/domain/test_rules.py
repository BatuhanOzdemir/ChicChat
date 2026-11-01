"""Port of rules/*.test.ts, plus golden comparison with the TypeScript."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import pytest

from chicchat.domain.config.forms import parse_rule
from chicchat.domain.dates import parse_js_date
from chicchat.domain.rules import (
    Rule,
    evaluate,
    evaluate_condition,
    evaluate_rules,
    is_condition,
    is_within_return_window,
)
from tests.golden import assert_golden

# Rules mirror the Step 2 seed defaults for the relevant categories.

REFUND_PAST_SLA: Rule = {
    "condition": {
        "all": [
            {"field": "refund_status", "op": "eq", "value": "received"},
            {
                "field": "days_since_return_received",
                "op": "gt",
                "ref": "refund_sla_days",
            },
        ]
    },
    "action_type": "route",
    "target_queue": "finance_refunds_queue",
    "priority": "high",
}
REFUND_WITHIN_SLA: Rule = {
    "condition": {
        "all": [
            {"field": "refund_status", "op": "eq", "value": "received"},
            {
                "field": "days_since_return_received",
                "op": "lte",
                "ref": "refund_sla_days",
            },
        ]
    },
    "action_type": "auto_reply",
    "target_queue": None,
    "priority": "normal",
}
NOT_AS_DESCRIBED_NEEDS_PHOTO: Rule = {
    "condition": {
        "all": [{"field": "subcategory", "op": "eq", "value": "not_as_described"}]
    },
    "action_type": "request_info",
    "target_queue": None,
    "priority": "normal",
}
PHOTO_ABSENT_NEEDS_PHOTO: Rule = {
    "condition": {"all": [{"field": "photo", "op": "absent"}]},
    "action_type": "request_info",
    "target_queue": None,
    "priority": "normal",
}
DAMAGED_WITH_PHOTO: Rule = {
    "condition": {
        "all": [
            {"field": "subcategory", "op": "in", "value": ["damaged", "defective"]},
            {"field": "photo", "op": "present"},
        ]
    },
    "action_type": "route",
    "target_queue": "priority_replacements",
    "priority": "high",
}
WITHIN_WINDOW_ROUTE: Rule = {
    "condition": {
        "all": [{"field": "within_return_window", "op": "eq", "value": True}]
    },
    "action_type": "route",
    "target_queue": "returns_queue",
    "priority": "normal",
}
OUTSIDE_WINDOW_ESCALATE: Rule = {
    "condition": {
        "all": [{"field": "within_return_window", "op": "eq", "value": False}]
    },
    "action_type": "escalate",
    "target_queue": "policy_exception",
    "priority": "normal",
}

CONFIG = {"refund_sla_days": 14}


def test_routes_to_the_finance_queue_when_refund_received_and_past_sla() -> None:
    action = evaluate(
        REFUND_PAST_SLA,
        {
            "fields": {"refund_status": "received", "days_since_return_received": 20},
            "config": CONFIG,
        },
    )
    assert action == {
        "action_type": "route",
        "target_queue": "finance_refunds_queue",
        "priority": "high",
        "auto_resolve": False,
    }


def test_does_not_fire_the_past_sla_rule_while_still_within_sla() -> None:
    ctx: Any = {
        "fields": {"refund_status": "received", "days_since_return_received": 5},
        "config": CONFIG,
    }
    assert evaluate(REFUND_PAST_SLA, ctx) is None
    within = evaluate(REFUND_WITHIN_SLA, ctx)
    assert within is not None and within["action_type"] == "auto_reply"


def test_does_not_fire_when_the_refund_status_is_unknown() -> None:
    assert (
        evaluate(
            REFUND_PAST_SLA,
            {"fields": {"days_since_return_received": 20}, "config": CONFIG},
        )
        is None
    )


def test_requests_info_for_a_not_as_described_return() -> None:
    action = evaluate(
        NOT_AS_DESCRIBED_NEEDS_PHOTO, {"fields": {"subcategory": "not_as_described"}}
    )
    assert action is not None and action["action_type"] == "request_info"


def test_requests_a_photo_for_a_damaged_item_when_none_is_attached() -> None:
    action = evaluate(PHOTO_ABSENT_NEEDS_PHOTO, {"fields": {"subcategory": "damaged"}})
    assert action is not None and action["action_type"] == "request_info"


def test_pre_approves_replacement_once_a_photo_is_attached() -> None:
    action = evaluate(
        DAMAGED_WITH_PHOTO,
        {"fields": {"subcategory": "damaged", "photo": "wamid.media.123"}},
    )
    assert action is not None
    assert action["action_type"] == "route"
    assert action["target_queue"] == "priority_replacements"
    assert action["priority"] == "high"


def test_routes_within_window_returns_and_escalates_out_of_window_ones() -> None:
    within: Any = {"fields": {"within_return_window": True}}
    outside: Any = {"fields": {"within_return_window": False}}
    routed = evaluate(WITHIN_WINDOW_ROUTE, within)
    assert routed is not None and routed["target_queue"] == "returns_queue"
    assert evaluate(WITHIN_WINDOW_ROUTE, outside) is None
    escalated = evaluate(OUTSIDE_WINDOW_ESCALATE, outside)
    assert escalated is not None and escalated["target_queue"] == "policy_exception"


def test_treats_an_empty_all_group_as_always_match() -> None:
    assert evaluate_condition({"all": []}, {"fields": {}}) is True


def test_collects_the_actions_of_every_matching_rule_in_order() -> None:
    actions = evaluate_rules(
        [REFUND_PAST_SLA, REFUND_WITHIN_SLA],
        {
            "fields": {"refund_status": "received", "days_since_return_received": 20},
            "config": {"refund_sla_days": 14},
        },
    )
    assert [a["action_type"] for a in actions] == ["route"]


# --- untrusted condition trees (validate.test.ts) ----------------------------


def test_builds_a_valid_rule_from_the_merchants_plain_language_form_fields() -> None:
    rule = parse_rule(
        {
            "action_type": "route",
            "target_queue": "returns",
            "condition_field": "reason",
            "condition_op": "eq",
            "condition_value": "wrong_size",
        }
    )
    assert rule.ok
    assert rule.value.condition == {
        "field": "reason",
        "op": "eq",
        "value": "wrong_size",
    }


@pytest.mark.parametrize(
    "condition",
    [
        None,
        [],
        {"all": "invalid"},
        {"not": None},
        {"all": [], "any": []},
        {"field": "x", "op": "wat", "value": 1},
    ],
)
def test_rejects_malformed_trees(condition: object) -> None:
    import json

    assert is_condition(condition) is False
    assert evaluate_condition(condition, {"fields": {}}) is False
    assert (
        parse_rule(
            {
                "condition": json.dumps(condition),
                "action_type": "route",
                "target_queue": "returns",
            }
        ).ok
        is False
    )


def test_accepts_nested_comparisons_and_rejects_excessive_depth() -> None:
    node: object = {"field": "reason", "op": "in", "value": ["wrong_size"]}
    assert (
        is_condition({"all": [node, {"not": {"field": "photo", "op": "absent"}}]})
        is True
    )
    for _ in range(20):
        node = {"not": node}
    assert is_condition(node) is False


# --- isWithinReturnWindow -----------------------------------------------------

NOW = datetime(2026, 6, 22, 12, 0, tzinfo=UTC)


def test_is_within_the_window_before_the_deadline() -> None:
    assert is_within_return_window("2026-06-12T12:00:00Z", 30, NOW) is True


def test_is_outside_the_window_after_the_deadline() -> None:
    assert is_within_return_window("2026-05-13T12:00:00Z", 30, NOW) is False


def test_includes_the_deadline_day_itself() -> None:
    assert is_within_return_window("2026-05-23T12:00:00Z", 30, NOW) is True


def test_returns_false_for_an_unparseable_date() -> None:
    assert is_within_return_window("not-a-date", 30, NOW) is False


# --- golden -----------------------------------------------------------------


def _window(date: str, days: int, now: dict[str, str]) -> bool:
    moment = parse_js_date(now["$date"])
    assert moment is not None
    return is_within_return_window(date, days, moment)


def test_matches_the_typescript_implementation() -> None:
    assert (
        assert_golden(
            "rules",
            {
                "evaluateCondition": evaluate_condition,
                "isCondition": is_condition,
                "isWithinReturnWindow": _window,
            },
        )
        > 5000
    )
