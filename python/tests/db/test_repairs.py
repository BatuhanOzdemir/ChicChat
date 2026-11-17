"""Port of db/repairs.integration.test.ts: the September repair gates, run on
independent PostgreSQL connections.

These tests commit real transactions and race real workers (threads here,
`Promise.all` in TypeScript), so the conftest only allows a local `_test`
database. Every test uses fresh random merchant ids and deletes them after.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import UTC, datetime
from typing import Any

import pytest

from chicchat.db.auth import login, session_principal
from chicchat.db.case_queries import case_counters, get_case_detail, list_cases
from chicchat.db.cases import build_handoff
from chicchat.db.client import PoolDatabase
from chicchat.db.console import QueueFilters, list_queue
from chicchat.db.media import case_photo, save_photo
from chicchat.db.privacy import enforce_retention, erase_customer
from chicchat.domain.auth.credentials import hash_password, token_hash
from chicchat.domain.cases.filters import parse_case_filters
from chicchat.domain.result import Ok
from chicchat.domain.simulator.protocol import SimulatorRequest
from chicchat.domain.whatsapp.types import InboundMessage, OutboundMessage
from chicchat.server.maintenance import MaintenanceDeps, run_session_maintenance
from chicchat.server.simulator import run_simulator_action
from chicchat.server.whatsapp.handler import IntakeDeps, IntakeResult, handle_inbound
from chicchat.server.whatsapp.inbox import (
    AcceptedMessage,
    accept_messages,
    process_inbox,
)
from chicchat.server.whatsapp.outbox import retry_replies
from tests.db.helpers import RecordingLogger

PHONE = "905550009876"


def no_send(*_args: Any) -> None:
    return None


class Gate:
    """One test's isolated tenant: two merchants, a category, two fields."""

    def __init__(self, db: PoolDatabase) -> None:
        self.db = db
        self.merchant = str(uuid.uuid4())
        self.other = str(uuid.uuid4())
        self.category = str(uuid.uuid4())

    def count(self, sql: str, params: list[object]) -> int:
        return len(self.db.query(sql, params))

    def inbound(
        self, reply: str, message_id: str | None = None, phone: str = PHONE
    ) -> InboundMessage:
        return {
            "from": phone,
            "phoneNumberId": "test",
            "messageId": message_id or str(uuid.uuid4()),
            "kind": "text",
            "reply": reply,
        }

    def say(
        self,
        reply: str,
        send: Callable[[OutboundMessage], None] = no_send,
        message_id: str | None = None,
    ) -> IntakeResult:
        return handle_inbound(
            IntakeDeps(db=self.db, send=send, logger=RecordingLogger()),
            self.merchant,
            self.inbound(reply, message_id),
        )

    def start(self) -> None:
        self.say("hello")
        self.say("repair")

    def finish(self) -> str:
        self.start()
        self.say("alpha")
        case_id = self.say("beta").persisted_case_id
        assert case_id is not None
        return case_id


@pytest.fixture
def gate(pool_db: PoolDatabase) -> Iterator[Gate]:
    g = Gate(pool_db)
    db = pool_db
    db.query(
        "insert into merchants(id,name) values ($1,'Repair gate'),($2,'Isolation gate')",
        [g.merchant, g.other],
    )
    db.query(
        "insert into merchant_config(merchant_id) values ($1),($2)",
        [g.merchant, g.other],
    )
    db.query(
        "insert into categories(id,merchant_id,key,label) values ($1,$2,'repair','Repair category')",
        [g.category, g.merchant],
    )
    db.query(
        """insert into field_defs(category_id,key,type,required,sort_order,normalize_rule)
      values ($1,'first','string',true,1,'order_number'),($1,'second','string',true,2,null)""",
        [g.category],
    )
    try:
        yield g
    finally:
        db.query("delete from console_users where username=$1", [g.merchant])
        db.query("delete from console_login_attempts where username=$1", [g.merchant])
        db.query("delete from merchants where id=any($1)", [[g.merchant, g.other]])


def in_parallel(*calls: Callable[[], Any]) -> list[Any]:
    """`Promise.all`: run the calls on separate threads (and connections)."""
    with ThreadPoolExecutor(max_workers=len(calls)) as pool:
        return [f.result() for f in [pool.submit(call) for call in calls]]


