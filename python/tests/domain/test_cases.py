"""Port of cases/*.test.ts (workflow, filters, analytics, date, routing)."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from chicchat.domain.cases.analytics import (
    abandonment_rate,
    format_duration,
    format_percent,
    median,
)
from chicchat.domain.cases.date import format_date_time
from chicchat.domain.cases.filters import CaseFilters, parse_case_filters
from chicchat.domain.cases.routing import (
    LabelledRule,
    RoutingDecision,
    decide_routing,
    describe_routing,
    routing_context,
)
from chicchat.domain.cases.workflow import (
    NOTE_MAX_LENGTH,
    PRIORITIES,
    age_label,
    can_transition,
    constrain_priority,
    is_terminal,
    next_statuses,
    parse_note,
    plan_transition,
    priority_rank,
)
from chicchat.domain.result import Err, Ok
from chicchat.domain.rules import RuleContext

# --- status transitions (SPEC §9) ---------------------------------------------


def test_walks_the_main_path_open_in_progress_resolved_closed() -> None:
    assert can_transition("open", "in_progress")
    assert can_transition("in_progress", "resolved")
    assert can_transition("resolved", "closed")


def test_refuses_to_skip_from_open_straight_to_closed() -> None:
    result = plan_transition("open", "closed")
    assert isinstance(result, Err)
    assert "cannot move" in result.error


def test_names_the_allowed_moves_when_it_refuses_one() -> None:
    result = plan_transition("escalated", "needs_info")
    assert isinstance(result, Err)
    assert "in_progress" in result.error
    assert "resolved" in result.error


def test_rejects_a_transition_to_the_status_it_is_already_in() -> None:
    assert plan_transition("resolved", "resolved") == Err("case is already resolved")


def test_rejects_statuses_outside_the_vocabulary_from_either_side() -> None:
    assert not plan_transition("open", "done").ok
    assert not plan_transition("archived", "open").ok


def test_lets_an_agent_reopen_a_closed_case_and_pick_up_an_abandoned_intake() -> None:
    assert can_transition("closed", "in_progress")
    assert can_transition("abandoned", "in_progress")


def test_reports_which_transitions_stop_the_clock() -> None:
    resolved = plan_transition("in_progress", "resolved")
    assert isinstance(resolved, Ok) and resolved.value.terminal is True
    started = plan_transition("open", "in_progress")
    assert isinstance(started, Ok) and started.value.terminal is False
    assert is_terminal("closed")
    assert not is_terminal("needs_info")


def test_offers_no_moves_out_of_nowhere_every_status_has_a_way_forward() -> None:
    for status in (
        "open",
        "in_progress",
        "needs_info",
        "handed_off",
        "escalated",
        "resolved",
        "closed",
        "abandoned",
    ):
        assert len(next_statuses(status)) > 0


def test_sorts_high_before_normal_before_low() -> None:
    assert [priority_rank(p) for p in PRIORITIES] == [0, 1, 2]


def test_degrades_an_unknown_priority_to_normal_rather_than_failing() -> None:
    assert constrain_priority("urgent") == "normal"
    assert constrain_priority(None) == "normal"
    assert constrain_priority("  HIGH ") == "high"


def test_trims_and_accepts_real_text() -> None:
    assert parse_note("  called the carrier  ") == Ok("called the carrier")


def test_rejects_an_empty_note() -> None:
    assert not parse_note("   ").ok


def test_rejects_a_note_past_the_length_cap() -> None:
    result = parse_note("x" * (NOTE_MAX_LENGTH + 1))
    assert isinstance(result, Err) and "exceed" in result.error


def test_counts_note_length_like_javascript() -> None:
    # An emoji is two UTF-16 units in JavaScript: 1000 emoji hit the cap.
    assert parse_note("👗" * 1000).ok
    assert not parse_note("👗" * 1001).ok


NOW = datetime(2026, 7, 29, 12, 0, tzinfo=UTC)


def test_reads_in_the_largest_sensible_unit() -> None:
    assert age_label("2026-07-29T11:59:30Z", NOW) == "just now"
    assert age_label("2026-07-29T11:20:00Z", NOW) == "40m"
    assert age_label("2026-07-29T02:00:00Z", NOW) == "10h"
    assert age_label("2026-07-25T12:00:00Z", NOW) == "4d"


def test_does_not_crash_on_a_broken_timestamp() -> None:
    assert age_label("not a date", NOW) == "—"


# --- parseCaseFilters -------------------------------------------------------------


def test_defaults_to_no_filters_on_page_1() -> None:
    assert parse_case_filters({}) == Ok(
        CaseFilters(
            status=None,
            category_key=None,
            queue=None,
            from_date=None,
            to_date=None,
            order_number=None,
            page=1,
        )
    )


def _ok(params: dict[str, Any]) -> CaseFilters:
    result = parse_case_filters(params)
    assert isinstance(result, Ok)
    return result.value


def test_accepts_a_queue_including_the_unrouted_sentinel() -> None:
    assert _ok({"queue": "returns_queue"}).queue == "returns_queue"
    assert _ok({"queue": "unrouted"}).queue == "unrouted"


def test_accepts_the_statuses_the_agent_console_adds() -> None:
    assert parse_case_filters({"status": "in_progress"}).ok
    assert parse_case_filters({"status": "closed"}).ok


def test_normalizes_the_order_number_search_so_messy_input_still_matches() -> None:
    assert _ok({"order_number": "  #tr-100 432 "}).order_number == "TR100432"


def test_accepts_a_status_category_and_date_range() -> None:
    value = _ok(
        {
            "status": "abandoned",
            "category": "return",
            "from": "2026-07-01",
            "to": "2026-07-31",
            "page": "3",
        }
    )
    assert (
        value.status,
        value.category_key,
        value.from_date,
        value.to_date,
        value.page,
    ) == (
        "abandoned",
        "return",
        "2026-07-01",
        "2026-07-31",
        3,
    )


def test_rejects_an_unknown_status() -> None:
    assert parse_case_filters({"status": "exploded"}) == Err(
        'unknown status "exploded"'
    )


def test_rejects_malformed_dates_and_an_inverted_range() -> None:
    assert not parse_case_filters({"from": "01/07/2026"}).ok
    assert parse_case_filters({"from": "2026-08-01", "to": "2026-07-01"}) == Err(
        "from must not be after to"
    )


def test_rejects_a_bad_page() -> None:
    assert not parse_case_filters({"page": "0"}).ok
    assert not parse_case_filters({"page": "abc"}).ok


# --- analytics ----------------------------------------------------------------------


def test_takes_the_middle_value_of_an_odd_sample() -> None:
    assert median([30, 10, 20]) == 20


def test_averages_the_two_middle_values_of_an_even_sample() -> None:
    assert median([10, 20, 30, 40]) == 25


def test_is_null_for_an_empty_sample_rather_than_0() -> None:
    assert median([]) is None


def test_does_not_mutate_the_input() -> None:
    values = [3, 1, 2]
    median(values)
    assert values == [3, 1, 2]


def test_is_the_abandoned_share_of_all_finished_or_abandoned_intakes() -> None:
    assert abandonment_rate(3, 1) == 0.25
    assert abandonment_rate(0, 2) == 1


def test_is_null_when_there_is_nothing_to_measure() -> None:
    assert abandonment_rate(0, 0) is None


def test_renders_durations_compactly() -> None:
    assert format_duration(42) == "42s"
    assert format_duration(252) == "4m 12s"
    assert format_duration(3900) == "1h 5m"
    assert format_duration(None) == "—"


def test_rounds_halves_up_like_math_round() -> None:
    assert format_duration(2.5) == "3s"
    assert format_percent(0.125) == "13%"


def test_renders_percentages_and_an_em_dash_when_unknown() -> None:
    assert format_percent(0.25) == "25%"
    assert format_percent(None) == "—"


# --- formatDateTime -------------------------------------------------------------


def test_shows_day_month_year_in_istanbul_time_across_a_utc_day_boundary() -> None:
    assert format_date_time("2026-09-14T22:05:00Z") == "15/09/2026, 01:05"


def test_handles_unavailable_dates() -> None:
    assert format_date_time("invalid") == "—"


# --- routing ----------------------------------------------------------------------

DAMAGED_WITH_PHOTO: LabelledRule = {
    "id": "r1",
    "label": "damaged with photo",
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
NO_PHOTO: LabelledRule = {
    "id": "r2",
    "label": "photo missing",
    "condition": {"all": [{"field": "photo", "op": "absent"}]},
    "action_type": "request_info",
    "target_queue": None,
    "priority": "normal",
}
ITEM_MISSING: LabelledRule = {
    "id": "r3",
    "label": "item missing",
    "condition": {
        "all": [{"field": "subcategory", "op": "eq", "value": "item_missing"}]
    },
    "action_type": "escalate",
    "target_queue": "verify_order_contents",
    "priority": "normal",
}
RULES = [DAMAGED_WITH_PHOTO, NO_PHOTO, ITEM_MISSING]


def context(
    subcategory: str, fields: list[dict[str, Any]] | None = None
) -> RuleContext:
    return routing_context("wrong_damaged_missing", subcategory, fields or [])  # type: ignore[arg-type]


def photo(raw: str) -> list[dict[str, Any]]:
    return [{"key": "photo", "raw": raw, "normalized": raw}]


def test_routes_a_damaged_item_with_a_photo_to_the_priority_queue() -> None:
    decision = decide_routing(RULES, context("damaged", photo("media.1")))
    assert (decision["queue"], decision["priority"], decision["status"]) == (
        "priority_replacements",
        "high",
        "open",
    )
    assert [m["label"] for m in decision["matched"]] == ["damaged with photo"]


def test_asks_for_more_information_when_the_photo_is_missing() -> None:
    decision = decide_routing(RULES, context("damaged"))
    assert (decision["queue"], decision["priority"], decision["status"]) == (
        None,
        "normal",
        "needs_info",
    )


def test_escalates_a_missing_item_to_the_verification_queue() -> None:
    decision = decide_routing(RULES, context("item_missing", photo("media.2")))
    assert (decision["queue"], decision["status"]) == (
        "verify_order_contents",
        "escalated",
    )


def test_gives_the_first_matching_rule_the_decision_and_reports_the_rest() -> None:
    decision = decide_routing(RULES, context("item_missing"))
    assert decision["status"] == "needs_info"
    assert decision["queue"] is None
    assert [m["label"] for m in decision["matched"]] == [
        "photo missing",
        "item missing",
    ]


def test_leaves_a_case_open_and_unrouted_when_nothing_matches() -> None:
    expected: RoutingDecision = {
        "queue": None,
        "priority": "normal",
        "status": "open",
        "matched": [],
    }
    assert (
        decide_routing([ITEM_MISSING], context("wrong_item", photo("media.3")))
        == expected
    )


def test_does_not_match_rules_about_computed_fields_in_tier_0() -> None:
    window_rule: LabelledRule = {
        "label": "outside the return window",
        "condition": {
            "all": [{"field": "within_return_window", "op": "eq", "value": False}]
        },
        "action_type": "escalate",
        "target_queue": "policy_exception",
        "priority": "normal",
    }
    decision = decide_routing([window_rule], context("doesnt_fit"))
    assert decision["queue"] is None
    assert decision["status"] == "open"


def test_degrades_a_mistyped_priority_instead_of_propagating_it() -> None:
    decision = decide_routing(
        [{**ITEM_MISSING, "priority": "URGENT!"}], context("item_missing")
    )
    assert decision["priority"] == "normal"


def test_treats_a_blank_target_queue_as_unrouted() -> None:
    decision = decide_routing(
        [{**ITEM_MISSING, "target_queue": "   "}], context("item_missing")
    )
    assert decision["queue"] is None


def test_labels_an_unnamed_rule_by_its_position() -> None:
    decision = decide_routing(
        [{**ITEM_MISSING, "label": None}], context("item_missing")
    )
    assert decision["matched"][0]["label"] == "rule 1"


def test_exposes_the_category_subcategory_and_normalized_field_values() -> None:
    ctx = routing_context(
        "return",
        "doesnt_fit",
        [{"key": "order_number", "raw": "#tr-100 432", "normalized": "TR100432"}],
    )
    assert ctx["fields"] == {
        "category": "return",
        "subcategory": "doesnt_fit",
        "order_number": "TR100432",
    }


def test_falls_back_to_the_raw_value_when_normalization_produced_nothing() -> None:
    ctx = routing_context(
        "return", None, [{"key": "reason", "raw": "too big", "normalized": None}]
    )
    assert ctx["fields"]["reason"] == "too big"


def test_passes_merchant_settings_through_for_rules_that_use_ref() -> None:
    ctx = routing_context("return", None, [], {"return_window_days": 30})
    assert ctx.get("config") == {"return_window_days": 30}


def test_explains_a_decision_in_one_line_for_the_timeline() -> None:
    decision = decide_routing(RULES, context("damaged", photo("media.1")))
    assert (
        describe_routing(decision)
        == "Routed to priority_replacements (high priority, open) — matched damaged with photo"
    )


def test_says_so_when_no_rule_matched() -> None:
    line = describe_routing(decide_routing([], context("damaged")))
    assert "unrouted" in line
    assert "no rule matched" in line


# --- golden -------------------------------------------------------------------------

from chicchat.domain.dates import parse_js_date  # noqa: E402
from tests.golden import assert_golden, ts_json  # noqa: E402

_GOLDEN_NOW = parse_js_date("2026-07-29T12:00:00Z")


def test_matches_the_typescript_implementation() -> None:
    assert _GOLDEN_NOW is not None
    now = _GOLDEN_NOW

    def routing_ctx(inp: dict[str, Any]) -> Any:
        return routing_context(
            inp["category"], inp["subcategory"], inp["fields"], inp.get("settings")
        )

    assert (
        assert_golden(
            "cases",
            {
                "planTransition": lambda f, t: ts_json(plan_transition(f, t)),
                "constrainPriority": constrain_priority,
                "parseNote": lambda s: ts_json(parse_note(s)),
                "ageLabel": lambda c: age_label(c, now),
                "median": lambda v: ts_json(median(v)),
                "abandonmentRate": lambda a, b: ts_json(abandonment_rate(a, b)),
                "formatDuration": format_duration,
                "formatPercent": format_percent,
                "formatDateTime": format_date_time,
                "parseCaseFilters": lambda p: ts_json(parse_case_filters(p)),
                "routingContext": lambda inp: ts_json(routing_ctx(inp)),
                "decideRouting": lambda rules, ctx: ts_json(decide_routing(rules, ctx)),
                "describeRouting": describe_routing,
            },
        )
        > 300
    )
