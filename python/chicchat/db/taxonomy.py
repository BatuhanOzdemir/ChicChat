"""Taxonomy CRUD (SPEC §§4, 8) — port of db/taxonomy.ts.

Everything a merchant can create, rename, reorder, disable or delete —
categories, subcategories, field defs and routing rules — plus the policy
settings. All writes are scoped by merchant id, and child writes verify the
parent belongs to the merchant, so a crafted form cannot reach another
tenant's rows.
"""

from __future__ import annotations

import psycopg.errors

from chicchat.db.database import Queryable, Row
from chicchat.domain.config.forms import FieldInput, NamedInput, PolicyInput, RuleInput
from chicchat.domain.jscompat import js_json_stringify
from chicchat.domain.result import Err, Ok, Result

WriteResult = Result[str]
"""Ok(new row id) or Err(message for the form)."""

# Postgres unique_violation (23505). A duplicate inside a transaction poisons
# it, so each insert that may collide runs in its own savepoint when the caller
# has a transaction open — as Postgres requires and TypeScript's caller did.


def _insert_returning_id(db: Queryable, sql: str, params: list[object]) -> str:
    rows = db.query(sql, params)
    new_id: str = rows[0]["id"]
    return new_id


def _guarded_insert(
    db: Queryable, sql: str, params: list[object], duplicate_message: str
) -> WriteResult:
    transaction = getattr(db, "transaction", None)
    try:
        if transaction is not None:
            with transaction() as tx:
                return Ok(_insert_returning_id(tx, sql, params))
        return Ok(_insert_returning_id(db, sql, params))
    except psycopg.errors.UniqueViolation:
        return Err(duplicate_message)


# --- Policy ------------------------------------------------------------------


def update_policy(db: Queryable, merchant_id: str, policy: PolicyInput) -> None:
    db.query(
        """update merchant_config
        set return_window_days = $2, refund_sla_days = $3,
            nudge_after_minutes = $4, abandon_after_hours = $5,
            retention_months = $6, kvkk_url = $7, order_id_regex = $8
      where merchant_id = $1""",
        [
            merchant_id,
            policy.return_window_days,
            policy.refund_sla_days,
            policy.nudge_after_minutes,
            policy.abandon_after_hours,
            policy.retention_months,
            policy.kvkk_url,
            policy.order_id_regex,
        ],
    )


# --- Categories --------------------------------------------------------------


def create_category(db: Queryable, merchant_id: str, data: NamedInput) -> WriteResult:
    return _guarded_insert(
        db,
        """insert into categories (merchant_id, key, label, sort_order, enabled)
       values ($1, $2, $3, $4, true) returning id""",
        [merchant_id, data.key, data.label, data.sort_order],
        f'a category with key "{data.key}" already exists',
    )


def update_category(
    db: Queryable,
    merchant_id: str,
    category_id: str,
    label: str,
    sort_order: int,
    enabled: bool,
) -> None:
    db.query(
        """update categories set label = $3, sort_order = $4, enabled = $5
      where id = $2 and merchant_id = $1""",
        [merchant_id, category_id, label, sort_order, enabled],
    )


def delete_category(db: Queryable, merchant_id: str, category_id: str) -> None:
    db.query(
        "delete from categories where id = $2 and merchant_id = $1",
        [merchant_id, category_id],
    )


def _owns_category(db: Queryable, merchant_id: str, category_id: str) -> bool:
    """True when the category belongs to this merchant (guards child writes)."""
    rows = db.query(
        "select 1 from categories where id = $2 and merchant_id = $1",
        [merchant_id, category_id],
    )
    return len(rows) > 0


# --- Subcategories -----------------------------------------------------------


def create_subcategory(
    db: Queryable, merchant_id: str, category_id: str, data: NamedInput
) -> WriteResult:
    if not _owns_category(db, merchant_id, category_id):
        return Err("unknown category")
    return _guarded_insert(
        db,
        """insert into subcategories (category_id, key, label, sort_order)
       values ($1, $2, $3, $4) returning id""",
        [category_id, data.key, data.label, data.sort_order],
        f'"{data.key}" already exists in this category',
    )


def delete_subcategory(db: Queryable, merchant_id: str, subcategory_id: str) -> None:
    db.query(
        """delete from subcategories sc
      using categories c
      where sc.id = $2 and c.id = sc.category_id and c.merchant_id = $1""",
        [merchant_id, subcategory_id],
    )


# --- Field definitions -------------------------------------------------------


def _enum_json(values: list[str] | None) -> str | None:
    return js_json_stringify(values) if values else None


def create_field(
    db: Queryable, merchant_id: str, category_id: str, data: FieldInput
) -> WriteResult:
    if not _owns_category(db, merchant_id, category_id):
        return Err("unknown category")
    return _guarded_insert(
        db,
        """insert into field_defs
         (category_id, key, label, type, required, enum_values, normalize_rule, sort_order)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id""",
        [
            category_id,
            data.key,
            data.label,
            data.type,
            data.required,
            _enum_json(data.enum_values),
            data.normalize_rule,
            data.sort_order,
        ],
        f'field "{data.key}" already exists here',
    )


def update_field(
    db: Queryable, merchant_id: str, field_id: str, data: FieldInput
) -> None:
    db.query(
        """update field_defs fd
        set label = $3, type = $4, required = $5, enum_values = $6,
            normalize_rule = $7, sort_order = $8
      from categories c
      where fd.id = $2 and c.id = fd.category_id and c.merchant_id = $1""",
        [
            merchant_id,
            field_id,
            data.label,
            data.type,
            data.required,
            _enum_json(data.enum_values),
            data.normalize_rule,
            data.sort_order,
        ],
    )


def delete_field(db: Queryable, merchant_id: str, field_id: str) -> None:
    db.query(
        """delete from field_defs fd
      using categories c
      where fd.id = $2 and c.id = fd.category_id and c.merchant_id = $1""",
        [merchant_id, field_id],
    )


# --- Routing rules -----------------------------------------------------------


def create_rule(
    db: Queryable, merchant_id: str, category_id: str, data: RuleInput
) -> WriteResult:
    if not _owns_category(db, merchant_id, category_id):
        return Err("unknown category")
    rows = db.query(
        """insert into routing_rules
       (category_id, label, condition, action_type, target_queue, priority,
        sort_order, auto_resolve)
     values ($1, $2, $3, $4, $5, $6, $7, false) returning id""",
        [
            category_id,
            data.label,
            js_json_stringify(data.condition),
            data.action_type,
            data.target_queue,
            data.priority,
            data.sort_order,
        ],
    )
    return Ok(rows[0]["id"])


def delete_rule(db: Queryable, merchant_id: str, rule_id: str) -> None:
    db.query(
        """delete from routing_rules rr
      using categories c
      where rr.id = $2 and c.id = rr.category_id and c.merchant_id = $1""",
        [merchant_id, rule_id],
    )


def list_rules(db: Queryable, merchant_id: str) -> list[Row]:
    """Routing rules for the editor, in the order the engine evaluates them."""
    return db.query(
        """select rr.id, rr.category_id, rr.label, rr.condition, rr.action_type,
            rr.target_queue, rr.priority, rr.sort_order
       from routing_rules rr
       join categories c on c.id = rr.category_id
      where c.merchant_id = $1
      -- Same order the engine evaluates them in, so the editor shows
      -- precedence as it actually is (first match wins).
      order by c.sort_order, rr.sort_order, rr.created_at, rr.id""",
        [merchant_id],
    )