def test_serializes_different_simultaneous_answers_without_losing_progress_or_creating_two_cases(
    gate: Gate,
) -> None:
    gate.start()
    in_parallel(lambda: gate.say("alpha"), lambda: gate.say("beta"))
    rows = gate.db.query("select id from cases where merchant_id=$1", [gate.merchant])
    assert len(rows) == 1
    handoff = build_handoff(gate.db, rows[0]["id"])
    assert {(v or "").lower() for v in handoff["fields"].values()} == {"alpha", "beta"}
    assert (
        gate.count(
            "select 1 from intake_sessions where merchant_id=$1", [gate.merchant]
        )
        == 0
    )


def test_retries_a_failed_reply_on_duplicate_delivery_without_advancing_twice(
    gate: Gate,
) -> None:
    message_id = str(uuid.uuid4())

    def fail(_message: OutboundMessage) -> None:
        raise RuntimeError("temporary transport failure")

    assert gate.say("hello", fail, message_id).failed is True
    sent: list[OutboundMessage] = []
    assert gate.say("hello", sent.append, message_id).duplicate is True
    assert len(sent) == 1
    assert (
        gate.count(
            "select 1 from processed_messages where merchant_id=$1", [gate.merchant]
        )
        == 1
    )
    assert (
        gate.count(
            "select 1 from message_outbox where merchant_id=$1 and delivered_at is null",
            [gate.merchant],
        )
        == 0
    )


def test_refuses_simulator_reset_when_a_number_has_real_accepted_whatsapp_work(
    gate: Gate,
) -> None:
    accept_messages(gate.db, [AcceptedMessage(gate.merchant, gate.inbound("hello"))])
    result = run_simulator_action(
        gate.db,
        SimulatorRequest(action="reset", merchant_id=gate.merchant, phone=PHONE),
    )
    assert result.error is not None and "real WhatsApp activity" in result.error
    assert (
        gate.count("select 1 from message_inbox where merchant_id=$1", [gate.merchant])
        == 1
    )


def test_does_not_let_deferred_conversations_starve_later_due_inbox_and_outbox_work(
    gate: Gate,
) -> None:
    gate.db.query(
        """insert into message_inbox(merchant_id,customer_wa_id,message_id,payload,next_attempt_at)
        select $1, '9055511'||n, 'deferred-in-'||n, '{}',now()+interval '1 hour' from generate_series(1,100) n""",
        [gate.merchant],
    )
    accept_messages(gate.db, [AcceptedMessage(gate.merchant, gate.inbound("hello"))])
    assert process_inbox(gate.db, no_send)["processed"] == 1
    gate.db.query(
        """insert into message_outbox(merchant_id,customer_wa_id,delivery_key,delivery_channel,payload,next_attempt_at)
        select $1, '9055522'||n, 'deferred-out-'||n, 'whatsapp', '{}',now()+interval '1 hour' from generate_series(1,100) n""",
        [gate.merchant],
    )
    handle_inbound(
        IntakeDeps(
            db=gate.db,
            send=no_send,
            logger=RecordingLogger(),
            channel="whatsapp",
            defer_delivery=True,
        ),
        gate.merchant,
        gate.inbound("hello", phone="905553339999"),
    )
    assert retry_replies(gate.db, no_send)["sent"] == 1


def test_accepts_durable_work_once_and_processes_it_in_order_across_concurrent_workers(
    gate: Gate,
) -> None:
    items = [
        AcceptedMessage(gate.merchant, gate.inbound(reply))
        for reply in ("hello", "repair", "alpha", "beta")
    ]
    accept_messages(gate.db, items)
    accept_messages(gate.db, items)
    assert (
        gate.count("select 1 from message_inbox where merchant_id=$1", [gate.merchant])
        == 4
    )
    in_parallel(
        lambda: process_inbox(gate.db, no_send), lambda: process_inbox(gate.db, no_send)
    )
    rows = gate.db.query("select id from cases where merchant_id=$1", [gate.merchant])
    assert len(rows) == 1
    assert build_handoff(gate.db, rows[0]["id"])["fields"] == {
        "first": "ALPHA",
        "second": "beta",
    }
    assert (
        gate.count(
            "select 1 from message_inbox where merchant_id=$1 and processed_at is null",
            [gate.merchant],
        )
        == 0
    )


