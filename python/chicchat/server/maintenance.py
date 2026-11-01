"""Session inactivity maintenance (SPEC §11) — port of server/maintenance/sessions.ts.

Two behaviours, both merchant-configurable:
 - after `nudge_after_minutes` of silence, send exactly ONE gentle resume
   prompt and mark the session `nudged`;
 - after `abandon_after_hours`, close the session — a session that captured at
   least one field becomes an `abandoned` case so the work is not lost; an
   empty one is simply deleted.

Progress is never discarded early: nothing here touches captured fields, so a
customer who replies later resumes exactly where they left off.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from functools import partial
from typing import Any

from chicchat.db.cases import PersistCaseInput, persist_case
from chicchat.db.conversation_lock import lock_conversation
from chicchat.db.database import Database, Row, client_database
from chicchat.db.outbox import DeliveryChannel, enqueue_reply
from chicchat.db.sessions import delete_session, set_session_status
from chicchat.domain.intake import (
    InactivityThresholds,
    SessionTiming,
    inactivity_action,
)
from chicchat.domain.intake.types import CaseField
from chicchat.domain.whatsapp import nudge_message
from chicchat.server.logger import LogEvent, Logger
from chicchat.server.logger import logger as default_logger
from chicchat.server.whatsapp.outbox import MerchantSend, deliver_replies


@dataclass
class MaintenanceDeps:
    db: Database
    send: MerchantSend
    """Sends on behalf of one merchant: a nudge goes out from that merchant's
    own number (SPEC §10), so the sender is resolved per merchant."""
    logger: Logger | None = None


@dataclass
class MaintenanceSummary:
    nudged: int = 0
    abandoned: int = 0
    deleted: int = 0
    failed: int = 0
    """Sessions this run could not process; each one is logged."""


def _load_candidates(
    db: Database,
    merchant_id: str | None = None,
    channel: DeliveryChannel | None = None,
    session_id: str | None = None,
    now: datetime | None = None,
    phone: str | None = None,
) -> list[Row]:
    """Sessions with their merchant's thresholds, oldest activity first."""
    return db.query(
        """select m.locale, s.id, s.nudged_at, s.delivery_channel, s.merchant_id, s.customer_wa_id, s.state, s.status,
            s.created_at, s.updated_at,
            c.nudge_after_minutes, c.abandon_after_hours
       from intake_sessions s
       join merchants m on m.id=s.merchant_id
       left join merchant_config c on c.merchant_id = s.merchant_id
      where ($1::uuid is null or s.merchant_id = $1)
        and ($2::text is null or s.delivery_channel=$2)
        and ($3::uuid is null or s.id=$3)
        and ($5::text is null or s.customer_wa_id=$5)
        and ($3::uuid is not null
          or s.updated_at <= $4::timestamptz - coalesce(c.abandon_after_hours,24)*interval '1 hour'
          or (s.status='active' and s.nudged_at is null
            and s.updated_at <= $4::timestamptz - coalesce(c.nudge_after_minutes,5)*interval '1 minute'))
      order by s.updated_at asc
      limit 500""",
        [merchant_id, channel, session_id, now or datetime.now(UTC), phone],
    )


def _abandon_session(deps: MaintenanceDeps, row: Row, log: Logger) -> str:
    """Turn an abandoned session into an `abandoned` case when anything was
    captured. Requires a category — without one there is nothing to file."""
    state: dict[str, Any] = row["state"]
    fields: list[CaseField] = [
        {"key": key, "raw": value["raw"], "normalized": value["normalized"]}
        for key, value in (state.get("fields") or {}).items()
        if value and value.get("valid")
    ]
    context = {
        "merchantId": row["merchant_id"],
        "phone": row["customer_wa_id"],
        "correlationId": f"maintenance:{row['id']}",
    }
    if fields and state.get("categoryKey"):
        case_id = persist_case(
            deps.db,
            PersistCaseInput(
                merchant_id=row["merchant_id"],
                customer_wa_id=row["customer_wa_id"],
                category_key=state["categoryKey"],
                subcategory_key=state.get("subcategoryKey"),
                integration_tier=0,
                status="abandoned",
                intake_started_at=row["created_at"],
                fields=fields,
            ),
        )
        delete_session(deps.db, row["merchant_id"], row["customer_wa_id"])
        log.info("session_abandoned", {**context, "case_id": case_id, "kept": True})
        return "abandoned"
    delete_session(deps.db, row["merchant_id"], row["customer_wa_id"])
    log.info("session_abandoned", {**context, "kept": False})
    return "deleted"


