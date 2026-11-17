"""Per-conversation lock — port of db/conversation-lock.ts.

Call inside a transaction, before any conversation reads (including a
no-session first contact). The key text is identical to TypeScript's
(`<merchant uuid>:<phone>`), so both versions lock the same conversation (P14).
"""

from __future__ import annotations

from chicchat.db.database import Queryable


def lock_conversation(db: Queryable, merchant_id: str, phone: str) -> None:
    db.query(
        "select pg_advisory_xact_lock(hashtextextended($1, 0))",
        [f"{merchant_id}:{phone}"],
    )