def test_nudges_once_even_after_resumption_and_a_second_idle_period(gate: Gate) -> None:
    gate.start()
    sent: list[OutboundMessage] = []
    deps = MaintenanceDeps(
        db=gate.db,
        logger=RecordingLogger(),
        send=lambda _m, message: sent.append(message),
    )
    gate.db.query(
        "update intake_sessions set updated_at=now()-interval '6 minutes' where merchant_id=$1",
        [gate.merchant],
    )
    in_parallel(
        lambda: run_session_maintenance(deps, datetime.now(UTC), gate.merchant),
        lambda: run_session_maintenance(deps, datetime.now(UTC), gate.merchant),
    )
    assert len(sent) == 1
    gate.say("alpha")
    gate.db.query(
        "update intake_sessions set updated_at=now()-interval '6 minutes' where merchant_id=$1",
        [gate.merchant],
    )
    run_session_maintenance(deps, datetime.now(UTC), gate.merchant)
    assert len(sent) == 1


class BrokenDeletes:
    """A Database whose transactions refuse `delete from intake_sessions`."""

    def __init__(self, inner: Any) -> None:
        self.inner = inner

    def query(self, sql: str, params: Any = ()) -> list[dict[str, Any]]:
        if "delete from intake_sessions" in sql:
            raise RuntimeError("injected deletion failure")
        rows: list[dict[str, Any]] = self.inner.query(sql, params)
        return rows

    @contextmanager
    def transaction(self) -> Iterator[BrokenDeletes]:
        with self.inner.transaction() as tx:
            yield BrokenDeletes(tx)


def test_rolls_abandonment_back_on_a_delete_failure_and_prevents_duplicate_abandoned_cases(
    gate: Gate,
) -> None:
    gate.start()
    gate.say("alpha")
    gate.db.query(
        "update intake_sessions set updated_at=now()-interval '25 hours' where merchant_id=$1",
        [gate.merchant],
    )

    class Broken(PoolDatabase):
        @contextmanager
        def transaction(self) -> Iterator[Any]:
            with gate.db.transaction() as tx:
                yield BrokenDeletes(tx)

    run_session_maintenance(
        MaintenanceDeps(
            db=Broken(gate.db.pool), send=no_send, logger=RecordingLogger()
        ),
        datetime.now(UTC),
        gate.merchant,
    )
    assert gate.count("select 1 from cases where merchant_id=$1", [gate.merchant]) == 0
    in_parallel(
        *[
            lambda: run_session_maintenance(
                MaintenanceDeps(db=gate.db, send=no_send, logger=RecordingLogger()),
                datetime.now(UTC),
                gate.merchant,
            )
            for _ in (1, 2)
        ]
    )
    assert (
        gate.count(
            "select 1 from cases where merchant_id=$1 and status='abandoned'",
            [gate.merchant],
        )
        == 1
    )


def test_keeps_case_history_filters_counters_queue_and_media_after_category_deletion(
    gate: Gate,
) -> None:
    case_id = gate.finish()
    gate.db.query(
        "update field_defs set type='media' where category_id=$1 and key='second'",
        [gate.category],
    )
    gate.db.query("delete from categories where id=$1", [gate.category])
    detail = get_case_detail(gate.db, gate.merchant, case_id)
    assert detail is not None and detail["category_label"] == "Repair category"
    assert build_handoff(gate.db, case_id)["fields"] == {
        "first": "ALPHA",
        "second": "beta",
    }
    base = parse_case_filters({})
    assert isinstance(base, Ok)
    from dataclasses import replace

    assert (
        list_cases(
            gate.db,
            gate.merchant,
            replace(base.value, category_key="repair", order_number="ALPHA"),
        ).total
        == 1
    )
    assert (
        len(
            list_queue(
                gate.db,
                gate.merchant,
                QueueFilters(queue=None, category_key="repair", status=None),
            )
        )
        == 1
    )
    assert (
        case_counters(gate.db, gate.merchant).by_category[0]["category_key"] == "repair"
    )


