"""Merchant resolution (SPEC §10) — port of db/merchants.ts.

Everything downstream of the webhook is merchant-scoped, so this is the one
place that turns Meta's `phone_number_id` into a merchant id. An unknown number
resolves to None rather than raising or falling back to a default: guessing the
tenant is worse than dropping the message.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from chicchat.db.database import Queryable


@dataclass(frozen=True)
class ResolvedChannel:
    merchant_id: str
    merchant_name: str
    channel_id: str
    phone_number_id: str
    waba_id: str | None


def resolve_merchant_by_phone_number_id(
    db: Queryable, phone_number_id: Any
) -> ResolvedChannel | None:
    rows = db.query(
        """select ch.id as channel_id, ch.phone_number_id, ch.waba_id,
            m.id as merchant_id, m.name as merchant_name
       from whatsapp_channels ch
       join merchants m on m.id = ch.merchant_id
      where ch.phone_number_id = $1""",
        [phone_number_id],
    )
    if not rows:
        return None
    row = rows[0]
    return ResolvedChannel(
        merchant_id=row["merchant_id"],
        merchant_name=row["merchant_name"],
        channel_id=row["channel_id"],
        phone_number_id=row["phone_number_id"],
        waba_id=row["waba_id"],
    )


@dataclass(frozen=True)
class PrimaryChannel:
    phone_number_id: str
    waba_id: str | None


def primary_channel(db: Queryable, merchant_id: str) -> PrimaryChannel | None:
    """The number a merchant sends from — needed by anything that starts a
    conversation rather than replying to one (the inactivity nudge, SPEC §11)."""
    rows = db.query(
        """select phone_number_id, waba_id from whatsapp_channels
      where merchant_id = $1
      order by is_primary desc, created_at
      limit 1""",
        [merchant_id],
    )
    return (
        PrimaryChannel(rows[0]["phone_number_id"], rows[0]["waba_id"]) if rows else None
    )


def list_channels(db: Queryable, merchant_id: str) -> list[dict[str, Any]]:
    """A merchant's channels, for the config page."""
    return db.query(
        """select id, phone_number_id, waba_id, display_number, is_primary
       from whatsapp_channels
      where merchant_id = $1
      order by is_primary desc, created_at""",
        [merchant_id],
    )
