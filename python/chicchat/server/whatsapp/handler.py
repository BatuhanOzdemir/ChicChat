"""Inbound WhatsApp orchestration (SPEC §§10–13) — port of server/whatsapp/handler.ts.

Lock the conversation; atomically claim the message, advance intake, persist
state and queue its reply. Deliver only after commit. Processing errors mark
the session errored; transport errors leave state intact and retain the reply.

`db`, `send` and `logger` are injected so this is testable without Meta.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import asdict, dataclass
from typing import Any

from chicchat.db.cases import PersistCaseInput, PersistCaseRouting, persist_case
from chicchat.db.config import load_merchant_config, to_intake_config
from chicchat.db.conversation_lock import lock_conversation
from chicchat.db.database import Database, client_database
from chicchat.db.media import save_photo
from chicchat.db.outbox import DeliveryChannel, enqueue_reply
from chicchat.db.processed_messages import claim_message
from chicchat.db.routing import load_routing_rules
from chicchat.db.sessions import (
    delete_session,
    load_session_meta,
    save_session,
    set_session_status,
)
from chicchat.db.transcript import record_message
from chicchat.domain.cases.routing import (
    decide_routing,
    describe_routing,
    routing_context,
)
from chicchat.domain.intake import IntakeCase, advance, start_intake
from chicchat.domain.logging.mask import redact_text
from chicchat.domain.whatsapp import (
    generic_error_message,
    inbound_summary,
    prompt_to_message,
)
from chicchat.domain.whatsapp.types import InboundMessage, OutboundMessage
from chicchat.server.logger import Logger, error_message
from chicchat.server.logger import logger as default_logger
from chicchat.server.whatsapp.media import Photo
from chicchat.server.whatsapp.outbox import deliver_replies


@dataclass
class IntakeDeps:
    db: Database
    send: Callable[[OutboundMessage], None]
    logger: Logger | None = None
    channel: DeliveryChannel = "simulator"
    defer_delivery: bool = False
    before_advance: Callable[[], None] | None = None
    load_photo: Callable[[str], Photo] | None = None


@dataclass(frozen=True)
class IntakeResult:
    persisted_case_id: str | None
    """Set when this message completed the intake and a case was written."""
    duplicate: bool
    """True when the message was a duplicate delivery and was skipped."""
    failed: bool
    """True when processing failed and the generic reply was sent."""


@dataclass(frozen=True)
class _Outcome:
    persisted_case_id: str | None
    routing: PersistCaseRouting | None
    reply: OutboundMessage


def _route_case(
    db: Database, merchant_id: str, structured: IntakeCase, settings: dict[str, Any]
) -> PersistCaseRouting:
    """Decide where a finished case belongs (SPEC §3 → §9). Rules the merchant
    wrote are data, so an empty or non-matching set is normal."""
    rules = load_routing_rules(db, merchant_id, structured["category"])
    decision = decide_routing(
        rules,
        routing_context(
            structured["category"],
            structured["subcategory"],
            structured["fields"],
            settings,
        ),
    )
    return PersistCaseRouting(
        queue=decision["queue"],
        priority=decision["priority"],
        status=decision["status"],
        note=describe_routing(decision),
    )


def _process(
    db: Database,
    merchant_id: str,
    inbound: InboundMessage,
    channel: DeliveryChannel,
    before_advance: Callable[[], None] | None,
    load_photo: Callable[[str], Photo] | None,
) -> _Outcome:
    """Advance the conversation and persist the result. Raises on any failure."""
    merchant_config = load_merchant_config(db, merchant_id)
    if merchant_config is None:
        raise LookupError(f"merchant not found: {merchant_id}")
    config = to_intake_config(merchant_config)
    meta = load_session_meta(db, merchant_id, inbound["from"])
    existing = meta["state"] if meta else None

    # Inside this transaction, and idempotent on the message id: if processing
    # fails and rolls back, the error path re-records it (SPEC §9).
    record_message(
        db,
        merchant_id=merchant_id,
        customer_wa_id=inbound["from"],
        direction="inbound",
        kind=inbound["kind"],
        body=inbound_summary(inbound),
        wa_message_id=inbound["messageId"],
    )

    # First contact shows the category list without consuming the greeting.
    if before_advance is not None:
        before_advance()
    media_id = inbound.get("mediaId")
    if inbound["kind"] == "image" and media_id and load_photo is not None:
        photo = load_photo(media_id)
        save_photo(
            db, merchant_id, inbound["from"], media_id, photo.content, photo.mime_type
        )
    session = (
        start_intake(config)
        if existing is None
        else advance(config, existing, inbound["reply"])
    )

    persisted_case_id: str | None = None
    routing: PersistCaseRouting | None = None
    prompt = session["prompt"]
    if prompt["kind"] == "complete":
        structured = prompt["case"]
        routing = _route_case(
            db, merchant_id, structured, dict(merchant_config.settings)
        )
        persisted_case_id = persist_case(
            db,
            PersistCaseInput(
                merchant_id=merchant_id,
                customer_wa_id=inbound["from"],
                category_key=structured["category"],
                subcategory_key=structured["subcategory"],
                integration_tier=0,
                # Where the intake began, so the console can report how long it took.
                intake_started_at=meta["created_at"] if meta else None,
                fields=structured["fields"],
                routing=routing,
            ),
        )
        delete_session(db, merchant_id, inbound["from"])
    else:
        save_session(db, merchant_id, inbound["from"], session["state"], channel)

    return _Outcome(
        persisted_case_id=persisted_case_id,
        routing=routing,
        reply=prompt_to_message(
            prompt, inbound["from"], merchant_config.merchant.locale
        ),
    )


def _recover(
    deps: IntakeDeps, merchant_id: str, inbound: InboundMessage, err: BaseException
) -> None:
    """Mark the session errored and queue one generic reply (SPEC §13)."""
    channel = deps.channel
    with deps.db.transaction() as tx:
        lock_conversation(tx, merchant_id, inbound["from"])
        merchant_config = load_merchant_config(tx, merchant_id)
        # First-contact failures also need a visible error session.
        if load_session_meta(tx, merchant_id, inbound["from"]) is None:
            config = load_merchant_config(tx, merchant_id)
            if config is None:
                raise LookupError("merchant unavailable")
            save_session(
                tx,
                merchant_id,
                inbound["from"],
                start_intake(to_intake_config(config))["state"],
                channel,
            )
        set_session_status(
            tx,
            merchant_id,
            inbound["from"],
            "errored",
            redact_text(error_message(err) or "processing failed"),
        )
        record_message(
            tx,
            merchant_id=merchant_id,
            customer_wa_id=inbound["from"],
            direction="inbound",
            kind=inbound["kind"],
            body=inbound_summary(inbound),
            wa_message_id=inbound["messageId"],
        )
        enqueue_reply(
            tx,
            merchant_id=merchant_id,
            phone=inbound["from"],
            key="error:" + str(inbound["messageId"]),
            channel=channel,
            message=generic_error_message(
                inbound["from"],
                merchant_config.merchant.locale if merchant_config else None,
            ),
        )


def handle_inbound(
    deps: IntakeDeps, merchant_id: str, inbound: InboundMessage
) -> IntakeResult:
    """Commit the state transition and its reply together; transport failures
    leave a retryable reply."""
    log = deps.logger or default_logger
    channel = deps.channel
    context: dict[str, Any] = {
        "merchantId": merchant_id,
        "correlationId": inbound["messageId"],
        "phone": inbound["from"],
        "kind": inbound["kind"],
    }
    outcome: _Outcome | None
    try:
        with deps.db.transaction() as tx:
            lock_conversation(tx, merchant_id, inbound["from"])
            if not claim_message(
                tx, merchant_id, inbound["messageId"], inbound["from"]
            ):
                outcome = None
            else:
                outcome = _process(
                    client_database(tx),
                    merchant_id,
                    inbound,
                    channel,
                    deps.before_advance,
                    deps.load_photo,
                )
                enqueue_reply(
                    tx,
                    merchant_id=merchant_id,
                    phone=inbound["from"],
                    key=str(inbound["messageId"]),
                    channel=channel,
                    message=outcome.reply,
                    case_id=outcome.persisted_case_id,
                )
    except Exception as err:
        log.error("unexpected_exception", err, context)
        try:
            _recover(deps, merchant_id, inbound, err)
            log.warn("session_errored", context)
            if not deps.defer_delivery:
                deliver_replies(
                    deps.db, merchant_id, inbound["from"], deps.send, channel
                )
        except Exception as recovery_err:
            log.error(
                "unexpected_exception",
                recovery_err,
                {**context, "during": "error_recovery"},
            )
        return IntakeResult(persisted_case_id=None, duplicate=False, failed=True)

    if outcome is None:
        log.info("message_skipped_duplicate", context)
    elif outcome.persisted_case_id:
        log.info("case_persisted", {**context, "case_id": outcome.persisted_case_id})
        if outcome.routing:
            log.info("routing_decision", {**context, **asdict(outcome.routing)})
    failed = False
    if not deps.defer_delivery:
        try:
            failed = deliver_replies(
                deps.db,
                merchant_id,
                inbound["from"],
                deps.send,
                channel,
                outcome is None,
            ).failed
        except Exception as err:
            failed = True
            log.error("unexpected_exception", err, {**context, "during": "delivery"})
    return IntakeResult(
        persisted_case_id=outcome.persisted_case_id if outcome else None,
        duplicate=outcome is None,
        failed=failed,
    )