def test_erases_all_customer_data_and_pending_work_without_touching_another_tenant(
    gate: Gate,
) -> None:
    gate.finish()

    def offline(_message: OutboundMessage) -> None:
        raise RuntimeError("offline")

    gate.say("hello", offline)
    accept_messages(gate.db, [AcceptedMessage(gate.merchant, gate.inbound("pending"))])
    save_photo(gate.db, gate.merchant, PHONE, "media", b"photo", "image/png")
    gate.db.query(
        "insert into conversation_messages(merchant_id,customer_wa_id,direction,kind,body) values ($1,$2,'inbound','text','keep')",
        [gate.other, PHONE],
    )
    erase_customer(gate.db, gate.merchant, PHONE)
    for table in (
        "cases",
        "intake_sessions",
        "processed_messages",
        "conversation_messages",
        "conversation_media",
        "message_inbox",
        "message_outbox",
    ):
        assert (
            gate.count(
                f"select 1 from {table} where merchant_id=$1 and customer_wa_id=$2",
                [gate.merchant, PHONE],
            )
            == 0
        ), table
    process_inbox(gate.db, no_send)
    assert (
        gate.count(
            "select 1 from conversation_messages where merchant_id=$1", [gate.other]
        )
        == 1
    )


def test_retains_newer_cases_for_a_phone_while_deleting_expired_records_and_orphan_transcripts(
    gate: Gate,
) -> None:
    old = gate.finish()
    fresh = gate.finish()
    gate.db.query(
        "update cases set created_at=now()-interval '13 months' where id=$1", [old]
    )
    gate.db.query(
        "insert into conversation_messages(merchant_id,customer_wa_id,direction,kind,body,created_at) values ($1,$2,'inbound','text','old orphan',now()-interval '13 months')",
        [gate.merchant, PHONE],
    )
    enforce_retention(gate.db)
    assert get_case_detail(gate.db, gate.merchant, old) is None
    assert get_case_detail(gate.db, gate.merchant, fresh) is not None
    assert (
        gate.count(
            "select 1 from conversation_messages where merchant_id=$1 and (case_id=$2 or body='old orphan')",
            [gate.merchant, old],
        )
        == 0
    )


def test_uses_opaque_sessions_scopes_memberships_rejects_tampering_and_respects_revocation(
    gate: Gate,
) -> None:
    user = str(uuid.uuid4())
    gate.db.query(
        "insert into console_users(id,username,password_hash) values ($1,$2,$3)",
        [user, gate.merchant, hash_password("correct-test-password")],
    )
    gate.db.query(
        "insert into console_memberships values ($1,$2)", [user, gate.merchant]
    )
    assert login(gate.db, gate.merchant, "wrong-password") is None
    token = login(gate.db, gate.merchant, "correct-test-password")
    assert token is not None
    assert len(token) == 64 and all(c in "0123456789abcdef" for c in token)
    principal = session_principal(gate.db, token)
    assert principal is not None and principal.merchant_ids == [gate.merchant]
    assert session_principal(gate.db, token[:63] + "z") is None
    gate.db.query(
        "update console_sessions set expires_at=now()-interval '1 second' where token_hash=$1",
        [token_hash(token)],
    )
    assert session_principal(gate.db, token) is None
    following = login(gate.db, gate.merchant, "correct-test-password")
    gate.db.query("update console_users set enabled=false where id=$1", [user])
    assert session_principal(gate.db, following) is None


def test_makes_stored_evidence_accessible_only_to_its_owning_merchant_and_erases_it_with_the_case(
    gate: Gate,
) -> None:
    gate.start()
    save_photo(gate.db, gate.merchant, PHONE, "photo-1", b"test image", "image/png")
    gate.say("alpha")
    case_id = gate.say("beta").persisted_case_id
    assert case_id is not None
    photo = case_photo(gate.db, gate.merchant, case_id, "photo-1")
    assert photo is not None and bytes(photo["content"]) == b"test image"
    assert case_photo(gate.db, gate.other, case_id, "photo-1") is None
    erase_customer(gate.db, gate.merchant, PHONE)
    assert case_photo(gate.db, gate.merchant, case_id, "photo-1") is None
