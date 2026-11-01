"""Case persistence & the agent-handoff package — port of db/cases.ts.

`persist_case` writes cases/case_fields/case_items atomically; `build_handoff`
reads them back into the clean JSON a human agent (or the Phase-2 resolver)
consumes: category, subcategory, normalized fields, selected items, photos.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, TypedDict

from chicchat.db.database import Database, Queryable
from chicchat.db.transcript import link_messages_to_case
from chicchat.domain.intake.types import CaseField

__all__ = ["Queryable"]


@dataclass(frozen=True)
class PersistCaseRouting:
    """The routing outcome to record with the case (SPEC §3 → §9), passed as
    one object so queue, priority, status and explanation never drift apart."""

    queue: str | None
    priority: str
    status: str
    note: str
    """One line for the case timeline explaining the decision."""


@dataclass(frozen=True)
class CaseItemInput:
    line_item_id: str
    title: str | None = None
    variant: str | None = None
    qty: int = 1


@dataclass(frozen=True)
class PersistCaseInput:
    merchant_id: str
    customer_wa_id: str
    category_key: str
    fields: Sequence[CaseField]
    subcategory_key: str | None = None
    integration_tier: int = 0
    status: str | None = None
    routing: PersistCaseRouting | None = None
    intake_started_at: datetime | str | None = None
    """When the customer's first message of this intake arrived (SPEC §8)."""
    items: Sequence[CaseItemInput] = field(default_factory=list)
    """Selected line items (Tier 1+ picker). Empty in Tier 0."""


class HandoffItem(TypedDict):
    line_item_id: str
    title: str | None
    variant: str | None
    qty: int


class HandoffPackage(TypedDict):
    case_id: str
    category: str
    subcategory: str | None
    integration_tier: int
    status: str
    queue: str | None
    priority: str
    customer_wa_id: str
    fields: dict[str, str | None]
    """field_key -> normalized value."""
    photos: list[str]
    """Normalized refs of media-typed fields (e.g. photo)."""
    items: list[HandoffItem]


def _one(db: Queryable, sql: str, params: Sequence[object]) -> dict[str, Any] | None:
    rows = db.query(sql, params)
    return rows[0] if rows else None


def persist_case(db: Database, data: PersistCaseInput) -> str:
    """Persist a case with its fields and items **atomically** (Handbook §6,
    SPEC §11): a failure part-way through leaves no partial case behind."""
    with db.transaction() as tx:
        category = _one(
            tx,
            "select id from categories where merchant_id = $1 and key = $2",
            [data.merchant_id, data.category_key],
        )
        if category is None:
            raise LookupError(
                f'unknown category "{data.category_key}" for merchant {data.merchant_id}'
            )

        subcategory_id: str | None = None
        if data.subcategory_key:
            sub = _one(
                tx,
                "select id from subcategories where category_id = $1 and key = $2",
                [category["id"], data.subcategory_key],
            )
            subcategory_id = sub["id"] if sub else None

        routing = data.routing
        status = (
            routing.status
            if routing
            else (data.status if data.status is not None else "open")
        )
        created = _one(
            tx,
            """insert into cases
         (merchant_id, customer_wa_id, category_id, subcategory_id, status,
          integration_tier, intake_started_at, queue, priority)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       returning id""",
            [
                data.merchant_id,
                data.customer_wa_id,
                category["id"],
                subcategory_id,
                status,
                data.integration_tier,
                data.intake_started_at,
                routing.queue if routing else None,
                routing.priority if routing else "normal",
            ],
        )
        assert created is not None
        case_id: str = created["id"]

        # The routing decision is part of the case's history, not a side note.
        if routing:
            tx.query(
                """insert into case_events (case_id, kind, to_status, body, actor)
         values ($1, 'routing', $2, $3, 'system')""",
                [case_id, routing.status, routing.note],
            )

        for f in data.fields:
            tx.query(
                """insert into case_fields (case_id, field_key, raw_value, normalized_value)
         values ($1, $2, $3, $4)
         on conflict (case_id, field_key) do update
           set raw_value = excluded.raw_value, normalized_value = excluded.normalized_value""",
                [case_id, f["key"], f["raw"], f["normalized"]],
            )

        # Whatever was said on the way here belongs to this case (SPEC §9).
        link_messages_to_case(tx, data.merchant_id, data.customer_wa_id, case_id)

        for item in data.items:
            tx.query(
                """insert into case_items (case_id, line_item_id, title, variant, qty)
         values ($1, $2, $3, $4, $5)""",
                [case_id, item.line_item_id, item.title, item.variant, item.qty],
            )
        return case_id


def build_handoff(db: Queryable, case_id: str) -> HandoffPackage:
    header = _one(
        db,
        """select c.id, c.status, c.integration_tier, c.customer_wa_id, c.queue, c.priority,
            c.category_key_snapshot as category, c.subcategory_key_snapshot as subcategory
       from cases c
       left join categories cat on cat.id = c.category_id
       left join subcategories sub on sub.id = c.subcategory_id
      where c.id = $1""",
        [case_id],
    )
    if header is None:
        raise LookupError(f"case not found: {case_id}")

    field_rows = db.query(
        """select cf.field_key, cf.normalized_value, cf.type_snapshot as type
       from case_fields cf
       join cases c on c.id = cf.case_id
      where cf.case_id = $1
      order by cf.field_key""",
        [case_id],
    )
    fields: dict[str, str | None] = {}
    photos: list[str] = []
    for r in field_rows:
        fields[r["field_key"]] = r["normalized_value"]
        if r["type"] == "media" and r["normalized_value"]:
            photos.append(r["normalized_value"])

    item_rows = db.query(
        """select line_item_id, title, variant, qty
       from case_items where case_id = $1 order by line_item_id""",
        [case_id],
    )
    return {
        "case_id": header["id"],
        "category": header["category"],
        "subcategory": header["subcategory"],
        "integration_tier": header["integration_tier"],
        "status": header["status"],
        "queue": header["queue"],
        "priority": header["priority"],
        "customer_wa_id": header["customer_wa_id"],
        "fields": fields,
        "photos": photos,
        "items": [
            {
                "line_item_id": i["line_item_id"],
                "title": i["title"],
                "variant": i["variant"],
                "qty": i["qty"],
            }
            for i in item_rows
        ],
    }
