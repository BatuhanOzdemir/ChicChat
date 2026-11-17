"""Durable reply queue — port of db/outbox.ts."""

from __future__ import annotations

from chicchat.db.database import Queryable
from chicchat.db.sessions import DeliveryChannel
from chicchat.domain.jscompat import js_json_stringify
from chicchat.domain.whatsapp.types import OutboundMessage

__all__ = ["DeliveryChannel", "enqueue_reply"]


def enqueue_reply(
    db: Queryable,
    merchant_id: str,
    phone: str,
    key: str,
    message: OutboundMessage,
    channel: DeliveryChannel,
    case_id: str | None = None,
) -> None:
    db.query(
        """insert into message_outbox
    (merchant_id, customer_wa_id, delivery_key, delivery_channel, payload, case_id)
    values ($1,$2,$3,$4,$5,$6) on conflict (merchant_id, delivery_key) do nothing""",
        [merchant_id, phone, key, channel, js_json_stringify(message), case_id],
    )
