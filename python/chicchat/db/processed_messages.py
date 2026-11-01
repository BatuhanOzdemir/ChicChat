"""Idempotency ledger (SPEC §11, Handbook §6) — port of db/processed-messages.ts.

WhatsApp retries deliveries, so every inbound message id is claimed exactly
once per merchant. Claim inside the same transaction as the processing it
guards, so a rollback releases the claim and the retry can succeed.
"""

from __future__ import annotations

from typing import Any

from chicchat.db.database import Queryable


def claim_message(
    db: Queryable, merchant_id: str, message_id: Any, phone: Any = None
) -> bool:
    """True when this call owns the message, False when it was already processed."""
    rows = db.query(
        """insert into processed_messages (merchant_id, message_id, customer_wa_id)
     values ($1, $2, $3)
     on conflict (merchant_id, message_id) do nothing
     returning id""",
        [merchant_id, message_id, phone],
    )
    return len(rows) > 0
