"""Customer erasure and retention (SPEC §12) — port of db/privacy.ts.

Erasure is tenant/phone scoped. A cutoff implements record-age retention
without deleting newer work.
"""

from __future__ import annotations

from datetime import datetime

from chicchat.db.conversation_lock import lock_conversation
from chicchat.db.database import Database

_TABLES = (
    "message_outbox",
    "message_inbox",
    "conversation_messages",
    "conversation_media",
    "processed_messages",
    "intake_sessions",
    "cases",
)
_CASE_CHILDREN = ("message_outbox", "conversation_messages", "conversation_media")


def erase_customer(
    db: Database, merchant_id: str, phone: str, before: datetime | None = None
) -> int:
    with db.transaction() as tx:
        lock_conversation(tx, merchant_id, phone)
        deleted = 0
        for table in _TABLES:
            clock = (
                "processed_at"
                if table == "processed_messages"
                else "updated_at"
                if table == "intake_sessions"
                else "created_at"
            )
            # Delete transcript/evidence/pending replies before their parent
            # case can SET NULL.
            parent = (
                "or case_id in (select id from cases where merchant_id=$1 and customer_wa_id=$2 and created_at<$3)"
                if table in _CASE_CHILDREN
                else ""
            )
            rows = tx.query(
                f"""delete from {table} where merchant_id=$1 and customer_wa_id=$2
        and ($3::timestamptz is null or {clock}<$3 {parent}) returning 1""",
                [merchant_id, phone, before],
            )
            deleted += len(rows)
        return deleted


def enforce_retention(db: Database) -> int:
    """One bounded batch; repeated scheduled runs continue through all expired records."""
    rows = db.query("""with records as (
    select merchant_id, customer_wa_id, created_at as at from cases union all
    select merchant_id, customer_wa_id, created_at from conversation_messages union all
    select merchant_id, customer_wa_id, created_at from conversation_media union all
    select merchant_id, customer_wa_id, updated_at from intake_sessions union all
    select merchant_id, customer_wa_id, created_at from message_inbox union all
    select merchant_id, customer_wa_id, created_at from message_outbox union all
    select merchant_id, customer_wa_id, processed_at from processed_messages
  ) select r.merchant_id, r.customer_wa_id,
      now()-make_interval(months=>coalesce(c.retention_months,12)) as cutoff
    from records r left join merchant_config c on c.merchant_id=r.merchant_id
    where r.customer_wa_id is not null and r.at < now()-make_interval(months=>coalesce(c.retention_months,12))
    group by r.merchant_id,r.customer_wa_id,c.retention_months order by min(r.at) limit 200""")
    deleted = 0
    for row in rows:
        deleted += erase_customer(
            db, row["merchant_id"], row["customer_wa_id"], row["cutoff"]
        )
    with db.transaction() as tx:
        tx.query("delete from console_sessions where expires_at<now()")
        tx.query(
            "delete from console_login_attempts where window_started_at<now()-interval '1 day'"
        )
        # Legacy ledger rows without a phone cannot be matched to erasure; expire them by age.
        tx.query("""delete from processed_messages p using merchant_config c where p.merchant_id=c.merchant_id
      and p.customer_wa_id is null and p.processed_at < now()-make_interval(months=>c.retention_months)""")
    return deleted
