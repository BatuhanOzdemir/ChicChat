"""Simulator orchestration (SPEC §7) — port of server/simulator/service.ts.

A simulator message is turned into a real Meta webhook envelope, read by the
production `parse_inbound`, and handed to the production `handle_inbound`. Only
the signature check is bypassed and the outbound transport is swapped for an
in-memory recorder, so no Meta credentials are involved anywhere.
"""

from __future__ import annotations

import base64
import secrets
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from chicchat.db.cases import HandoffPackage, build_handoff
from chicchat.db.conversation_lock import lock_conversation
from chicchat.db.database import Database, Queryable, client_database
from chicchat.db.sessions import (
    SessionMeta,
    age_session,
    delete_session,
    load_session_meta,
)
from chicchat.domain.intake.types import IntakeState
from chicchat.domain.simulator.envelope import EnvelopeContext, build_inbound_envelope
from chicchat.domain.simulator.protocol import SimulatorRequest
from chicchat.domain.whatsapp import parse_inbound
from chicchat.domain.whatsapp.types import OutboundMessage
from chicchat.server.logger import error_message
from chicchat.server.maintenance import MaintenanceDeps, run_session_maintenance
from chicchat.server.whatsapp.handler import IntakeDeps, handle_inbound
from chicchat.server.whatsapp.media import Photo
from chicchat.server.whatsapp.outbox import deliver_replies

SIMULATOR_PHONE_NUMBER_ID = "SIMULATOR"
"""The simulator's own phone_number_id — never a real Meta one."""

# A 1×1 PNG stands in for a customer photo.
_FAKE_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l+0AAAAASUVORK5CYII="
)


@dataclass
class SimulatorResponse:
    outbound: list[OutboundMessage] = field(default_factory=list)
    """Messages the bot would have sent, in order."""
    session: IntakeState | None = None
    """Session state after processing (None when completed or reset)."""
    session_meta: dict[str, Any] | None = None
    completed_case: HandoffPackage | None = None
    """The handoff package, when this message completed an intake."""
    error: str | None = None
    """Set when processing failed (including injected failures)."""
    notice: str | None = None
    """Echo of an injection that is accepted but not yet actionable."""

    def to_json(self) -> dict[str, Any]:
        """The wire shape the browser expects (camelCase, as TypeScript sent)."""
        return {
            "outbound": self.outbound,
            "session": self.session,
            "sessionMeta": self.session_meta,
            "completedCase": self.completed_case,
            "error": self.error,
            "notice": self.notice,
        }


def _base36(number: int) -> str:
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    while True:
        number, rest = divmod(number, 36)
        out = digits[rest] + out
        if number == 0:
            return out


def new_message_id() -> str:
    """`wamid.sim.<ms in base36><6 random base36 chars>`, as TypeScript generated."""
    suffix = "".join(
        secrets.choice("0123456789abcdefghijklmnopqrstuvwxyz") for _ in range(6)
    )
    return f"wamid.sim.{_base36(int(time.time() * 1000))}{suffix}"


def _meta_json(meta: SessionMeta | None) -> dict[str, Any] | None:
    return (
        {"created_at": meta["created_at"], "updated_at": meta["updated_at"]}
        if meta
        else None
    )


def _read_session(
    db: Queryable, merchant_id: str, phone: str
) -> tuple[IntakeState | None, dict[str, Any] | None]:
    meta = load_session_meta(db, merchant_id, phone)
    return (meta["state"] if meta else None), _meta_json(meta)


def run_simulator_action(db: Database, request: SimulatorRequest) -> SimulatorResponse:
    with db.transaction() as tx:
        lock_conversation(tx, request.merchant_id, request.phone)
        rows = tx.query(
            """select 1 from intake_sessions where merchant_id=$1 and customer_wa_id=$2 and delivery_channel='whatsapp'
      union all select 1 from message_inbox where merchant_id=$1 and customer_wa_id=$2 limit 1""",
            [request.merchant_id, request.phone],
        )
        if rows:
            return SimulatorResponse(
                error="This number has real WhatsApp activity. Choose a different fake phone."
            )
        return _run_action(client_database(tx), request)


