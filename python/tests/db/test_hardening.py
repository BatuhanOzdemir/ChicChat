"""Port of db/hardening.integration.test.ts (SPEC §§11–13): inactivity nudge →
resume with progress intact → abandonment, transactional persistence, and the
unexpected-error path."""

from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import Any

import pytest

from chicchat.db.cases import CaseItemInput, PersistCaseInput, persist_case
from chicchat.db.config import DEMO_MERCHANT_ID
from chicchat.db.database import ConnectionDatabase
from chicchat.db.sessions import load_session
from chicchat.domain.whatsapp.types import OutboundMessage
from chicchat.server.maintenance import MaintenanceDeps, run_session_maintenance
from chicchat.server.whatsapp.handler import IntakeDeps, handle_inbound
from tests.db.helpers import RecordingLogger, sent_to, simulate


def sim(db: ConnectionDatabase, action: str, phone: str, **extra: Any) -> Any:
    return simulate(db, action, phone, DEMO_MERCHANT_ID, **extra)


PHONE = "905550000201"


def start_partial_intake(db: ConnectionDatabase) -> None:
    """Start a return intake and answer one field, so there is progress to keep."""
    sim(db, "message", PHONE, message={"kind": "text", "value": "hi"})
    sim(db, "message", PHONE, message={"kind": "list", "value": "return"})
    sim(db, "message", PHONE, message={"kind": "list", "value": "doesnt_fit"})
    sim(db, "message", PHONE, message={"kind": "text", "value": "unworn_tags_on"})


def test_nudges_once_at_5_minutes_resumes_with_progress_intact_then_abandons(
    db: ConnectionDatabase,
) -> None:
    start_partial_intake(db)
    captured = (sim(db, "state", PHONE).session or {}).get("fields", {})
    assert len(captured) > 0

    # Not yet idle enough.
    assert sent_to(sim(db, "maintenance", PHONE), PHONE) == []

    # Age past nudge_after_minutes (default 5) and run the job.
    nudged = sim(db, "time_travel", PHONE, ageMinutes=6)
    nudge = sent_to(nudged, PHONE)[0]
    assert nudge["type"] == "text"
    assert re.search(r"pick up|left off", nudge["text"]["body"], re.IGNORECASE)
    assert re.search(r"nudged [1-9]", nudged.notice)

    # Exactly one nudge: running again sends nothing to this customer.
    assert sent_to(sim(db, "maintenance", PHONE), PHONE) == []

    # Progress survived the nudge, and the customer resumes where they were.
    after_nudge = sim(db, "state", PHONE)
    assert len(after_nudge.session["fields"]) == len(captured)
    resumed = sim(db, "message", PHONE, message={"kind": "text", "value": "blue shirt"})
    assert len(resumed.session["fields"]) > len(captured)
    # Activity clears the nudged flag so the session is live again.
    status = db.query(
        "select status from intake_sessions where merchant_id = $1 and customer_wa_id = $2",
        [DEMO_MERCHANT_ID, PHONE],
    )
    assert status[0]["status"] == "active"

    # Age past abandon_after_hours (default 24): the work becomes a case.
    abandoned = sim(db, "time_travel", PHONE, ageMinutes=25 * 60)
    assert "abandoned 1" in abandoned.notice
    assert load_session(db, DEMO_MERCHANT_ID, PHONE) is None
    rows = db.query(
        "select status from cases where merchant_id = $1 and customer_wa_id = $2",
        [DEMO_MERCHANT_ID, PHONE],
    )
    assert [r["status"] for r in rows] == ["abandoned"]


def test_deletes_an_empty_abandoned_session_instead_of_filing_an_empty_case(
    db: ConnectionDatabase,
) -> None:
    phone = "905550000202"
    sim(db, "message", phone, message={"kind": "text", "value": "hi"})
    result = sim(db, "time_travel", phone, ageMinutes=25 * 60)
    assert "deleted 1" in result.notice
    assert (
        db.query(
            "select count(*)::int as n from cases where customer_wa_id = $1", [phone]
        )[0]["n"]
        == 0
    )


