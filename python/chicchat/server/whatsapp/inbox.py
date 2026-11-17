"""Durable inbox — port of server/whatsapp/inbox.ts.

The webhook commits accepted messages here *before* answering Meta; workers
process them oldest-first per conversation, even with concurrent workers.
"""

from __future__ import annotations

import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from functools import partial

from chicchat.db.conversation_lock import lock_conversation
from chicchat.db.database import Database, client_database
from chicchat.domain.jscompat import js_json_stringify
from chicchat.domain.whatsapp.types import InboundMessage, OutboundMessage
from chicchat.server.whatsapp.config import get_whatsapp_config
from chicchat.server.whatsapp.handler import IntakeDeps, IntakeResult, handle_inbound
from chicchat.server.whatsapp.media import download_photo
from chicchat.server.whatsapp.outbox import MerchantSend, deliver_replies


@dataclass(frozen=True)
class AcceptedMessage:
    merchant_id: str
    inbound: InboundMessage


def accept_messages(db: Database, messages: Sequence[AcceptedMessage]) -> None:
    with db.transaction() as tx:
        # Stable lock order when a single envelope contains several conversations.
        for key in sorted({f"{m.merchant_id}:{m.inbound['from']}" for m in messages}):
            merchant_id, _, phone = key.partition(":")
            lock_conversation(tx, merchant_id, phone)
        for m in messages:
            tx.query(
                """insert into message_inbox (merchant_id, customer_wa_id, message_id, payload)
        values ($1,$2,$3,$4) on conflict (merchant_id, message_id) do nothing""",
                [
                    m.merchant_id,
                    m.inbound["from"],
                    m.inbound["messageId"],
                    js_json_stringify(m.inbound),
                ],
            )


def process_inbox(db: Database, send: MerchantSend) -> dict[str, int]:
    """Oldest accepted message first per conversation, even with concurrent workers."""
    deadline = time.monotonic() + 40
    rows = db.query("""select merchant_id, customer_wa_id from message_inbox
    where processed_at is null group by merchant_id, customer_wa_id
    having (array_agg(next_attempt_at order by id))[1]<=now()
    order by min(id) limit 100""")
    summary = {"processed": 0, "failed": 0}
    for row in rows:
        if time.monotonic() >= deadline:
            break
        merchant_id, phone = row["merchant_id"], row["customer_wa_id"]

        merchant_send = partial(send, merchant_id)

        for _ in range(20):
            if time.monotonic() >= deadline:
                break
            result = _process_next(db, merchant_id, phone, merchant_send)
            if result is None:
                break
            if result.failed:
                summary["failed"] += 1
                break
            summary["processed"] += 1
        deliver_replies(
            db, merchant_id, phone, merchant_send, "whatsapp", False, deadline
        )
    return summary


def _process_next(
    db: Database, merchant_id: str, phone: str, send: Callable[[OutboundMessage], None]
) -> IntakeResult | None:
    with db.transaction() as tx:
        lock_conversation(tx, merchant_id, phone)
        pending = tx.query(
            """select id, payload, next_attempt_at from message_inbox
          where merchant_id=$1 and customer_wa_id=$2 and processed_at is null order by id limit 1 for update""",
            [merchant_id, phone],
        )
        item = pending[0] if pending else None
        if item is None or item["next_attempt_at"] > datetime.now(UTC):
            return None
        outcome = handle_inbound(
            IntakeDeps(
                db=client_database(tx),
                send=send,
                channel="whatsapp",
                defer_delivery=True,
                load_photo=lambda media_id: download_photo(
                    get_whatsapp_config(), media_id
                ),
            ),
            merchant_id,
            item["payload"],
        )
        tx.query(
            """update message_inbox set attempts=attempts+1,
          processed_at=case when $2 then null else clock_timestamp() end,
          next_attempt_at=now()+least(3600,30*power(2,least(attempts,7))) * interval '1 second' where id=$1""",
            [item["id"], outcome.failed],
        )
        return outcome
