"""Port of db/tenancy.integration.test.ts: two merchants with different
taxonomies, interleaved conversations from the *same* customer number, and
nothing crossing between them."""

from __future__ import annotations

from dataclasses import replace
from typing import Any

import psycopg.errors
import pytest

from chicchat.db.case_queries import get_case_detail, list_cases
from chicchat.db.config import DEMO_MERCHANT_ID, load_merchant_config
from chicchat.db.console import (
    QueueFilters,
    add_case_note,
    get_case_workflow,
    list_case_events,
    list_queue,
    transition_case,
)
from chicchat.db.database import ConnectionDatabase
from chicchat.db.merchants import primary_channel, resolve_merchant_by_phone_number_id
from chicchat.db.sessions import load_session_meta
from chicchat.db.taxonomy import list_rules
from chicchat.db.transcript import list_transcript
from chicchat.domain.cases.filters import CaseFilters, parse_case_filters
from chicchat.domain.result import Err, Ok
from tests.db.helpers import say, simulate

SECOND_MERCHANT_ID = "00000000-0000-0000-0000-000000000003"
SECOND_PHONE_NUMBER_ID = "second-merchant-phone-number-id"
ALL_QUEUES = QueueFilters(queue=None, category_key=None, status=None)


def filters(**overrides: Any) -> CaseFilters:
    base = parse_case_filters({})
    assert isinstance(base, Ok)
    return replace(base.value, **overrides)


def row_ids(response: Any) -> list[str]:
    message = response.outbound[0] if response.outbound else None
    if not message or message["type"] != "interactive":
        return []
    return [
        r["id"] for s in message["interactive"]["action"]["sections"] for r in s["rows"]
    ]


def test_maps_each_seeded_number_to_its_own_merchant(db: ConnectionDatabase) -> None:
    second = resolve_merchant_by_phone_number_id(db, SECOND_PHONE_NUMBER_ID)
    assert second is not None
    assert (second.merchant_id, second.merchant_name) == (
        SECOND_MERCHANT_ID,
        "Butik Moda",
    )
    demo_channel = primary_channel(db, DEMO_MERCHANT_ID)
    assert demo_channel is not None
    demo = resolve_merchant_by_phone_number_id(db, demo_channel.phone_number_id)
    assert demo is not None and demo.merchant_id == DEMO_MERCHANT_ID


def test_returns_null_for_an_unknown_number_instead_of_guessing_a_tenant(
    db: ConnectionDatabase,
) -> None:
    assert resolve_merchant_by_phone_number_id(db, "not-a-configured-number") is None


def test_refuses_to_let_two_merchants_claim_the_same_number(
    db: ConnectionDatabase,
) -> None:
    demo_channel = primary_channel(db, DEMO_MERCHANT_ID)
    assert demo_channel is not None
    with pytest.raises(psycopg.errors.UniqueViolation), db.transaction() as tx:
        tx.query(
            "insert into whatsapp_channels (merchant_id, phone_number_id) values ($1, $2)",
            [SECOND_MERCHANT_ID, demo_channel.phone_number_id],
        )


def test_offers_each_merchants_own_categories_to_the_same_customer(
    db: ConnectionDatabase,
) -> None:
    phone = "905550000701"
    first = say(db, DEMO_MERCHANT_ID, phone, "text", "hello")
    second = say(db, SECOND_MERCHANT_ID, phone, "text", "merhaba")
    assert "return" in row_ids(first) and "iade" not in row_ids(first)
    assert "iade" in row_ids(second) and "return" not in row_ids(second)


def test_keeps_interleaved_sessions_for_one_phone_entirely_separate(
    db: ConnectionDatabase,
) -> None:
    phone = "905550000702"
    say(db, DEMO_MERCHANT_ID, phone, "text", "hello")
    say(db, SECOND_MERCHANT_ID, phone, "text", "merhaba")
    say(db, DEMO_MERCHANT_ID, phone, "list", "return")
    say(db, SECOND_MERCHANT_ID, phone, "list", "iade")
    say(db, DEMO_MERCHANT_ID, phone, "list", "doesnt_fit")
    second_asking = say(db, SECOND_MERCHANT_ID, phone, "list", "beden")
    first_session = load_session_meta(db, DEMO_MERCHANT_ID, phone)
    second_session = load_session_meta(db, SECOND_MERCHANT_ID, phone)
    assert first_session is not None and second_session is not None
    assert first_session["state"]["categoryKey"] == "return"
    assert first_session["state"].get("pendingFieldKey") == "order_number"
    assert second_session["state"]["categoryKey"] == "iade"
    assert second_session["state"].get("pendingFieldKey") == "siparis_no"
    assert second_asking.session["subcategoryKey"] == "beden"


