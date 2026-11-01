"""Private photo evidence — port of db/media.ts."""

from __future__ import annotations

from chicchat.db.database import Queryable, Row


def save_photo(
    db: Queryable,
    merchant_id: str,
    phone: str,
    media_id: str,
    content: bytes,
    mime_type: str,
) -> None:
    db.query(
        """insert into conversation_media (merchant_id,customer_wa_id,media_id,content,mime_type)
    values ($1,$2,$3,$4,$5) on conflict (merchant_id,customer_wa_id,media_id) do nothing""",
        [merchant_id, phone, media_id, content, mime_type],
    )


def case_photo(
    db: Queryable, merchant_id: str, case_id: str, media_id: str
) -> Row | None:
    rows = db.query(
        """select m.content,m.mime_type from conversation_media m
    join cases c on c.id=m.case_id and c.merchant_id=m.merchant_id
    where c.merchant_id=$1 and c.id=$2 and m.media_id=$3""",
        [merchant_id, case_id, media_id],
    )
    return rows[0] if rows else None
