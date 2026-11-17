"""Conversation transcript (SPEC §9) — port of db/transcript.ts.

What the customer sent and what the bot composed, in order. Rows are written
while the conversation is still in progress — before any case exists — and
stamped with `case_id` when the intake completes.
"""

from __future__ import annotations

from typing import Any, Literal

from chicchat.db.database import Queryable, Row

MessageDirection = Literal["inbound", "outbound"]


def record_message(
    db: Queryable,
    merchant_id: str,
    customer_wa_id: str,
    direction: MessageDirection,
    kind: str,
    body: Any,
    wa_message_id: Any = None,
    case_id: str | None = None,
) -> None:
    db.query(
        """insert into conversation_messages
       (merchant_id, customer_wa_id, case_id, direction, kind, body, wa_message_id)
     values ($1, $2, $3, $4, $5, $6, $7)
     -- One entry per inbound WhatsApp message: the error path re-records the
     -- customer's message because its transaction may have rolled back, and
     -- this makes that a no-op when it did not. Outbound rows carry no id and
     -- never conflict.
     on conflict (merchant_id, wa_message_id)
       where direction = 'inbound' and wa_message_id is not null
       do nothing""",
        [merchant_id, customer_wa_id, case_id, direction, kind, body, wa_message_id],
    )


def link_messages_to_case(
    db: Queryable, merchant_id: str, customer_wa_id: str, case_id: str
) -> int:
    """Attach this conversation's unattached messages to the case it produced.
    Called inside the case-creation transaction."""
    db.query(
        "update conversation_media set case_id=$3 where merchant_id=$1 and customer_wa_id=$2 and case_id is null",
        [merchant_id, customer_wa_id, case_id],
    )
    db.query(
        "update message_outbox set case_id=$3 where merchant_id=$1 and customer_wa_id=$2 and case_id is null",
        [merchant_id, customer_wa_id, case_id],
    )
    rows = db.query(
        """update conversation_messages
        set case_id = $3
      where merchant_id = $1 and customer_wa_id = $2 and case_id is null
      returning id""",
        [merchant_id, customer_wa_id, case_id],
    )
    return len(rows)


def list_transcript(db: Queryable, merchant_id: str, case_id: str) -> list[Row]:
    """The read-only transcript for one case. Merchant-scoped through `cases`."""
    return db.query(
        """select m.direction, m.kind, m.body, m.wa_message_id, m.created_at
       from conversation_messages m
       join cases c on c.id = m.case_id
      where m.case_id = $2 and c.merchant_id = $1
      order by m.created_at, m.id""",
        [merchant_id, case_id],
    )
