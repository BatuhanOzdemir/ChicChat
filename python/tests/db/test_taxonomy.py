"""Port of db/taxonomy.integration.test.ts (SPEC §8): a merchant-created
category with a custom enum field is usable end-to-end, and disabling a
default category removes it from the customer's menu."""

from __future__ import annotations

from typing import Any, TypeVar

from chicchat.db.config import (
    DEMO_MERCHANT_ID,
    build_intake_config,
    load_merchant_config,
)
from chicchat.db.database import ConnectionDatabase
from chicchat.db.taxonomy import (
    create_category,
    create_field,
    create_rule,
    create_subcategory,
    delete_category,
    delete_field,
    update_category,
    update_field,
    update_policy,
)
from chicchat.domain.config.forms import (
    FieldInput,
    RuleInput,
    parse_field,
    parse_named,
    parse_policy,
)
from chicchat.domain.result import Err, Ok, Result
from tests.db.helpers import row_ids, say

T = TypeVar("T")


def ok(result: Result[T]) -> T:
    assert isinstance(result, Ok), f"parse failed: {result}"
    return result.value


def send(db: ConnectionDatabase, phone: str, kind: str, value: str) -> Any:
    return say(db, DEMO_MERCHANT_ID, phone, kind, value)


def test_is_offered_tappable_and_completes_an_intake(db: ConnectionDatabase) -> None:
    # 1. Create the category the way the UI does: label in, key derived.
    created = create_category(
        db,
        DEMO_MERCHANT_ID,
        ok(parse_named({"label": "Kargo Şikâyeti", "sort_order": "5"}, "category")),
    )
    category_id = ok(created)
    create_subcategory(
        db,
        DEMO_MERCHANT_ID,
        category_id,
        ok(parse_named({"label": "Geç teslim"}, "subcategory")),
    )
    # 2. A custom enum field — the thing that used to be unanswerable.
    create_field(
        db,
        DEMO_MERCHANT_ID,
        category_id,
        ok(
            parse_field(
                {
                    "label": "Damage type",
                    "type": "enum",
                    "required": "on",
                    "enum_values": "Torn seam\nStain\nBroken zip",
                    "sort_order": "10",
                }
            )
        ),
    )
    create_field(
        db,
        DEMO_MERCHANT_ID,
        category_id,
        ok(
            parse_field(
                {
                    "label": "Order number",
                    "key": "order_number",
                    "type": "string",
                    "required": "on",
                    "normalize_rule": "order_number",
                    "sort_order": "20",
                }
            )
        ),
    )
    # 3. The intake config now includes it, with the derived key.
    custom = next(
        c
        for c in build_intake_config(db, DEMO_MERCHANT_ID)["categories"]
        if c["key"] == "kargo_sikayeti"
    )
    assert custom["label"] == "Kargo Şikâyeti"
    # 4. Drive it in the simulator.
    phone = "905550000301"
    first = send(db, phone, "text", "merhaba")
    assert "kargo_sikayeti" in row_ids(first.outbound[0])
    send(db, phone, "list", "kargo_sikayeti")
    after_sub = send(db, phone, "list", "gec_teslim")
    # The enum field is asked as a tappable list, not a free-text question.
    assert row_ids(after_sub.outbound[0]) == ["torn_seam", "stain", "broken_zip"]
    # 5. Tap an option, answer the order number, and the case completes.
    send(db, phone, "list", "stain")
    done = send(db, phone, "text", "  #tr-100 432 ")
    case = done.completed_case
    assert (case["category"], case["subcategory"]) == ("kargo_sikayeti", "gec_teslim")
    assert case["fields"]["damage_type"] == "stain"
    assert case["fields"]["order_number"] == "TR100432"


def test_rejects_a_duplicate_category_key_with_a_readable_message(
    db: ConnectionDatabase,
) -> None:
    data = ok(parse_named({"label": "Kargo Şikâyeti"}, "category"))
    assert create_category(db, DEMO_MERCHANT_ID, data).ok
    assert create_category(db, DEMO_MERCHANT_ID, data) == Err(
        'a category with key "kargo_sikayeti" already exists'
    )


def test_removes_a_disabled_category_from_the_customers_menu(
    db: ConnectionDatabase,
) -> None:
    config = load_merchant_config(db, DEMO_MERCHANT_ID)
    assert config is not None
    exchange = next(c for c in config.categories if c.key == "exchange")
    assert "exchange" in [
        c["key"] for c in build_intake_config(db, DEMO_MERCHANT_ID)["categories"]
    ]
    update_category(
        db, DEMO_MERCHANT_ID, exchange.id, exchange.label, exchange.sort_order, False
    )
    assert "exchange" not in [
        c["key"] for c in build_intake_config(db, DEMO_MERCHANT_ID)["categories"]
    ]
    # …and it is gone from the menu the customer actually sees.
    first = send(db, "905550000302", "text", "hi")
    assert "exchange" not in row_ids(first.outbound[0])


