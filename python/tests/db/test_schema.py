"""Port of db/schema.integration.test.ts: the migrated schema contains every
table and column described in docs/SPEC.md §4."""

from __future__ import annotations

from typing import Any

import psycopg
import pytest

EXPECTED: dict[str, list[str]] = {
    "merchants": ["id", "name", "locale", "rtl", "currency", "created_at"],
    "merchant_config": [
        "merchant_id",
        "return_window_days",
        "refund_sla_days",
        "auto_approve_threshold",
        "order_id_regex",
    ],
    "categories": ["id", "merchant_id", "key", "label", "sort_order", "enabled"],
    "subcategories": ["id", "category_id", "key", "label", "sort_order"],
    "field_defs": [
        "id",
        "category_id",
        "key",
        "type",
        "required",
        "enum_values",
        "normalize_rule",
    ],
    "routing_rules": [
        "id",
        "category_id",
        "condition",
        "action_type",
        "target_queue",
        "priority",
        "auto_resolve",
    ],
    "integrations": [
        "id",
        "merchant_id",
        "platform",
        "status",
        "oauth_token_ref",
        "connected_at",
    ],
    "cases": [
        "id",
        "merchant_id",
        "customer_wa_id",
        "category_id",
        "subcategory_id",
        "status",
        "integration_tier",
    ],
    "case_fields": ["id", "case_id", "field_key", "raw_value", "normalized_value"],
    "case_items": ["id", "case_id", "line_item_id", "title", "variant", "qty"],
}


@pytest.fixture(scope="module")
def actual(conn: psycopg.Connection[Any]) -> dict[str, set[str]]:
    rows = conn.execute(
        "select table_name, column_name from information_schema.columns where table_schema = 'public'"
    ).fetchall()
    tables: dict[str, set[str]] = {}
    for table_name, column_name in rows:
        tables.setdefault(table_name, set()).add(column_name)
    return tables


@pytest.mark.parametrize("table", list(EXPECTED))
def test_table_exists(actual: dict[str, set[str]], table: str) -> None:
    assert table in actual, f"missing table: {table}"


@pytest.mark.parametrize(
    ("table", "column"), [(t, c) for t, cols in EXPECTED.items() for c in cols]
)
def test_column_exists(actual: dict[str, set[str]], table: str, column: str) -> None:
    assert column in actual.get(table, set()), f"missing column: {table}.{column}"
