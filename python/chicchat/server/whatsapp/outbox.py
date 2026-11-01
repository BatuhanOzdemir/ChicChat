"""Reply delivery — port of server/whatsapp/outbox.ts.

Serialize delivery with intake and erasure (conversation lock). Network
ambiguity permits duplicate external sends: delivery is at-least-once.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from functools import partial

from chicchat.db.conversation_lock import lock_conversation
from chicchat.db.database import Database
from chicchat.db.outbox import DeliveryChannel
from chicchat.db.transcript import record_message
from chicchat.domain.logging.mask import redact_text
from chicchat.domain.whatsapp import outbound_summary
from chicchat.domain.whatsapp.types import OutboundMessage
from chicchat.server.logger import error_message

Send = Callable[[OutboundMessage], None]
MerchantSend = Callable[[str, OutboundMessage], None]


@dataclass(frozen=True)
class DeliveryResult:
    sent: int
    failed: bool


def deliver_replies(
    db: Database,
    merchant_id: str,
    phone: str,
    send: Send,
    channel: DeliveryChannel,
    force: bool = False,
    deadline: float | None = None,
) -> DeliveryResult:
    """`deadline` is a `time.monotonic()` value (default: 30 s from now)."""
    stop_at = time.monotonic() + 30 if deadline is None else deadline
    with db.transaction() as tx:
        lock_conversation(tx, merchant_id, phone)
        rows = tx.query(
            """select id, payload, case_id, next_attempt_at
      from message_outbox where merchant_id=$1 and customer_wa_id=$2
      and delivery_channel=$3 and delivered_at is null order by id limit 50 for update""",
            [merchant_id, phone, channel],
        )
        sent = 0
        for row in rows:
            if time.monotonic() >= stop_at:
                break
            if not force and row["next_attempt_at"] > datetime.now(UTC):
                break
            try:
                send(row["payload"])
            except Exception as err:
                tx.query(
                    """update message_outbox set attempts=attempts+1, last_error=$2,
          next_attempt_at=now()+least(3600, 30*power(2,least(attempts,7))) * interval '1 second' where id=$1""",
                    [row["id"], redact_text(error_message(err) or "delivery failed")],
                )
                return DeliveryResult(sent=sent, failed=True)
            record_message(
                tx,
                merchant_id=merchant_id,
                customer_wa_id=phone,
                case_id=row["case_id"],
                direction="outbound",
                kind=row["payload"]["type"],
                body=outbound_summary(row["payload"]),
            )
            tx.query(
                "update message_outbox set delivered_at=clock_timestamp(), attempts=attempts+1, last_error=null where id=$1",
                [row["id"]],
            )
            sent += 1
        return DeliveryResult(sent=sent, failed=False)


def retry_replies(db: Database, send: MerchantSend) -> dict[str, int]:
    deadline = time.monotonic() + 40
    rows = db.query("""select merchant_id, customer_wa_id from message_outbox
    where delivery_channel='whatsapp' and delivered_at is null
    group by merchant_id, customer_wa_id
    having (array_agg(next_attempt_at order by id))[1]<=now()
    order by min(id) limit 100""")
    summary = {"sent": 0, "failed": 0}
    for row in rows:
        if time.monotonic() >= deadline:
            break
        merchant_id = row["merchant_id"]
        result = deliver_replies(
            db,
            merchant_id,
            row["customer_wa_id"],
            partial(send, merchant_id),
            "whatsapp",
            False,
            deadline,
        )
        summary["sent"] += result.sent
        summary["failed"] += int(result.failed)
    return summary
