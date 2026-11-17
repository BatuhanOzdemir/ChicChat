"""Loading a category's routing rules (SPEC §3) — port of db/routing.ts.

One merchant-scoped query; the evaluation itself is pure (domain.cases.routing).
Rules come back in the merchant's configured order, which decides precedence
(first match wins), so it must be stable.
"""

from __future__ import annotations

from typing import cast

from chicchat.db.database import Queryable
from chicchat.domain.cases.routing import LabelledRule


def load_routing_rules(
    db: Queryable, merchant_id: str, category_key: str
) -> list[LabelledRule]:
    rows = db.query(
        """select rr.id, rr.label, rr.condition, rr.action_type,
            rr.target_queue, rr.priority, rr.auto_resolve
       from routing_rules rr
       join categories cat on cat.id = rr.category_id
      where cat.merchant_id = $1 and cat.key = $2
      order by rr.sort_order, rr.created_at, rr.id""",
        [merchant_id, category_key],
    )
    return [
        cast(
            LabelledRule,
            {
                "id": r["id"],
                "label": r["label"],
                "condition": r["condition"],
                "action_type": r["action_type"],
                "target_queue": r["target_queue"],
                "priority": r["priority"],
                "auto_resolve": r["auto_resolve"],
            },
        )
        for r in rows
    ]