def test_asks_fields_in_the_merchants_configured_order(db: ConnectionDatabase) -> None:
    config = load_merchant_config(db, DEMO_MERCHANT_ID)
    assert config is not None
    other = next(c for c in config.categories if c.key == "other")
    description = next(f for f in other.fields if f.key == "description")
    order_number = next(f for f in other.fields if f.key == "order_number")
    # Make order_number required and put it first.
    update_field(
        db,
        DEMO_MERCHANT_ID,
        order_number.id,
        FieldInput(
            order_number.key,
            order_number.label,
            "string",
            True,
            None,
            "order_number",
            1,
        ),
    )
    update_field(
        db,
        DEMO_MERCHANT_ID,
        description.id,
        FieldInput(description.key, description.label, "string", True, None, None, 2),
    )
    phone = "905550000303"
    send(db, phone, "text", "hi")
    picked = send(db, phone, "list", "other")
    assert picked.session["pendingFieldKey"] == "order_number"


def test_deletes_a_category_and_a_field(db: ConnectionDatabase) -> None:
    config = load_merchant_config(db, DEMO_MERCHANT_ID)
    assert config is not None
    sizing = next(c for c in config.categories if c.key == "sizing_fit")
    question = next(f for f in sizing.fields if f.key == "question")
    delete_field(db, DEMO_MERCHANT_ID, question.id)
    delete_category(db, DEMO_MERCHANT_ID, sizing.id)
    after = load_merchant_config(db, DEMO_MERCHANT_ID)
    assert after is not None
    assert "sizing_fit" not in [c.key for c in after.categories]


def test_persists_inactivity_kvkk_and_retention_values(db: ConnectionDatabase) -> None:
    update_policy(
        db,
        DEMO_MERCHANT_ID,
        ok(
            parse_policy(
                {
                    "return_window_days": "45",
                    "refund_sla_days": "21",
                    "nudge_after_minutes": "15",
                    "abandon_after_hours": "48",
                    "retention_months": "6",
                    "kvkk_url": "https://demo.example/kvkk",
                    "order_id_regex": "^[A-Z0-9]{4,}$",
                }
            )
        ),
    )
    config = load_merchant_config(db, DEMO_MERCHANT_ID)
    assert config is not None
    s = config.settings
    assert (
        s["return_window_days"],
        s["nudge_after_minutes"],
        s["abandon_after_hours"],
        s["retention_months"],
        s["kvkk_url"],
    ) == (
        45,
        15,
        48,
        6,
        "https://demo.example/kvkk",
    )


def test_will_not_write_a_child_row_into_another_merchants_category(
    db: ConnectionDatabase,
) -> None:
    other = db.query("insert into merchants (name) values ('Other Co.') returning id")[
        0
    ]["id"]
    config = load_merchant_config(db, DEMO_MERCHANT_ID)
    assert config is not None
    victim = config.categories[0]
    assert create_field(
        db, other, victim.id, ok(parse_field({"label": "sneaky", "type": "string"}))
    ) == Err("unknown category")
    rule = create_rule(
        db, other, victim.id, RuleInput(None, {"all": []}, "route", "q", None, 1)
    )
    assert not rule.ok


def test_category_subcategory_and_field_writes_preserve_saved_non_default_policy(
    db: ConnectionDatabase,
) -> None:
    update_policy(
        db,
        DEMO_MERCHANT_ID,
        ok(
            parse_policy(
                {
                    "return_window_days": "47",
                    "refund_sla_days": "9",
                    "nudge_after_minutes": "12",
                    "abandon_after_hours": "72",
                    "retention_months": "4",
                    "kvkk_url": "https://example.com/privacy",
                    "order_id_regex": "^[A-Z0-9]{5,}$",
                }
            )
        ),
    )
    before = load_merchant_config(db, DEMO_MERCHANT_ID)
    assert before is not None
    category_id = ok(
        create_category(
            db,
            DEMO_MERCHANT_ID,
            ok(parse_named({"label": "Policy regression"}, "category")),
        )
    )
    create_subcategory(
        db,
        DEMO_MERCHANT_ID,
        category_id,
        ok(parse_named({"label": "Child"}, "subcategory")),
    )
    create_field(
        db,
        DEMO_MERCHANT_ID,
        category_id,
        ok(parse_field({"label": "Details", "type": "string"})),
    )
    after = load_merchant_config(db, DEMO_MERCHANT_ID)
    assert after is not None
    assert after.settings == before.settings
