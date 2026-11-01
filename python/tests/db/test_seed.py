"""Port of db/seed.integration.test.ts: the seed is idempotent and a query
returns the full taxonomy plus the demo order's line items."""

from __future__ import annotations

from typing import Any

import psycopg
import pytest

from tests.db.conftest import run_seed

MERCHANT_ID = "00000000-0000-0000-0000-000000000001"
CASE_ID = "00000000-0000-0000-0000-000000000002"

# Scoped to the seeded keys: merchants can create their own categories.
SEEDED_CATEGORY_KEYS = [
    "wismo",
    "return",
    "exchange",
    "refund_not_received",
    "wrong_damaged_missing",
    "cancel_modify",
    "sizing_fit",
    "other",
]
EXPECTED_COUNTS = {
    "merchants": 1,
    "merchant_config": 1,
    "categories": 8,
    "subcategories": 29,
    "field_defs": 24,
    "routing_rules": 16,
    "cases": 1,
    "case_fields": 2,
    "case_items": 2,
}


def counts_for_demo_merchant(conn: psycopg.Connection[Any]) -> dict[str, int]:
    rows = conn.execute(
        """select 'merchants' k, count(*) n from merchants where id = %(m)s
     union all select 'merchant_config', count(*) from merchant_config where merchant_id = %(m)s
     union all select 'categories', count(*) from categories
        where merchant_id = %(m)s and key = any(%(k)s)
     union all select 'subcategories', count(*) from subcategories sc
        join categories c on c.id = sc.category_id
        where c.merchant_id = %(m)s and c.key = any(%(k)s)
     union all select 'field_defs', count(*) from field_defs fd
        join categories c on c.id = fd.category_id
        where c.merchant_id = %(m)s and c.key = any(%(k)s)
     union all select 'routing_rules', count(*) from routing_rules rr
        join categories c on c.id = rr.category_id
        where c.merchant_id = %(m)s and c.key = any(%(k)s)
     union all select 'cases', count(*) from cases where merchant_id = %(m)s and id = %(c)s
     union all select 'case_fields', count(*) from case_fields where case_id = %(c)s
     union all select 'case_items', count(*) from case_items where case_id = %(c)s""",
        {"m": MERCHANT_ID, "c": CASE_ID, "k": SEEDED_CATEGORY_KEYS},
    ).fetchall()
    return {k: int(n) for k, n in rows}


@pytest.fixture(scope="module")
def counts(conn: psycopg.Connection[Any]) -> tuple[dict[str, int], dict[str, int]]:
    run_seed()
    first = counts_for_demo_merchant(conn)
    run_seed()
    return first, counts_for_demo_merchant(conn)


def test_a_second_run_does_not_duplicate_any_rows(
    counts: tuple[dict[str, int], dict[str, int]],
) -> None:
    assert counts[1] == counts[0]


def test_row_counts_match_the_opinionated_default(
    counts: tuple[dict[str, int], dict[str, int]],
) -> None:
    assert counts[1] == EXPECTED_COUNTS


def test_returns_the_8_seeded_categories_in_sort_order(
    conn: psycopg.Connection[Any], counts: object
) -> None:
    rows = conn.execute(
        "select key from categories where merchant_id = %s and key = any(%s) order by sort_order",
        [MERCHANT_ID, SEEDED_CATEGORY_KEYS],
    ).fetchall()
    assert [r[0] for r in rows] == SEEDED_CATEGORY_KEYS


def test_marks_photo_required_on_wrong_damaged_missing_and_new_value_optional_on_cancel_modify(
    conn: psycopg.Connection[Any], counts: object
) -> None:
    rows = conn.execute(
        """select c.key cat, fd.key, fd.required
         from field_defs fd join categories c on c.id = fd.category_id
        where c.merchant_id = %s
          and (c.key, fd.key) in (('wrong_damaged_missing','photo'), ('cancel_modify','new_value'))""",
        [MERCHANT_ID],
    ).fetchall()
    by_cat = {cat: required for cat, _key, required in rows}
    assert by_cat["wrong_damaged_missing"] is True
    assert by_cat["cancel_modify"] is False


def test_loads_the_spec_3_finance_refunds_rule(
    conn: psycopg.Connection[Any], counts: object
) -> None:
    rows = conn.execute(
        """select rr.priority
         from routing_rules rr join categories c on c.id = rr.category_id
        where c.merchant_id = %s and c.key = 'refund_not_received'
          and rr.action_type = 'route' and rr.target_queue = 'finance_refunds_queue'""",
        [MERCHANT_ID],
    ).fetchall()
    assert len(rows) == 1
    assert rows[0][0] == "high"


def test_returns_the_demo_orders_line_items_with_normalized_order_number(
    conn: psycopg.Connection[Any], counts: object
) -> None:
    items = conn.execute(
        "select line_item_id, qty from case_items where case_id = %s order by line_item_id",
        [CASE_ID],
    ).fetchall()
    assert [r[0] for r in items] == ["li_8841", "li_8842"]
    rows = conn.execute(
        "select normalized_value from case_fields where case_id = %s and field_key = 'order_number'",
        [CASE_ID],
    ).fetchall()
    assert rows[0][0] == "TR100432"
