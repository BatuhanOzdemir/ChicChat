"""Port of intake/*.test.ts (machine, inactivity, simulator), plus golden
conversations comparing every state and prompt with the TypeScript machine."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any, cast

from chicchat.domain.intake import (
    InactivityThresholds,
    IntakeCase,
    IntakeConfig,
    IntakeSession,
    SessionTiming,
    SimulationScript,
    advance,
    inactivity_action,
    simulate_intake,
    start_intake,
)
from chicchat.domain.intake.fixtures import DEMO_INTAKE_CONFIG
from tests.golden import assert_golden

config = DEMO_INTAKE_CONFIG

WITH_KVKK = cast(IntakeConfig, {**config, "kvkkUrl": "https://example.com/kvkk"})


def _prompt(session: IntakeSession) -> dict[str, Any]:
    return cast(dict[str, Any], session["prompt"])


# --- KVKK disclosure (SPEC §12) -----------------------------------------------


def test_discloses_on_the_opening_message_of_a_new_conversation() -> None:
    prompt = _prompt(start_intake(WITH_KVKK))
    assert prompt["kind"] == "select_category"
    assert prompt["disclosure"] == "https://example.com/kvkk"


def test_does_not_repeat_it_when_the_machine_re_asks() -> None:
    start = start_intake(WITH_KVKK)
    retry = _prompt(advance(WITH_KVKK, start["state"], "pizza please"))
    assert (retry["kind"], retry["retry"]) == ("select_category", True)
    assert "disclosure" not in retry


def test_says_nothing_when_the_merchant_has_configured_no_url() -> None:
    assert "disclosure" not in _prompt(start_intake(config))


# --- selection ------------------------------------------------------------------


def test_re_prompts_on_an_unrecognized_category_selection() -> None:
    start = start_intake(config)
    assert start["prompt"]["kind"] == "select_category"
    nxt = _prompt(advance(config, start["state"], "pizza please"))
    assert (nxt["kind"], nxt["retry"]) == ("select_category", True)


def test_walks_category_subcategory_first_required_field() -> None:
    s = start_intake(config)
    s = advance(config, s["state"], "return")
    assert (_prompt(s)["kind"], _prompt(s)["category"]) == (
        "select_subcategory",
        "return",
    )
    s = advance(config, s["state"], "doesnt_fit")
    p = _prompt(s)
    assert (p["kind"], p["field"]["key"], p["retry"]) == (
        "request_field",
        "order_number",
        False,
    )


def test_asks_for_a_category_again_when_the_selected_one_disappears() -> None:
    s = start_intake(config)
    s = advance(config, s["state"], "return")
    s = advance(config, s["state"], "doesnt_fit")  # now collecting fields
    # The merchant disables/renames the category while the customer is mid-intake.
    shrunk = cast(
        IntakeConfig,
        {
            **config,
            "categories": [c for c in config["categories"] if c["key"] != "return"],
        },
    )
    recovered = advance(shrunk, s["state"], "TR100432")
    assert (_prompt(recovered)["kind"], _prompt(recovered)["retry"]) == (
        "select_category",
        True,
    )
    assert recovered["state"]["status"] == "selecting_category"
    assert "categoryKey" not in recovered["state"]


def _to_order_number_prompt() -> IntakeSession:
    s = start_intake(config)
    s = advance(config, s["state"], "return")
    return advance(config, s["state"], "doesnt_fit")


def test_re_asks_the_same_field_when_the_order_number_is_invalid_then_advances() -> (
    None
):
    s = _to_order_number_prompt()
    s = advance(config, s["state"], "##")  # normalizes to "" -> invalid
    p = _prompt(s)
    assert (p["kind"], p["field"]["key"], p["retry"]) == (
        "request_field",
        "order_number",
        True,
    )
    s = advance(config, s["state"], "TR100")  # valid (>=4 alnum)
    assert (_prompt(s)["kind"], _prompt(s)["field"]["key"]) == (
        "request_field",
        "item_ref",
    )


def test_offers_an_enum_field_as_options_and_re_asks_on_a_value_outside_the_set() -> (
    None
):
    s = _to_order_number_prompt()
    s = advance(config, s["state"], "TR100")
    s = advance(config, s["state"], "blue shirt")
    assert (_prompt(s)["kind"], _prompt(s)["field"]["key"]) == (
        "select_field",
        "reason",
    )
    s = advance(config, s["state"], "changed_mind")
    p = _prompt(s)
    assert (p["kind"], p["field"]["key"]) == ("select_field", "condition")
    assert p["options"] == [
        {"key": "unworn_tags_on", "label": "Unworn tags on"},
        {"key": "worn_tags_removed", "label": "Worn tags removed"},
    ]
    s = advance(config, s["state"], "blue")  # not an allowed condition
    assert (_prompt(s)["kind"], _prompt(s)["retry"]) == ("select_field", True)
    s = advance(config, s["state"], "Worn_Tags_Removed")  # canonicalized
    assert s["prompt"]["kind"] == "complete"


# --- inactivityAction -------------------------------------------------------------

THRESHOLDS = InactivityThresholds(nudge_after_minutes=5, abandon_after_hours=24)
NOW = datetime(2026, 7, 28, 12, 0, tzinfo=UTC)


def minutes_ago(minutes: float) -> datetime:
    return NOW - timedelta(minutes=minutes)


def test_leaves_a_freshly_active_session_alone() -> None:
    assert (
        inactivity_action(SessionTiming("active", minutes_ago(2)), THRESHOLDS, NOW)
        == "none"
    )


def test_nudges_once_the_nudge_threshold_is_reached() -> None:
    assert (
        inactivity_action(SessionTiming("active", minutes_ago(5)), THRESHOLDS, NOW)
        == "nudge"
    )


def test_does_not_nudge_a_session_that_was_already_nudged() -> None:
    assert (
        inactivity_action(SessionTiming("nudged", minutes_ago(30)), THRESHOLDS, NOW)
        == "none"
    )


def test_abandons_once_the_abandon_horizon_is_reached_even_if_already_nudged() -> None:
    assert (
        inactivity_action(
            SessionTiming("nudged", minutes_ago(24 * 60)), THRESHOLDS, NOW
        )
        == "abandon"
    )
    assert (
        inactivity_action(
            SessionTiming("active", minutes_ago(48 * 60)), THRESHOLDS, NOW
        )
        == "abandon"
    )


def test_abandons_rather_than_nudging_a_long_quiet_session() -> None:
    assert (
        inactivity_action(
            SessionTiming("active", minutes_ago(25 * 60)), THRESHOLDS, NOW
        )
        == "abandon"
    )


def test_never_nudges_an_errored_session_but_still_abandons_it() -> None:
    assert (
        inactivity_action(SessionTiming("errored", minutes_ago(10)), THRESHOLDS, NOW)
        == "none"
    )
    assert (
        inactivity_action(
            SessionTiming("errored", minutes_ago(30 * 60)), THRESHOLDS, NOW
        )
        == "abandon"
    )


def test_honours_merchant_configured_thresholds() -> None:
    custom = InactivityThresholds(nudge_after_minutes=60, abandon_after_hours=72)
    assert (
        inactivity_action(SessionTiming("active", minutes_ago(30)), custom, NOW)
        == "none"
    )
    assert (
        inactivity_action(SessionTiming("active", minutes_ago(61)), custom, NOW)
        == "nudge"
    )


# --- simulateIntake -------------------------------------------------------------------


def normalized(c: IntakeCase, key: str) -> str | None:
    return next((f["normalized"] for f in c["fields"] if f["key"] == key), "<absent>")


MESSY = simulate_intake(
    config,
    SimulationScript(
        category="return",
        subcategory="doesnt_fit",
        fields={
            "order_number": "  #tr-100 432 ",
            "item_ref": "the blue slim shirt",
            "reason": "Wrong_Size",
            "condition": "Unworn_Tags_On",
        },
    ),
)


def test_assembles_a_complete_normalized_structured_case() -> None:
    c = MESSY.case
    assert c is not None
    assert (c["category"], c["subcategory"], c["integration_tier"]) == (
        "return",
        "doesnt_fit",
        0,
    )
    assert normalized(c, "order_number") == "TR100432"
    assert normalized(c, "item_ref") == "the blue slim shirt"
    assert normalized(c, "condition") == "unworn_tags_on"
    assert normalized(c, "reason") == "wrong_size"


def test_asks_for_each_required_field_exactly_once_in_order() -> None:
    assert MESSY.asked == ["order_number", "item_ref", "reason", "condition"]


def test_accepts_a_1_based_index_for_the_category_and_a_label_for_the_subcategory() -> (
    None
):
    result = simulate_intake(
        config,
        SimulationScript(
            category="1",
            subcategory="Doesn't fit",
            fields={
                "order_number": "TR100432",
                "item_ref": "shirt",
                "reason": "wrong_size",
                "condition": "unworn_tags_on",
            },
        ),
    )
    assert result.case is not None
    assert (result.case["category"], result.case["subcategory"]) == (
        "return",
        "doesnt_fit",
    )


def test_does_not_ask_for_a_field_a_classifier_already_extracted() -> None:
    result = simulate_intake(
        config,
        SimulationScript(
            category="return",
            subcategory="changed_mind",
            initial_fields={"order_number": "#TR-100 432"},
            fields={
                "item_ref": "blue shirt",
                "reason": "changed_mind",
                "condition": "unworn_tags_on",
            },
        ),
    )
    assert "order_number" not in result.asked
    assert result.case is not None
    assert normalized(result.case, "order_number") == "TR100432"


def test_never_asks_for_optional_fields() -> None:
    result = simulate_intake(
        config,
        SimulationScript(
            category="other", fields={"description": "  need   help  please "}
        ),
    )
    assert result.asked == ["description"]
    assert result.case is not None
    assert result.case["subcategory"] is None
    assert normalized(result.case, "description") == "need help please"
    assert normalized(result.case, "order_number") == "<absent>"


# --- golden conversations -------------------------------------------------------------


def _conversation(
    cfg: IntakeConfig, initial: dict[str, str], messages: list[str]
) -> list[Any]:
    session = start_intake(cfg, initial)
    sessions: list[Any] = [session]
    for message in messages:
        session = advance(cfg, session["state"], message)
        sessions.append(session)
    return sessions


def _resume(cfg: IntakeConfig, state: Any, message: str) -> Any:
    return advance(cfg, state, message)


def test_matches_the_typescript_implementation() -> None:
    assert (
        assert_golden("intake", {"conversation": _conversation, "resume": _resume}) > 50
    )
