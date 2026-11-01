"""Intake session persistence — port of db/sessions.ts.

Stores the IntakeState between WhatsApp messages, keyed by (merchant,
customer). The state is written as the same JSON text TypeScript produced
(`js_json_stringify`), so sessions carry over across the cutover (P3).
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal, TypedDict, cast

from chicchat.db.database import Queryable
from chicchat.domain.intake.types import IntakeState
from chicchat.domain.jscompat import js_json_stringify

DeliveryChannel = Literal["whatsapp", "simulator"]
SessionStatus = Literal["active", "nudged", "errored"]


def load_session(
    db: Queryable, merchant_id: str, customer_wa_id: str
) -> IntakeState | None:
    rows = db.query(
        "select state from intake_sessions where merchant_id = $1 and customer_wa_id = $2",
        [merchant_id, customer_wa_id],
    )
    return cast(IntakeState, rows[0]["state"]) if rows else None


def save_session(
    db: Queryable,
    merchant_id: str,
    customer_wa_id: str,
    state: IntakeState,
    channel: DeliveryChannel = "simulator",
) -> None:
    """Save progress. Any customer activity returns the session to `active` and
    clears a previous error — progress is never discarded (SPEC §11)."""
    db.query(
        """insert into intake_sessions (merchant_id, customer_wa_id, state, delivery_channel)
     values ($1, $2, $3, $4)
     on conflict (merchant_id, customer_wa_id) do update
       set state = excluded.state, updated_at = clock_timestamp(),
           status = 'active', last_error = null""",
        [merchant_id, customer_wa_id, js_json_stringify(state), channel],
    )


def set_session_status(
    db: Queryable,
    merchant_id: str,
    customer_wa_id: str,
    status: SessionStatus,
    last_error: str | None = None,
) -> None:
    """Mark a session's lifecycle state without touching `updated_at`, so a
    nudge or an error does not look like fresh customer activity."""
    db.query(
        """update intake_sessions
        set status = $3,
            last_error = $4,
            nudged_at = case when $3 = 'nudged' then now() else nudged_at end
      where merchant_id = $1 and customer_wa_id = $2""",
        [merchant_id, customer_wa_id, status, last_error],
    )


def delete_session(db: Queryable, merchant_id: str, customer_wa_id: str) -> None:
    db.query(
        "delete from intake_sessions where merchant_id = $1 and customer_wa_id = $2",
        [merchant_id, customer_wa_id],
    )


def age_session(
    db: Queryable, merchant_id: str, customer_wa_id: str, minutes: int
) -> bool:
    """Shift a session's timestamps into the past — the simulator's time-travel
    control (SPEC §7). True when a session was aged."""
    rows = db.query(
        """update intake_sessions
        set created_at = created_at - ($3 * interval '1 minute'),
            updated_at = updated_at - ($3 * interval '1 minute')
      where merchant_id = $1 and customer_wa_id = $2
      returning id""",
        [merchant_id, customer_wa_id, minutes],
    )
    return len(rows) > 0


class SessionMeta(TypedDict):
    """Session row with its (possibly aged) timestamps, for the simulator inspector."""

    state: IntakeState
    created_at: datetime
    updated_at: datetime


def load_session_meta(
    db: Queryable, merchant_id: str, customer_wa_id: str
) -> SessionMeta | None:
    rows = db.query(
        """select state, created_at, updated_at
       from intake_sessions where merchant_id = $1 and customer_wa_id = $2""",
        [merchant_id, customer_wa_id],
    )
    return cast(SessionMeta, rows[0]) if rows else None
