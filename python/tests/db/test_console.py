"""Port of db/console.integration.test.ts (SPEC §9): a simulator case lands in
the queue its routing rules dictate, then flows open → in_progress → resolved
with a note — with the transcript and audit trail an agent needs."""

from __future__ import annotations

from typing import Any

from chicchat.db.config import DEMO_MERCHANT_ID
from chicchat.db.console import (
    QueueFilters,
    add_case_note,
    get_case_workflow,
    list_case_events,
    list_queue,
    list_queues,
    transition_case,
)
from chicchat.db.database import ConnectionDatabase
from chicchat.db.transcript import list_transcript
from chicchat.domain.result import Err, Ok
from tests.db.helpers import complete_intake, say, simulate

DAMAGE_ANSWERS = {
    "order_number": ("text", "#tr-100 432"),
    "item_ref": ("text", "red dress"),
    "description": ("text", "seam torn"),
    "photo": ("photo", "media.sim.torn"),
}
RETURN_ANSWERS = {
    "order_number": ("text", "#tr-555 555"),
    "item_ref": ("text", "blue shirt"),
    "reason": ("list", "wrong_size"),
    "condition": ("list", "unworn_tags_on"),
}


def filters(**overrides: Any) -> QueueFilters:
    return QueueFilters(
        **{"queue": None, "category_key": None, "status": None, **overrides}
    )


def intake(
    db: ConnectionDatabase,
    phone: str,
    subcategory: str = "damaged",
    category: str = "wrong_damaged_missing",
    answers: dict[str, tuple[str, str]] = DAMAGE_ANSWERS,
) -> Any:
    return complete_intake(db, DEMO_MERCHANT_ID, phone, category, subcategory, answers)


def test_routes_a_damaged_item_with_a_photo_to_priority_replacements_at_high_priority(
    db: ConnectionDatabase,
) -> None:
    done = intake(db, "905550000601")
    case = done.completed_case
    assert (case["queue"], case["priority"], case["status"]) == (
        "priority_replacements",
        "high",
        "open",
    )
    events = list_case_events(db, DEMO_MERCHANT_ID, case["case_id"])
    routing = next(e for e in events if e["kind"] == "routing")
    assert "priority_replacements" in routing["body"]
    assert routing["actor"] == "system"
    # Only holds if rule precedence follows sort_order, not insertion order.
    assert "rule 1" in routing["body"]


def test_escalates_a_missing_item_to_verify_order_contents(
    db: ConnectionDatabase,
) -> None:
    case = intake(db, "905550000602", "item_missing").completed_case
    assert (case["queue"], case["status"], case["priority"]) == (
        "verify_order_contents",
        "escalated",
        "normal",
    )


def test_leaves_a_case_unrouted_when_no_rule_matches_and_still_queues_it(
    db: ConnectionDatabase,
) -> None:
    case = intake(
        db, "905550000603", "doesnt_fit", "return", RETURN_ANSWERS
    ).completed_case
    # The default return rules key off `within_return_window`, which no
    # integration supplies in Tier 0 (SPEC §2), so nothing matches.
    assert (case["queue"], case["priority"], case["status"]) == (None, "normal", "open")
    unrouted = list_queue(db, DEMO_MERCHANT_ID, filters(queue="unrouted"))
    assert any(r["id"] == case["case_id"] for r in unrouted)


def test_sorts_the_queue_by_priority_then_by_how_long_it_has_waited(
    db: ConnectionDatabase,
) -> None:
    high = intake(db, "905550000604", "damaged").completed_case
    normal = intake(db, "905550000605", "item_missing").completed_case
    rows = list_queue(
        db, DEMO_MERCHANT_ID, filters(category_key="wrong_damaged_missing")
    )
    ids = [r["id"] for r in rows]
    assert ids.index(high["case_id"]) < ids.index(normal["case_id"])


def test_summarizes_the_queues_with_their_outstanding_and_high_priority_counts(
    db: ConnectionDatabase,
) -> None:
    intake(db, "905550000606")
    priority = next(
        q
        for q in list_queues(db, DEMO_MERCHANT_ID)
        if q["queue"] == "priority_replacements"
    )
    assert priority["n"] > 0
    assert priority["high"] > 0


