"""Port of db/cases.integration.test.ts: a full Tier-0 intake is persisted,
read back, and the agent-handoff JSON matches."""

from __future__ import annotations

import pytest

from chicchat.db.cases import (
    CaseItemInput,
    PersistCaseInput,
    build_handoff,
    persist_case,
)
from chicchat.db.database import ConnectionDatabase
from chicchat.domain.intake import SimulationScript, simulate_intake
from chicchat.domain.intake.fixtures import DEMO_INTAKE_CONFIG

MERCHANT_ID = "00000000-0000-0000-0000-000000000001"


def test_round_trips_a_wrong_damaged_case_into_a_matching_handoff_package(
    db: ConnectionDatabase,
) -> None:
    intake_case = simulate_intake(
        DEMO_INTAKE_CONFIG,
        SimulationScript(
            category="wrong_damaged_missing",
            subcategory="damaged",
            fields={
                "order_number": "#tr-100 432",
                "item_ref": "the red summer dress",
                "photo": "wamid.HBgMedia123",
                "description": "  the seam is torn  ",
            },
        ),
    ).case
    assert intake_case is not None
    case_id = persist_case(
        db,
        PersistCaseInput(
            merchant_id=MERCHANT_ID,
            customer_wa_id="+905550000001",
            category_key=intake_case["category"],
            subcategory_key=intake_case["subcategory"],
            integration_tier=intake_case["integration_tier"],
            fields=intake_case["fields"],
        ),
    )
    handoff = build_handoff(db, case_id)
    assert handoff == {
        "case_id": case_id,
        "category": "wrong_damaged_missing",
        "subcategory": "damaged",
        "integration_tier": 0,
        "status": "open",
        # No routing decision was passed, so the case defaults to unrouted at
        # normal priority — the handler supplies these from the rules (SPEC §3).
        "queue": None,
        "priority": "normal",
        "customer_wa_id": "+905550000001",
        "fields": {f["key"]: f["normalized"] for f in intake_case["fields"]},
        "photos": ["wamid.HBgMedia123"],
        "items": [],
    }
    # sanity: normalization actually happened on the way in
    assert handoff["fields"]["order_number"] == "TR100432"
    assert handoff["fields"]["description"] == "the seam is torn"


def test_stores_and_returns_case_items_in_the_handoff(db: ConnectionDatabase) -> None:
    case_id = persist_case(
        db,
        PersistCaseInput(
            merchant_id=MERCHANT_ID,
            customer_wa_id="+905550000002",
            category_key="return",
            subcategory_key="doesnt_fit",
            integration_tier=1,
            fields=[
                {"key": "order_number", "raw": "TR100432", "normalized": "TR100432"},
                {"key": "reason", "raw": "doesnt fit", "normalized": "doesnt fit"},
            ],
            items=[
                CaseItemInput("li_8841", "Slim Fit Shirt — Blue / M", "Blue / M", 1),
                CaseItemInput(
                    "li_8842", "Chino Trousers — Beige / 32", "Beige / 32", 2
                ),
            ],
        ),
    )
    handoff = build_handoff(db, case_id)
    assert handoff["integration_tier"] == 1
    assert handoff["items"] == [
        {
            "line_item_id": "li_8841",
            "title": "Slim Fit Shirt — Blue / M",
            "variant": "Blue / M",
            "qty": 1,
        },
        {
            "line_item_id": "li_8842",
            "title": "Chino Trousers — Beige / 32",
            "variant": "Beige / 32",
            "qty": 2,
        },
    ]
    assert handoff["photos"] == []
    assert handoff["fields"] == {"order_number": "TR100432", "reason": "doesnt fit"}


def test_rejects_an_unknown_category(db: ConnectionDatabase) -> None:
    with pytest.raises(LookupError, match="unknown category"):
        persist_case(
            db,
            PersistCaseInput(
                merchant_id=MERCHANT_ID,
                customer_wa_id="+905550000003",
                category_key="not_a_category",
                fields=[],
            ),
        )
