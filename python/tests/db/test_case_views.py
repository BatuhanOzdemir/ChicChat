"""Port of db/case-views.integration.test.ts (SPEC §8): simulator cases show up
correctly in the list, its filters, the detail view and the counters — and an
abandoned case plus an errored session both surface."""

from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime
from typing import Any

from chicchat.db.case_queries import (
    case_counters,
    get_case_detail,
    list_cases,
    list_errored_sessions,
)
from chicchat.db.config import DEMO_MERCHANT_ID
from chicchat.db.database import ConnectionDatabase
from chicchat.domain.cases.analytics import abandonment_rate
from chicchat.domain.cases.filters import CaseFilters, parse_case_filters
from chicchat.domain.result import Ok
from tests.db.helpers import RETURN_ANSWERS, complete_intake, say, simulate


def filters(**overrides: Any) -> CaseFilters:
    base = parse_case_filters({})
    assert isinstance(base, Ok), "default filters must parse"
    return replace(base.value, **overrides)


def intake(
    db: ConnectionDatabase,
    phone: str,
    category: str = "return",
    subcategory: str = "doesnt_fit",
    answers: dict[str, tuple[str, str]] | None = None,
) -> Any:
    return complete_intake(
        db, DEMO_MERCHANT_ID, phone, category, subcategory, answers or RETURN_ANSWERS
    )


def today() -> str:
    return datetime.now(UTC).date().isoformat()


def test_lists_a_completed_case_with_its_order_number_and_category(
    db: ConnectionDatabase,
) -> None:
    phone = "905550000501"
    done = intake(db, phone)
    assert done.completed_case is not None
    page = list_cases(db, DEMO_MERCHANT_ID, filters())
    row = next(r for r in page.rows if r["id"] == done.completed_case["case_id"])
    assert (
        row["status"],
        row["category_key"],
        row["subcategory_key"],
        row["order_number"],
        row["customer_wa_id"],
    ) == (
        "open",
        "return",
        "doesnt_fit",
        "TR100432",
        phone,
    )
    assert row["field_count"] == 4
    assert page.total > 0


def test_filters_by_status_category_order_number_and_date(
    db: ConnectionDatabase,
) -> None:
    done = intake(db, "905550000502")
    case_id = done.completed_case["case_id"]

    def has(**overrides: Any) -> bool:
        return any(
            r["id"] == case_id
            for r in list_cases(db, DEMO_MERCHANT_ID, filters(**overrides)).rows
        )

    assert has(order_number="TR100432")
    assert not has(order_number="TR999999")
    assert has(category_key="return")
    assert not has(category_key="wismo")
    assert not has(status="abandoned")
    assert has(from_date=today(), to_date=today())
    assert not has(from_date="2020-01-01", to_date="2020-01-02")


def test_shows_raw_and_normalized_values_and_a_timeline_in_the_detail_view(
    db: ConnectionDatabase,
) -> None:
    done = intake(
        db,
        "905550000503",
        "wrong_damaged_missing",
        "damaged",
        {
            "order_number": ("text", "#tr-100 432"),
            "item_ref": ("text", "red dress"),
            "description": ("text", "  seam  torn "),
            "photo": ("photo", "media.sim.torn"),
        },
    )
    detail = get_case_detail(db, DEMO_MERCHANT_ID, done.completed_case["case_id"])
    assert detail is not None
    assert detail["category_key"] == "wrong_damaged_missing"
    order = next(f for f in detail["fields"] if f["field_key"] == "order_number")
    assert order["raw_value"] == "#tr-100 432"
    assert order["normalized_value"] == "TR100432"
    # The photo is typed as media so the view can list it separately.
    photo = next(f for f in detail["fields"] if f["field_key"] == "photo")
    assert photo["type"] == "media"
    # Every field carries a capture time, which is what the timeline renders.
    assert all(f["created_at"] for f in detail["fields"])
    # The intake start was recorded, so "how long did it take" is answerable.
    assert detail["intake_started_at"] is not None


def test_does_not_expose_another_merchants_case(db: ConnectionDatabase) -> None:
    other_merchant_id = db.query(
        "insert into merchants (name) values ('Other Co.') returning id"
    )[0]["id"]
    done = intake(db, "905550000504")
    assert (
        get_case_detail(db, other_merchant_id, done.completed_case["case_id"]) is None
    )


def test_counts_by_status_category_and_day_and_measures_intake_duration(
    db: ConnectionDatabase,
) -> None:
    intake(db, "905550000505")
    counters = case_counters(db, DEMO_MERCHANT_ID)
    assert any(s["status"] == "open" for s in counters.by_status)
    assert any(c["category_key"] == "return" for c in counters.by_category)
    assert any(d["day"] == today() for d in counters.by_day)
    # Intake durations exist now that intake_started_at is recorded.
    assert counters.median_intake_seconds is not None
    assert counters.median_intake_seconds >= 0


def test_reports_an_abandonment_rate_once_a_session_is_abandoned(
    db: ConnectionDatabase,
) -> None:
    intake(db, "905550000506")
    quiet = "905550000507"
    say(db, DEMO_MERCHANT_ID, quiet, "text", "merhaba")
    say(db, DEMO_MERCHANT_ID, quiet, "list", "return")
    say(db, DEMO_MERCHANT_ID, quiet, "list", "doesnt_fit")
    say(db, DEMO_MERCHANT_ID, quiet, "list", "unworn_tags_on")
    swept = simulate(db, "time_travel", quiet, DEMO_MERCHANT_ID, ageMinutes=25 * 60)
    assert "abandoned 1" in swept.notice
    counters = case_counters(db, DEMO_MERCHANT_ID)
    assert counters.abandoned > 0
    rate = abandonment_rate(counters.completed, counters.abandoned)
    assert rate is not None and rate > 0
    abandoned = list_cases(db, DEMO_MERCHANT_ID, filters(status="abandoned"))
    assert any(r["customer_wa_id"] == quiet for r in abandoned.rows)


def test_lists_a_session_that_hit_an_unexpected_error(db: ConnectionDatabase) -> None:
    phone = "905550000508"
    say(db, DEMO_MERCHANT_ID, phone, "text", "merhaba", inject="handler_exception")
    row = next(
        s
        for s in list_errored_sessions(db, DEMO_MERCHANT_ID)
        if s["customer_wa_id"] == phone
    )
    assert "injected" in row["last_error"]