def test_files_each_completed_case_against_its_own_merchant_invisible_to_the_other(
    db: ConnectionDatabase,
) -> None:
    phone = "905550000703"
    say(db, SECOND_MERCHANT_ID, phone, "text", "merhaba")
    say(db, SECOND_MERCHANT_ID, phone, "list", "kargo")
    say(db, SECOND_MERCHANT_ID, phone, "list", "gelmedi")
    done = say(db, SECOND_MERCHANT_ID, phone, "text", "BM12345")
    case = done.completed_case
    assert case is not None
    case_id = case["case_id"]
    # Its own routing rules applied — not the other merchant's.
    assert (case["category"], case["queue"], case["priority"], case["status"]) == (
        "kargo",
        "kargo_takip",
        "high",
        "escalated",
    )
    # Visible to its owner…
    assert any(
        r["id"] == case_id for r in list_cases(db, SECOND_MERCHANT_ID, filters()).rows
    )
    assert get_case_detail(db, SECOND_MERCHANT_ID, case_id) is not None
    # …and to nobody else, on every read path the console uses.
    assert all(
        r["id"] != case_id for r in list_cases(db, DEMO_MERCHANT_ID, filters()).rows
    )
    assert get_case_detail(db, DEMO_MERCHANT_ID, case_id) is None
    assert all(r["id"] != case_id for r in list_queue(db, DEMO_MERCHANT_ID, ALL_QUEUES))
    assert get_case_workflow(db, DEMO_MERCHANT_ID, case_id) is None
    assert list_case_events(db, DEMO_MERCHANT_ID, case_id) == []
    assert list_transcript(db, DEMO_MERCHANT_ID, case_id) == []


def test_shows_and_searches_the_order_number_under_the_tenants_own_field_name(
    db: ConnectionDatabase,
) -> None:
    phone = "905550000706"
    say(db, SECOND_MERCHANT_ID, phone, "text", "merhaba")
    say(db, SECOND_MERCHANT_ID, phone, "list", "kargo")
    say(db, SECOND_MERCHANT_ID, phone, "list", "gecikti")
    # Butik Moda calls the field `siparis_no`, not `order_number`.
    done = say(db, SECOND_MERCHANT_ID, phone, "text", " bm-98 765 ")
    case_id = done.completed_case["case_id"]
    assert done.completed_case["fields"]["siparis_no"] == "BM98765"
    row = next(
        r
        for r in list_cases(db, SECOND_MERCHANT_ID, filters()).rows
        if r["id"] == case_id
    )
    assert row["order_number"] == "BM98765"
    queued = next(
        r for r in list_queue(db, SECOND_MERCHANT_ID, ALL_QUEUES) if r["id"] == case_id
    )
    assert queued["order_number"] == "BM98765"
    searched = list_cases(db, SECOND_MERCHANT_ID, filters(order_number="BM98765"))
    assert any(r["id"] == case_id for r in searched.rows)


def test_refuses_writes_from_the_wrong_tenant(db: ConnectionDatabase) -> None:
    phone = "905550000704"
    say(db, SECOND_MERCHANT_ID, phone, "text", "merhaba")
    say(db, SECOND_MERCHANT_ID, phone, "list", "kargo")
    say(db, SECOND_MERCHANT_ID, phone, "list", "gecikti")
    case_id = say(db, SECOND_MERCHANT_ID, phone, "text", "BM99999").completed_case[
        "case_id"
    ]
    assert transition_case(db, DEMO_MERCHANT_ID, case_id, "in_progress") == Err(
        "case not found"
    )
    assert add_case_note(db, DEMO_MERCHANT_ID, case_id, "not mine") == Err(
        "case not found"
    )
    # The owner can still work it, so the refusal was scoping and not a lock.
    assert transition_case(db, SECOND_MERCHANT_ID, case_id, "in_progress").ok


def test_keeps_configuration_and_routing_rules_per_merchant(
    db: ConnectionDatabase,
) -> None:
    first = load_merchant_config(db, DEMO_MERCHANT_ID)
    second = load_merchant_config(db, SECOND_MERCHANT_ID)
    assert first is not None and second is not None
    assert "return" in [c.key for c in first.categories]
    assert [c.key for c in second.categories] == ["iade", "kargo"]
    assert first.settings["return_window_days"] == 30
    assert second.settings["return_window_days"] == 14
    assert [r["target_queue"] for r in list_rules(db, SECOND_MERCHANT_ID)] == [
        "iade_istisna",
        "iade_kuyrugu",
        "kargo_takip",
    ]
    assert all(
        r["target_queue"] != "iade_kuyrugu" for r in list_rules(db, DEMO_MERCHANT_ID)
    )


def test_gives_each_merchant_its_own_idempotency_ledger(db: ConnectionDatabase) -> None:
    phone = "905550000705"
    message_id = "wamid.shared.across.tenants"

    def deliver(merchant_id: str, value: str) -> Any:
        return simulate(
            db,
            "message",
            phone,
            merchant_id,
            message={"kind": "text", "value": value, "messageId": message_id},
        )

    first = deliver(DEMO_MERCHANT_ID, "hello")
    second = deliver(SECOND_MERCHANT_ID, "merhaba")
    assert len(first.outbound) == 1
    assert len(second.outbound) == 1
    assert second.error is None
    replay = deliver(SECOND_MERCHANT_ID, "merhaba")
    assert "duplicate" in replay.error
