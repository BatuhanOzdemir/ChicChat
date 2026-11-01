"""Read models for the merchant case views (SPEC §8) — port of db/case-queries.ts.

The filtered list, one case in full, the analytics counters, and the errored
sessions the console must surface (SPEC §13). Every query is merchant-scoped;
filters arrive validated from domain.cases.filters and are always bound
parameters.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from chicchat.db.database import Queryable, Row
from chicchat.domain.cases.analytics import median
from chicchat.domain.cases.filters import UNROUTED_QUEUE, CaseFilters

PAGE_SIZE = 25


def case_category_options(db: Queryable, merchant_id: str) -> list[Row]:
    return db.query(
        """select key, min(label) as label from (
    select key,label from categories where merchant_id=$1 union all
    select category_key_snapshot,category_label_snapshot from cases where merchant_id=$1
  ) categories group by key order by label""",
        [merchant_id],
    )


def delivery_issues(db: Queryable, merchant_id: str) -> list[Row]:
    return db.query(
        """select customer_wa_id, attempts, last_error from message_outbox
    where merchant_id=$1 and delivered_at is null and attempts>0 order by id limit 50""",
        [merchant_id],
    )


# "The order number" is whichever field the merchant marked with the
# `order_number` normalization rule — not a field literally called
# `order_number`, so a tenant naming it `siparis_no` still gets an order column.
ORDER_NUMBER_FIELD = """from case_fields cf
      where cf.case_id = c.id and cf.normalize_rule_snapshot = 'order_number'"""


@dataclass(frozen=True)
class CaseListPage:
    rows: list[Row]
    total: int
    page: int
    page_size: int


def _where_clause(filters: CaseFilters) -> tuple[str, list[object]]:
    """The shared WHERE clause for list and count, so they never diverge."""
    params: list[object] = []
    parts = ["c.merchant_id = $1"]

    def add(value: object) -> str:
        params.append(value)
        return f"${len(params) + 1}"

    if filters.status:
        parts.append(f"c.status = {add(filters.status)}")
    if filters.category_key:
        parts.append(f"c.category_key_snapshot = {add(filters.category_key)}")
    if filters.queue == UNROUTED_QUEUE:
        parts.append("c.queue is null")
    elif filters.queue:
        parts.append(f"c.queue = {add(filters.queue)}")
    if filters.from_date:
        parts.append(f"c.created_at >= {add(filters.from_date)}::date")
    if filters.to_date:
        parts.append(
            f"c.created_at < ({add(filters.to_date)}::date + interval '1 day')"
        )
    if filters.order_number:
        parts.append(
            f"""exists (select 1 {ORDER_NUMBER_FIELD}
                  and cf.normalized_value = {add(filters.order_number)})"""
        )
    return " and ".join(parts), params


def list_cases(db: Queryable, merchant_id: str, filters: CaseFilters) -> CaseListPage:
    sql, params = _where_clause(filters)
    offset = (filters.page - 1) * PAGE_SIZE
    rows = db.query(
        f"""select c.id, c.status, c.priority, c.queue,
            c.category_key_snapshot as category_key, c.category_label_snapshot as category_label,
            c.subcategory_key_snapshot as subcategory_key, c.customer_wa_id, c.created_at,
            (select cf.normalized_value {ORDER_NUMBER_FIELD}
              order by cf.sort_order_snapshot limit 1) as order_number,
            (select count(*)::int from case_fields f where f.case_id = c.id) as field_count
       from cases c
       left join categories cat on cat.id = c.category_id
       left join subcategories sub on sub.id = c.subcategory_id
      where {sql}
      order by c.created_at desc
      limit {PAGE_SIZE} offset {offset}""",
        [merchant_id, *params],
    )
    count_rows = db.query(
        f"""select count(*)::int as n
       from cases c
       left join categories cat on cat.id = c.category_id
      where {sql}""",
        [merchant_id, *params],
    )
    return CaseListPage(
        rows=rows, total=count_rows[0]["n"], page=filters.page, page_size=PAGE_SIZE
    )


def get_case_detail(
    db: Queryable, merchant_id: str, case_id: str
) -> dict[str, Any] | None:
    rows = db.query(
        """select c.id, c.status, c.priority, c.queue, c.integration_tier,
            c.customer_wa_id, c.category_key_snapshot as category_key, c.category_label_snapshot as category_label,
            c.subcategory_key_snapshot as subcategory_key, c.created_at, c.intake_started_at
       from cases c
       left join categories cat on cat.id = c.category_id
       left join subcategories sub on sub.id = c.subcategory_id
      where c.id = $2 and c.merchant_id = $1""",
        [merchant_id, case_id],
    )
    if not rows:
        return None
    fields = db.query(
        """select cf.field_key, cf.raw_value, cf.normalized_value, cf.type_snapshot as type, cf.created_at
       from case_fields cf
       join cases c on c.id = cf.case_id
      where cf.case_id = $1
      order by cf.sort_order_snapshot, cf.field_key""",
        [case_id],
    )
    items = db.query(
        """select line_item_id, title, variant, qty from case_items
      where case_id = $1 order by line_item_id""",
        [case_id],
    )
    return {**rows[0], "fields": fields, "items": items}


@dataclass(frozen=True)
class CaseCounters:
    by_status: list[Row]
    by_category: list[Row]
    by_day: list[Row]
    median_intake_seconds: float | None
    completed: int
    abandoned: int


def case_counters(db: Queryable, merchant_id: str, days: int = 30) -> CaseCounters:
    """Counters for the last `days` days (SPEC §8: counts, median, abandonment)."""
    since = f"{days} days"
    by_status = db.query(
        """select status, count(*)::int as n from cases
      where merchant_id = $1 and created_at > now() - $2::interval
      group by status order by n desc""",
        [merchant_id, since],
    )
    by_category = db.query(
        """select c.category_key_snapshot as category_key, c.category_label_snapshot as category_label, count(*)::int as n
       from cases c left join categories cat on cat.id = c.category_id
      where c.merchant_id = $1 and c.created_at > now() - $2::interval
      group by c.category_key_snapshot, c.category_label_snapshot order by n desc""",
        [merchant_id, since],
    )
    by_day = db.query(
        """select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') as day,
            count(*)::int as n
       from cases
      where merchant_id = $1 and created_at > now() - $2::interval
      group by day order by day desc""",
        [merchant_id, since],
    )
    # Median is computed in Python so its definition lives in one tested place.
    durations = db.query(
        """select extract(epoch from (created_at - intake_started_at)) as seconds
       from cases
      where merchant_id = $1 and created_at > now() - $2::interval
        and intake_started_at is not null and status <> 'abandoned'""",
        [merchant_id, since],
    )
    seconds = [
        s
        for s in (float(r["seconds"]) for r in durations)
        if math.isfinite(s) and s >= 0
    ]
    abandoned = next((s["n"] for s in by_status if s["status"] == "abandoned"), 0)
    completed = sum(s["n"] for s in by_status if s["status"] != "abandoned")
    return CaseCounters(
        by_status=by_status,
        by_category=by_category,
        by_day=by_day,
        median_intake_seconds=median(seconds),
        completed=completed,
        abandoned=abandoned,
    )


def list_errored_sessions(db: Queryable, merchant_id: str) -> list[Row]:
    """Sessions that hit an unexpected error, for the console (SPEC §13)."""
    return db.query(
        """select s.customer_wa_id, s.last_error, s.updated_at,
            s.state->>'categoryKey' as category_key
       from intake_sessions s
      where s.merchant_id = $1 and s.status = 'errored'
      order by s.updated_at desc
      limit 50""",
        [merchant_id],
    )