def test_flows_open_in_progress_resolved_with_a_note_and_records_each_step(
    db: ConnectionDatabase,
) -> None:
    case_id = intake(db, "905550000607").completed_case["case_id"]
    started = transition_case(db, DEMO_MERCHANT_ID, case_id, "in_progress")
    assert isinstance(started, Ok)
    assert (started.value.from_status, started.value.to_status) == (
        "open",
        "in_progress",
    )
    assert add_case_note(db, DEMO_MERCHANT_ID, case_id, "replacement dispatched") == Ok(
        None
    )
    assert transition_case(
        db, DEMO_MERCHANT_ID, case_id, "resolved", "customer confirmed"
    ).ok
    workflow = get_case_workflow(db, DEMO_MERCHANT_ID, case_id)
    assert workflow is not None and workflow["status"] == "resolved"
    # Reaching a terminal status stops the clock.
    assert workflow["resolved_at"] is not None
    events = list_case_events(db, DEMO_MERCHANT_ID, case_id)
    assert [e["kind"] for e in events] == [
        "routing",
        "status_change",
        "note",
        "status_change",
    ]
    assert (events[1]["from_status"], events[1]["to_status"]) == ("open", "in_progress")
    assert events[2]["body"] == "replacement dispatched"
    assert events[3]["body"] == "customer confirmed"
    # A resolved case has left the work queue.
    assert all(r["id"] != case_id for r in list_queue(db, DEMO_MERCHANT_ID, filters()))


def test_refuses_an_illegal_transition_against_the_cases_current_status(
    db: ConnectionDatabase,
) -> None:
    case_id = intake(db, "905550000608").completed_case["case_id"]
    skipped = transition_case(db, DEMO_MERCHANT_ID, case_id, "closed")
    assert isinstance(skipped, Err) and "cannot move" in skipped.error
    workflow = get_case_workflow(db, DEMO_MERCHANT_ID, case_id)
    assert workflow is not None and workflow["status"] == "open"
    assert [
        e
        for e in list_case_events(db, DEMO_MERCHANT_ID, case_id)
        if e["kind"] == "status_change"
    ] == []


def test_does_not_act_on_another_merchants_case(db: ConnectionDatabase) -> None:
    other = db.query("insert into merchants (name) values ('Other Co.') returning id")[
        0
    ]["id"]
    case_id = intake(db, "905550000609").completed_case["case_id"]
    assert transition_case(db, other, case_id, "in_progress") == Err("case not found")
    assert add_case_note(db, other, case_id, "should not land") == Err("case not found")
    assert get_case_workflow(db, other, case_id) is None
    assert list_transcript(db, other, case_id) == []


def test_records_both_sides_of_the_intake_and_attaches_it_to_the_case(
    db: ConnectionDatabase,
) -> None:
    case_id = intake(db, "905550000610").completed_case["case_id"]
    transcript = list_transcript(db, DEMO_MERCHANT_ID, case_id)
    # Greeting + 2 taps + 4 answers inbound, each with a reply out.
    assert len([m for m in transcript if m["direction"] == "inbound"]) == 7
    assert len([m for m in transcript if m["direction"] == "outbound"]) == 7
    assert (transcript[0]["direction"], transcript[0]["body"]) == ("inbound", "merhaba")
    assert "Please pick a topic" in transcript[1]["body"]
    assert any(m["body"] == 'tapped "damaged"' for m in transcript)
    assert any("media.sim.torn" in (m["body"] or "") for m in transcript)
    # Every inbound entry is correlated to its WhatsApp message id.
    assert all(m["wa_message_id"] for m in transcript if m["direction"] == "inbound")


def test_keeps_the_exchange_when_a_message_fails_alongside_the_generic_reply(
    db: ConnectionDatabase,
) -> None:
    phone = "905550000611"
    failed = say(
        db, DEMO_MERCHANT_ID, phone, "text", "merhaba", inject="handler_exception"
    )
    assert "processing failed" in failed.error
    rows = db.query(
        """select direction, body from conversation_messages
        where merchant_id = $1 and customer_wa_id = $2
        order by created_at, id""",
        [DEMO_MERCHANT_ID, phone],
    )
    assert len(rows) == 2
    assert (rows[0]["direction"], rows[0]["body"]) == ("inbound", "merhaba")
    assert "something went wrong" in rows[1]["body"]


def test_keeps_an_abandoned_intakes_transcript_with_its_case(
    db: ConnectionDatabase,
) -> None:
    phone = "905550000612"
    say(db, DEMO_MERCHANT_ID, phone, "text", "merhaba")
    say(db, DEMO_MERCHANT_ID, phone, "list", "return")
    say(db, DEMO_MERCHANT_ID, phone, "list", "doesnt_fit")
    say(db, DEMO_MERCHANT_ID, phone, "text", "#tr-555 555")
    swept = simulate(db, "time_travel", phone, DEMO_MERCHANT_ID, ageMinutes=25 * 60)
    assert "abandoned 1" in swept.notice
    rows = db.query(
        "select id from cases where merchant_id = $1 and customer_wa_id = $2 and status = 'abandoned'",
        [DEMO_MERCHANT_ID, phone],
    )
    transcript = list_transcript(db, DEMO_MERCHANT_ID, rows[0]["id"])
    assert len(transcript) > 0
    assert transcript[0]["body"] == "merhaba"
