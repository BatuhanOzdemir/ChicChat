"""Agent case console (SPEC §9) — port of db/console.ts.

The work queue, the audit trail of a case, and the two things an agent can do
to it — move its status and leave an internal note. Writes validate the
requested transition against the pure lifecycle rules inside the same
transaction that applies it, so two agents clicking at once cannot produce an
impossible history.
"""

from __future__ import annotations

from dataclasses import dataclass

from chicchat.db.database import Database, Queryable, Row
from chicchat.domain.cases.filters import UNROUTED_QUEUE
from chicchat.domain.cases.workflow import (
    PRIORITIES,
    UNRESOLVED_STATUSES,
    Transition,
    is_terminal,
    plan_transition,
    priority_rank,
)
from chicchat.domain.jscompat import js_trim
from chicchat.domain.result import Err, Ok, Result

QUEUE_PAGE_SIZE = 50


@dataclass(frozen=True)
class QueueFilters:
    queue: str | None
    """Queue name, `UNROUTED_QUEUE` for unrouted, or None for all queues."""
    category_key: str | None
    status: str | None
    """A single status, or None for "everything still needing work"."""


def _queue_conditions(filters: QueueFilters) -> tuple[str, list[object]]:
    params: list[object] = []
    parts = ["c.merchant_id = $1"]

    def add(value: object) -> str:
        params.append(value)
        return f"${len(params) + 1}"

    if filters.queue == UNROUTED_QUEUE:
        parts.append("c.queue is null")
    elif filters.queue:
        parts.append(f"c.queue = {add(filters.queue)}")
    if filters.category_key:
        parts.append(f"c.category_key_snapshot = {add(filters.category_key)}")
    if filters.status:
        parts.append(f"c.status = {add(filters.status)}")
    else:
        parts.append(f"c.status = any({add(list(UNRESOLVED_STATUSES))})")
    return " and ".join(parts), params


# Highest priority first, then oldest first. Generated from the same PRIORITIES
# list `priority_rank` uses, so SQL ordering cannot drift from the domain rule.
# The interpolated values are constants, never input.
PRIORITY_ORDER = (
    "case c.priority "
    + " ".join(f"when '{p}' then {priority_rank(p)}" for p in PRIORITIES)
    + f" else {len(PRIORITIES)} end"
)


def list_queue(db: Queryable, merchant_id: str, filters: QueueFilters) -> list[Row]:
    sql, params = _queue_conditions(filters)
    return db.query(
        f"""select c.id, c.status, c.priority, c.queue,
            c.category_key_snapshot as category_key, c.category_label_snapshot as category_label,
            c.subcategory_key_snapshot as subcategory_key, c.customer_wa_id, c.created_at,
            -- Whichever field the merchant normalizes as an order number, since
            -- tenants name it differently (Step 6).
            (select cf.normalized_value
               from case_fields cf
              where cf.case_id = c.id and cf.normalize_rule_snapshot = 'order_number'
              order by cf.sort_order_snapshot limit 1) as order_number,
            (select count(*)::int from case_events e
              where e.case_id = c.id and e.kind = 'note') as note_count
       from cases c
       left join categories cat on cat.id = c.category_id
       left join subcategories sub on sub.id = c.subcategory_id
      where {sql}
      order by {PRIORITY_ORDER}, c.created_at asc
      limit {QUEUE_PAGE_SIZE}""",
        [merchant_id, *params],
    )


def list_queues(db: Queryable, merchant_id: str) -> list[Row]:
    """Queues with work outstanding, busiest first — the console's landing strip."""
    return db.query(
        """select c.queue, count(*)::int as n,
            count(*) filter (where c.priority = 'high')::int as high
       from cases c
      where c.merchant_id = $1 and c.status = any($2)
      group by c.queue
      order by n desc, c.queue nulls last""",
        [merchant_id, list(UNRESOLVED_STATUSES)],
    )


def list_case_events(db: Queryable, merchant_id: str, case_id: str) -> list[Row]:
    return db.query(
        """select e.id, e.kind, e.from_status, e.to_status, e.body, e.actor, e.created_at
       from case_events e
       join cases c on c.id = e.case_id
      where e.case_id = $2 and c.merchant_id = $1
      order by e.created_at, e.id""",
        [merchant_id, case_id],
    )


def transition_case(
    db: Database,
    merchant_id: str,
    case_id: str,
    to_status: str,
    note: str | None = None,
    actor: str = "agent",
) -> Result[Transition]:
    """Move a case to a new status, optionally with a note explaining why.

    The row is locked for the duration, so the transition is validated against
    the status that is actually current rather than the one the page rendered.
    """
    with db.transaction() as tx:
        rows = tx.query(
            "select status from cases where id = $2 and merchant_id = $1 for update",
            [merchant_id, case_id],
        )
        if not rows:
            return Err("case not found")
        plan = plan_transition(rows[0]["status"], to_status)
        if isinstance(plan, Err):
            return plan
        tx.query(
            """update cases
          set status = $3,
              resolved_at = case when $4 then now() else null end
        where id = $2 and merchant_id = $1""",
            [
                merchant_id,
                case_id,
                plan.value.to_status,
                is_terminal(plan.value.to_status),
            ],
        )
        tx.query(
            """insert into case_events (case_id, kind, from_status, to_status, body, actor)
       values ($1, 'status_change', $2, $3, $4, $5)""",
            [
                case_id,
                plan.value.from_status,
                plan.value.to_status,
                js_trim(note or "") or None,
                actor,
            ],
        )
        return Ok(plan.value)


def add_case_note(
    db: Queryable, merchant_id: str, case_id: str, body: str, actor: str = "agent"
) -> Result[None]:
    """Add an internal note. Never visible to the customer (SPEC §9)."""
    rows = db.query(
        """insert into case_events (case_id, kind, body, actor)
     select c.id, 'note', $3, $4 from cases c
      where c.id = $2 and c.merchant_id = $1
     returning id""",
        [merchant_id, case_id, body, actor],
    )
    return Err("case not found") if not rows else Ok(None)


def get_case_workflow(db: Queryable, merchant_id: str, case_id: str) -> Row | None:
    """The workflow header the detail page needs to render its action buttons."""
    rows = db.query(
        """select status, priority, queue, resolved_at from cases
      where id = $2 and merchant_id = $1""",
        [merchant_id, case_id],
    )
    return rows[0] if rows else None
