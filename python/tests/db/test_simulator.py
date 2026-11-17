"""Port of db/simulator.integration.test.ts (SPEC §7): whole intakes complete
inside the simulator, for several categories, with the case JSON correct each
time — and no Meta credentials involved."""

from __future__ import annotations

import re
from typing import Any

import pytest

from chicchat.db.config import DEMO_MERCHANT_ID
from chicchat.db.database import ConnectionDatabase
from chicchat.db.sessions import load_session
from chicchat.domain.dates import as_datetime, millis_between
from chicchat.domain.simulator.presets import PRESETS, Preset, play_preset
from chicchat.domain.simulator.protocol import SimulatorMessageInput
from chicchat.server.simulator import SimulatorResponse
from tests.db.helpers import simulate


def send(
    db: ConnectionDatabase,
    phone: str,
    kind: str,
    value: str,
    message_id: str | None = None,
    inject: str | None = None,
) -> SimulatorResponse:
    message: dict[str, Any] = {"kind": kind, "value": value}
    if message_id:
        message["messageId"] = message_id
    extra: dict[str, Any] = {"message": message}
    if inject:
        extra["injectError"] = inject
    response: SimulatorResponse = simulate(
        db, "message", phone, DEMO_MERCHANT_ID, **extra
    )
    return response


def action(
    db: ConnectionDatabase, name: str, phone: str, **extra: Any
) -> SimulatorResponse:
    response: SimulatorResponse = simulate(db, name, phone, DEMO_MERCHANT_ID, **extra)
    return response


def complete_intake(
    db: ConnectionDatabase,
    phone: str,
    category: str,
    subcategory: str,
    answers: dict[str, tuple[str, str]],
) -> SimulatorResponse:
    """Walk a full intake, answering whichever field the machine asks for next."""
    send(db, phone, "text", "merhaba")
    send(db, phone, "list", category)
    last = send(db, phone, "list", subcategory)
    for _ in range(12):
        pending = last.session.get("pendingFieldKey") if last.session else None
        if not pending:
            break
        kind, value = answers[pending]
        last = send(db, phone, kind, value)
    return last


def test_return_doesnt_fit_messy_order_number_is_normalized(
    db: ConnectionDatabase,
) -> None:
    result = complete_intake(
        db,
        "905550000101",
        "return",
        "doesnt_fit",
        {
            "order_number": ("text", "  #tr-100 432 "),
            "item_ref": ("text", "blue slim fit shirt"),
            "reason": ("list", "wrong_size"),
            "condition": ("text", "unworn_tags_on"),
        },
    )
    case = result.completed_case
    assert case is not None
    assert (
        case["category"],
        case["subcategory"],
        case["integration_tier"],
        case["status"],
    ) == (
        "return",
        "doesnt_fit",
        0,
        "open",
    )
    assert case["fields"]["order_number"] == "TR100432"
    assert case["fields"]["condition"] == "unworn_tags_on"
    assert load_session(db, DEMO_MERCHANT_ID, "905550000101") is None


def test_wrong_damaged_missing_photo_captured_as_a_media_ref(
    db: ConnectionDatabase,
) -> None:
    result = complete_intake(
        db,
        "905550000102",
        "wrong_damaged_missing",
        "damaged",
        {
            "order_number": ("text", "TR100432"),
            "item_ref": ("text", "red summer dress"),
            "description": ("text", "  the seam is  torn "),
            "photo": ("photo", "media.sim.torn"),
        },
    )
    case = result.completed_case
    assert case is not None
    assert case["category"] == "wrong_damaged_missing"
    assert case["photos"] == ["media.sim.torn"]
    assert case["fields"]["description"] == "the seam is torn"


def test_exchange_a_field_answered_by_a_flow_submission(db: ConnectionDatabase) -> None:
    result = complete_intake(
        db,
        "905550000103",
        "exchange",
        "different_size",
        {
            "order_number": ("text", "TR100999"),
            "item_ref": ("flow", '{"item_ref":"Chino Trousers — Beige / 32"}'),
            "desired_variant": ("text", "34"),
            "reason": ("list", "wrong_size"),
        },
    )
    case = result.completed_case
    assert case is not None
    assert (case["category"], case["subcategory"]) == ("exchange", "different_size")
    # The Flow payload was unwrapped to the field value, not stored as JSON.
    assert case["fields"]["item_ref"] == "Chino Trousers — Beige / 32"


PHONE = "905550000104"


def test_presents_the_category_list_on_first_contact_and_tapping_advances_it(
    db: ConnectionDatabase,
) -> None:
    first = send(db, PHONE, "text", "hi")
    listing = first.outbound[0]
    assert listing["type"] == "interactive"
    assert "return" in [
        r["id"] for r in listing["interactive"]["action"]["sections"][0]["rows"]
    ]
    assert first.session is not None and first.session["status"] == "selecting_category"
    second = send(db, PHONE, "list", "return")
    assert (
        second.session is not None
        and second.session["status"] == "selecting_subcategory"
    )