def test_honours_a_merchants_configured_thresholds(db: ConnectionDatabase) -> None:
    phone = "905550000203"
    db.query(
        "update merchant_config set nudge_after_minutes = 60 where merchant_id = $1",
        [DEMO_MERCHANT_ID],
    )
    sim(db, "message", phone, message={"kind": "text", "value": "hi"})
    sim(db, "time_travel", phone, ageMinutes=10)
    assert sent_to(sim(db, "maintenance", phone), phone) == []
    assert len(sent_to(sim(db, "time_travel", phone, ageMinutes=55), phone)) == 1


def test_keeps_sweeping_when_one_conversation_fails(db: ConnectionDatabase) -> None:
    logger = RecordingLogger()
    # Two idle sessions; the first send explodes the way an expired WhatsApp
    # token does. The job must still reach the second one.
    doomed, other = "905550000205", "905550000206"
    for phone in (doomed, other):
        sim(db, "message", phone, message={"kind": "text", "value": "hi"})
    db.query(
        """update intake_sessions set updated_at = now() - interval '30 minutes'
        where merchant_id = $1 and customer_wa_id = any($2)""",
        [DEMO_MERCHANT_ID, [doomed, other]],
    )
    sent: list[str] = []

    def send(_merchant_id: str, message: OutboundMessage) -> None:
        if message["to"] == doomed:
            raise RuntimeError("access token expired")
        sent.append(message["to"])

    summary = run_session_maintenance(
        MaintenanceDeps(db=db, logger=logger, send=send),
        datetime.now(UTC),
        DEMO_MERCHANT_ID,
    )
    assert summary.failed >= 1
    assert other in sent
    # The failure is visible rather than swallowed.
    assert any(
        line["event"] == "unexpected_exception"
        and line["context"].get("during") == "session_maintenance"
        for line in logger.lines
    )


def test_leaves_no_partial_case_when_a_write_fails_mid_way(
    db: ConnectionDatabase,
) -> None:
    phone = "905550000204"
    # qty is an integer column; a non-numeric value fails the *second* insert,
    # after the case row and its fields were already written in the same tx.
    with pytest.raises(Exception):  # noqa: B017 — any database error will do
        persist_case(
            db,
            PersistCaseInput(
                merchant_id=DEMO_MERCHANT_ID,
                customer_wa_id=phone,
                category_key="return",
                subcategory_key="doesnt_fit",
                fields=[
                    {"key": "order_number", "raw": "TR100432", "normalized": "TR100432"}
                ],
                items=[
                    CaseItemInput("li_ok", "fine", qty=1),
                    CaseItemInput("li_bad", "breaks", qty="not-a-number"),  # type: ignore[arg-type]
                ],
            ),
        )
    # Nothing at all survived: no case, and therefore no orphan fields/items.
    assert (
        db.query(
            "select count(*)::int as n from cases where customer_wa_id = $1", [phone]
        )[0]["n"]
        == 0
    )


def test_emits_one_correlated_structured_log_line_with_a_masked_phone(
    db: ConnectionDatabase,
) -> None:
    phone = "905550000205"
    logger = RecordingLogger()
    outbound: list[OutboundMessage] = []

    def explode() -> None:
        raise RuntimeError("machine exploded")

    result = handle_inbound(
        IntakeDeps(db=db, logger=logger, before_advance=explode, send=outbound.append),
        DEMO_MERCHANT_ID,
        {
            "phoneNumberId": "PNID",
            "from": phone,
            "messageId": "wamid.err.1",
            "kind": "text",
            "reply": "hi",
        },
    )
    assert result.failed is True
    assert len(outbound) == 1
    exceptions = [
        line for line in logger.lines if line["event"] == "unexpected_exception"
    ]
    assert len(exceptions) == 1
    assert exceptions[0]["context"]["correlationId"] == "wamid.err.1"
    assert exceptions[0]["context"]["merchantId"] == DEMO_MERCHANT_ID
    assert any(line["event"] == "session_errored" for line in logger.lines)
    rows = db.query(
        "select status, last_error from intake_sessions where merchant_id = $1 and customer_wa_id = $2",
        [DEMO_MERCHANT_ID, phone],
    )
    assert rows[0]["status"] == "errored"
    assert "machine exploded" in rows[0]["last_error"]