def _maintain_session(
    deps: MaintenanceDeps,
    row: Row,
    now: datetime,
    summary: MaintenanceSummary,
    log: Logger,
) -> None:
    """Nudge, abandon or leave alone — one session. Raises on failure."""
    nudge_after = row["nudge_after_minutes"]
    abandon_after = row["abandon_after_hours"]
    action = inactivity_action(
        SessionTiming(
            status=row["status"],
            updated_at=row["updated_at"],
            nudged_at=row["nudged_at"],
        ),
        InactivityThresholds(
            nudge_after_minutes=5 if nudge_after is None else nudge_after,
            abandon_after_hours=24 if abandon_after is None else abandon_after,
        ),
        now,
    )
    if action == "none":
        return
    if action == "nudge":
        # State and durable reply commit together; transport retries cannot lose a nudge.
        set_session_status(deps.db, row["merchant_id"], row["customer_wa_id"], "nudged")
        enqueue_reply(
            deps.db,
            merchant_id=row["merchant_id"],
            phone=row["customer_wa_id"],
            key="nudge:" + row["id"],
            channel=row["delivery_channel"],
            message=nudge_message(row["customer_wa_id"], row["locale"]),
        )
        log.info(
            "session_nudged",
            {
                "merchantId": row["merchant_id"],
                "phone": row["customer_wa_id"],
                "correlationId": f"maintenance:{row['id']}",
            },
        )
        summary.nudged += 1
        return
    if _abandon_session(deps, row, log) == "abandoned":
        summary.abandoned += 1
    else:
        summary.deleted += 1


@dataclass
class _BufferedLogger:
    """Log lines are emitted only once their transaction committed."""

    events: list[Callable[[], None]] = field(default_factory=list)
    target: Logger = default_logger

    def info(self, event: LogEvent, context: dict[str, Any] | None = None) -> None:
        self.events.append(lambda: self.target.info(event, context))

    def warn(self, event: LogEvent, context: dict[str, Any] | None = None) -> None:
        self.events.append(lambda: self.target.warn(event, context))

    def error(
        self,
        event: LogEvent,
        error: BaseException | object,
        context: dict[str, Any] | None = None,
    ) -> None:
        self.events.append(lambda: self.target.error(event, error, context))


def run_session_maintenance(
    deps: MaintenanceDeps,
    now: datetime | None = None,
    merchant_id: str | None = None,
    channel: DeliveryChannel | None = None,
    phone: str | None = None,
) -> MaintenanceSummary:
    log = deps.logger or default_logger
    moment = now or datetime.now(UTC)
    summary = MaintenanceSummary()
    for row in _load_candidates(deps.db, merchant_id, channel, None, moment, phone):
        # One conversation must not take the sweep down with it: this job runs
        # unattended across every tenant, so one expired token or unreachable
        # merchant would otherwise stop everyone else's nudges.
        try:
            delta = MaintenanceSummary()
            buffered = _BufferedLogger(target=log)
            with deps.db.transaction() as tx:
                lock_conversation(tx, row["merchant_id"], row["customer_wa_id"])
                db = client_database(tx)
                fresh = _load_candidates(db, merchant_id, channel, row["id"])
                if fresh:
                    _maintain_session(
                        MaintenanceDeps(db=db, send=deps.send, logger=log),
                        fresh[0],
                        moment,
                        delta,
                        buffered,
                    )
            summary.nudged += delta.nudged
            summary.abandoned += delta.abandoned
            summary.deleted += delta.deleted
            for emit_event in buffered.events:
                emit_event()
            row_merchant = row["merchant_id"]
            delivery = deliver_replies(
                deps.db,
                row_merchant,
                row["customer_wa_id"],
                partial(deps.send, row_merchant),
                row["delivery_channel"],
            )
            if delivery.failed:
                raise RuntimeError("nudge delivery pending retry")
        except Exception as err:
            summary.failed += 1
            log.error(
                "unexpected_exception",
                err,
                {
                    "merchantId": row["merchant_id"],
                    "phone": row["customer_wa_id"],
                    "correlationId": f"maintenance:{row['id']}",
                    "during": "session_maintenance",
                },
            )
    return summary