def test_reset_clears_the_session(db: ConnectionDatabase) -> None:
    send(db, PHONE, "text", "hi")
    reset = action(db, "reset", PHONE)
    assert reset.session is None
    assert load_session(db, DEMO_MERCHANT_ID, PHONE) is None


def test_time_travel_ages_the_live_session(db: ConnectionDatabase) -> None:
    send(db, PHONE, "text", "hi")
    before = action(db, "state", PHONE)
    aged = action(db, "time_travel", PHONE, ageMinutes=90)
    assert aged.notice is not None and "aged by 90" in aged.notice
    assert before.session_meta is not None and aged.session_meta is not None
    before_ts = as_datetime(before.session_meta["updated_at"])
    after_ts = as_datetime(aged.session_meta["updated_at"])
    assert before_ts is not None and after_ts is not None
    assert millis_between(before_ts, after_ts) >= 89 * 60_000


def test_handler_exception_injection_produces_the_generic_reply(
    db: ConnectionDatabase,
) -> None:
    result = send(db, PHONE, "text", "hi", inject="handler_exception")
    assert result.error is not None and "processing failed" in result.error
    # The customer is told something generic — never diagnostics.
    reply = result.outbound[-1]
    assert reply["type"] == "text"
    assert re.search(r"something went wrong", reply["text"]["body"], re.IGNORECASE)
    assert not re.search(r"injected|Error|stack", reply["text"]["body"], re.IGNORECASE)
    # …and the session is marked errored for the merchant console.
    rows = db.query(
        "select status, last_error from intake_sessions where merchant_id = $1 and customer_wa_id = $2",
        [DEMO_MERCHANT_ID, PHONE],
    )
    assert [r["status"] for r in rows] == ["errored"]


def test_integration_down_injection_is_accepted_with_a_notice(
    db: ConnectionDatabase,
) -> None:
    result = send(db, PHONE, "text", "hi", inject="integration_down")
    assert result.notice is not None and "integration_down" in result.notice
    assert result.error is None


def test_a_duplicate_delivery_has_no_second_effect(db: ConnectionDatabase) -> None:
    first = send(db, PHONE, "text", "hi", message_id="wamid.sim.duplicate")
    assert len(first.outbound) == 1
    replay = send(db, PHONE, "text", "hi", message_id="wamid.sim.duplicate")
    assert replay.outbound == []
    assert replay.error is not None and "duplicate" in replay.error


def test_a_duplicate_of_a_completing_message_does_not_create_a_second_case(
    db: ConnectionDatabase,
) -> None:
    phone = "905550000105"
    send(db, phone, "text", "hi")
    send(db, phone, "list", "other")
    # "other" has a single required field (description) — finish it, then replay.
    last = send(db, phone, "text", "please call me back", message_id="wamid.sim.finish")
    assert last.completed_case is not None
    replay = send(
        db, phone, "text", "please call me back", message_id="wamid.sim.finish"
    )
    assert replay.completed_case is None
    count = db.query(
        "select count(*)::int as n from cases where merchant_id = $1 and customer_wa_id = $2",
        [DEMO_MERCHANT_ID, phone],
    )
    assert count[0]["n"] == 1


@pytest.mark.parametrize(
    "preset", [p for p in PRESETS if not p.replay_greeting], ids=lambda p: p.id
)
def test_completes_the_actual_ui_preset_without_rejection_or_looping(
    db: ConnectionDatabase, preset: Preset
) -> None:
    phone = "905550000108"
    notices: list[str] = []
    completed: list[Any] = []
    sent = 0

    def send_message(message: SimulatorMessageInput) -> SimulatorResponse:
        nonlocal sent
        sent += 1
        response = send(db, phone, message.kind, message.value, message.message_id)
        assert response.error is None
        if response.completed_case:
            completed.append(response.completed_case)
        return response

    play_preset(
        preset,
        lambda: action(db, "reset", phone),
        send_message,
        lambda: False,
        notices.append,
    )
    assert completed
    assert notices == []
    assert sent < 10


def test_aging_a_conversation_immediately_nudges_once_then_exposes_its_abandoned_case(
    db: ConnectionDatabase,
) -> None:
    phone = "905550000109"
    send(db, phone, "text", "hi")
    send(db, phone, "list", "return")
    send(db, phone, "list", "doesnt_fit")
    send(db, phone, "text", "100432")

    def age(minutes: int) -> SimulatorResponse:
        return action(db, "time_travel", phone, ageMinutes=minutes)

    nudged = age(5)
    assert len(nudged.outbound) == 1
    assert nudged.notice is not None and "nudged 1" in nudged.notice
    assert (
        nudged.session is not None
        and nudged.session["fields"]["order_number"]["normalized"] == "100432"
    )
    again = age(5)
    assert again.outbound == []
    assert again.notice is not None and "already received its nudge" in again.notice
    abandoned = age(1440)
    assert abandoned.session is None
    assert abandoned.completed_case is not None
    assert abandoned.completed_case["status"] == "abandoned"
    assert abandoned.completed_case["fields"]["order_number"] == "100432"