def _run_action(db: Database, request: SimulatorRequest) -> SimulatorResponse:
    merchant_id, phone = request.merchant_id, request.phone

    if request.action == "retry_delivery":
        outbound: list[OutboundMessage] = []
        result = deliver_replies(
            db, merchant_id, phone, outbound.append, "simulator", True
        )
        state, meta = _read_session(db, merchant_id, phone)
        return SimulatorResponse(
            outbound=outbound,
            session=state,
            session_meta=meta,
            notice=f"Retried delivery: {result.sent} sent",
        )

    if request.action == "reset":
        delete_session(db, merchant_id, phone)
        for table in ("conversation_messages", "conversation_media", "message_outbox"):
            db.query(
                f"delete from {table} where merchant_id=$1 and customer_wa_id=$2 and case_id is null",
                [merchant_id, phone],
            )
        return SimulatorResponse()

    if request.action in ("maintenance", "time_travel"):
        return _maintenance(db, request)

    if request.action == "state":
        state, meta = _read_session(db, merchant_id, phone)
        return SimulatorResponse(session=state, session_meta=meta)

    return _message(db, request)


def _maintenance(db: Database, request: SimulatorRequest) -> SimulatorResponse:
    merchant_id, phone = request.merchant_id, request.phone
    aged = (
        age_session(db, merchant_id, phone, request.age_minutes or 0)
        if request.action == "time_travel"
        else False
    )
    if request.action == "time_travel" and not aged:
        return SimulatorResponse(
            notice="No active session to age. Start a conversation first."
        )
    outbound: list[OutboundMessage] = []
    summary = run_session_maintenance(
        # Scoped to one merchant, so the sender ignores the tenant it is handed
        # and simply records what would have gone out.
        MaintenanceDeps(
            db=db, send=lambda _merchant, message: outbound.append(message)
        ),
        datetime.now(UTC),
        merchant_id,
        "simulator",
        phone,
    )
    state, meta = _read_session(db, merchant_id, phone)
    completed_case: HandoffPackage | None = None
    if summary.abandoned:
        rows = db.query(
            "select id from cases where merchant_id=$1 and customer_wa_id=$2 and status='abandoned' order by created_at desc, id desc limit 1",
            [merchant_id, phone],
        )
        if rows:
            completed_case = build_handoff(db, rows[0]["id"])
    notice = (f"Session aged by {request.age_minutes} minute(s). " if aged else "") + (
        f"Inactivity check: nudged {summary.nudged}, abandoned {summary.abandoned}, deleted {summary.deleted}"
    )
    if summary.nudged + summary.abandoned + summary.deleted + summary.failed == 0:
        notice += ". No action due: the threshold is not reached, or this session has already received its nudge."
    # Only mentioned when it happened, so a clean run stays quiet.
    if summary.failed > 0:
        notice += f", failed {summary.failed}"
    return SimulatorResponse(
        outbound=outbound,
        session=state,
        session_meta=meta,
        completed_case=completed_case,
        notice=notice,
    )


def _message(db: Database, request: SimulatorRequest) -> SimulatorResponse:
    merchant_id, phone = request.merchant_id, request.phone
    message = request.message
    if message is None:
        return SimulatorResponse(error="message is required")
    envelope = build_inbound_envelope(
        message,
        EnvelopeContext(
            phone_number_id=SIMULATOR_PHONE_NUMBER_ID,
            from_phone=phone,
            message_id=message.message_id or new_message_id(),
        ),
    )
    outbound: list[OutboundMessage] = []
    # `delivery_failure` fails only the first send, so recovery is observable.
    sends_attempted = 0

    def recording_send(msg: OutboundMessage) -> None:
        nonlocal sends_attempted
        sends_attempted += 1
        if request.inject_error == "delivery_failure" and sends_attempted == 1:
            raise RuntimeError("injected delivery failure")
        outbound.append(msg)

    def before_advance() -> None:
        if request.inject_error == "handler_exception":
            raise RuntimeError("injected handler exception")

    error: str | None = None
    completed_case: HandoffPackage | None = None
    for inbound in parse_inbound(envelope):
        try:
            result = handle_inbound(
                IntakeDeps(
                    db=db,
                    send=recording_send,
                    channel="simulator",
                    load_photo=lambda _media_id: Photo(
                        content=_FAKE_PNG, mime_type="image/png"
                    ),
                    before_advance=before_advance,
                ),
                merchant_id,
                inbound,
            )
            if result.persisted_case_id:
                completed_case = build_handoff(db, result.persisted_case_id)
            if result.duplicate:
                error = "duplicate delivery skipped (idempotency)"
            elif result.failed:
                error = "processing failed or delivery is pending; inspect the session and retry pending delivery."
        except Exception as err:
            error = error_message(err)
    state, meta = _read_session(db, merchant_id, phone)
    return SimulatorResponse(
        outbound=outbound,
        session=state,
        session_meta=meta,
        completed_case=completed_case,
        error=error,
        notice=(
            "integration_down accepted, but there is no connector to degrade (integrations are out of scope)."
            if request.inject_error == "integration_down"
            else None
        ),
    )
