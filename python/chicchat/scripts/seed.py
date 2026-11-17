"""Idempotent seed of the opinionated default — port of scripts/seed.mjs.

Seeds: one demo merchant + merchant_config; the 8 default categories with their
subcategories, field_defs (required flags) and default routing rules; one demo
"order" (a demo case with line items); a second tenant with a deliberately
different Turkish taxonomy; and the WhatsApp channel of each.

Idempotent: re-running produces identical rows. Parents are upserted on their
natural unique keys (or fixed UUIDs); rules and case_items are owned by this
seed and replaced via scoped delete+insert.

Run: `uv run python -m chicchat.scripts.seed` (reads DATABASE_URL; set
WHATSAPP_PHONE_NUMBER_ID to link the demo merchant to a real number).
"""

from __future__ import annotations

import os
import sys
from typing import Any

import psycopg

from chicchat.db.database import ConnectionDatabase, Queryable, configure_connection
from chicchat.domain.jscompat import js_json_stringify

LOCAL_DEFAULT = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"

# Fixed ids so re-runs target the same rows.
MERCHANT_ID = "00000000-0000-0000-0000-000000000001"
CASE_ID = "00000000-0000-0000-0000-000000000002"
SECOND_MERCHANT_ID = "00000000-0000-0000-0000-000000000003"
SECOND_PHONE_NUMBER_ID = "second-merchant-phone-number-id"


def demo_phone_number_id() -> str:
    """Inbound messages are routed by `phone_number_id`, so the demo merchant is
    linked to whatever number the environment points at; a placeholder otherwise."""
    return os.environ.get("WHATSAPP_PHONE_NUMBER_ID") or "demo-phone-number-id"


MERCHANT: dict[str, Any] = {
    "id": MERCHANT_ID,
    "name": "Demo Apparel Co.",
    "locale": "en",
    "rtl": False,
    "currency": "USD",
    "config": {
        "return_window_days": 30,
        "refund_sla_days": 14,
        "auto_approve_threshold": 50.0,
        "order_id_regex": "^[A-Z0-9]{4,}$",
        # Every new conversation opens by disclosing this (SPEC §12).
        "kvkk_url": "https://demo-apparel.example.com/kvkk",
    },
}


def _eq(field: str, value: object) -> dict[str, Any]:
    return {"all": [{"field": field, "op": "eq", "value": value}]}


def _rule(
    condition: dict[str, Any], action_type: str, target_queue: str | None, priority: str
) -> dict[str, Any]:
    return {
        "condition": condition,
        "action_type": action_type,
        "target_queue": target_queue,
        "priority": priority,
    }


# field tuple: (key, type, required, enum_values | None, normalize_rule | None)
TAXONOMY: list[dict[str, Any]] = [
    {
        "key": "wismo",
        "label": "Where is my order?",
        "subcategories": [
            ("not_shipped", "Not shipped yet"),
            ("shipped_not_arrived", "Shipped, not arrived"),
            ("marked_delivered_not_received", "Marked delivered but not received"),
            ("delayed", "Delayed past estimate"),
        ],
        "fields": [("order_number", "string", True, None, "order_number")],
        "rules": [
            _rule(
                _eq("subcategory", "marked_delivered_not_received"),
                "escalate",
                "claims_carrier_dispute",
                "high",
            )
        ],
    },
    {
        "key": "return",
        "label": "Return request",
        "subcategories": [
            ("changed_mind", "Changed my mind"),
            ("doesnt_fit", "Doesn't fit"),
            ("not_as_described", "Not as described"),
            ("arrived_too_late", "Arrived too late"),
            ("found_cheaper", "Found it cheaper"),
        ],
        "fields": [
            ("order_number", "string", True, None, "order_number"),
            ("item_ref", "ref", True, None, None),
            # SPEC §5: an enum must be tappable, so it carries its own values.
            (
                "reason",
                "enum",
                True,
                [
                    "wrong_size",
                    "poor_quality",
                    "looks_different",
                    "changed_mind",
                    "arrived_late",
                    "other",
                ],
                None,
            ),
            ("condition", "enum", True, ["unworn_tags_on", "worn_tags_removed"], None),
        ],
        "rules": [
            _rule(
                _eq("subcategory", "not_as_described"), "request_info", None, "normal"
            ),
            _rule(
                _eq("within_return_window", False),
                "escalate",
                "policy_exception",
                "normal",
            ),
            _rule(
                _eq("within_return_window", True), "route", "returns_queue", "normal"
            ),
        ],
    },
    {
        "key": "exchange",
        "label": "Exchange",
        "subcategories": [
            ("different_size", "Different size"),
            ("different_color", "Different color"),
            ("different_item", "Different item"),
        ],
        "fields": [
            ("order_number", "string", True, None, "order_number"),
            ("item_ref", "ref", True, None, None),
            (
                "desired_variant",
                "enum",
                True,
                None,
                None,
            ),  # catalog-driven; validated when connected
            (
                "reason",
                "enum",
                True,
                [
                    "wrong_size",
                    "wrong_color",
                    "poor_quality",
                    "looks_different",
                    "other",
                ],
                None,
            ),
        ],
        "rules": [
            _rule(
                _eq("variant_in_stock", False),
                "escalate",
                "exchange_out_of_stock",
                "normal",
            ),
            _rule(
                {
                    "all": [
                        {"field": "variant_in_stock", "op": "eq", "value": True},
                        {"field": "within_return_window", "op": "eq", "value": True},
                    ]
                },
                "route",
                "exchange_queue",
                "normal",
            ),
        ],
    },
    {
        "key": "refund_not_received",
        "label": "Refund not received",
        "subcategories": [
            ("not_issued", "Not issued yet"),
            ("issued_not_in_account", "Issued but not in my account"),
            ("partial_refund", "Partial refund"),
            ("wrong_amount", "Wrong amount"),
        ],
        "fields": [
            ("order_number", "string", True, None, "order_number"),
            ("return_proof", "string", True, None, None),
            (
                "refund_method",
                "enum",
                True,
                [
                    "original_payment",
                    "store_credit",
                    "bank_transfer",
                    "cash_on_delivery",
                ],
                None,
            ),
            ("date_returned", "string", True, None, None),
        ],
        "rules": [
            # SPEC §3 example: refund received + past SLA -> finance queue, high priority.
            _rule(
                {
                    "all": [
                        {"field": "refund_status", "op": "eq", "value": "received"},
                        {
                            "field": "days_since_return_received",
                            "op": "gt",
                            "ref": "refund_sla_days",
                        },
                    ]
                },
                "route",
                "finance_refunds_queue",
                "high",
            ),
            _rule(
                {
                    "all": [
                        {"field": "refund_status", "op": "eq", "value": "received"},
                        {
                            "field": "days_since_return_received",
                            "op": "lte",
                            "ref": "refund_sla_days",
                        },
                    ]
                },
                "auto_reply",
                None,
                "normal",
            ),
            _rule(
                {
                    "all": [
                        {
                            "field": "subcategory",
                            "op": "in",
                            "value": ["partial_refund", "wrong_amount"],
                        }
                    ]
                },
                "escalate",
                "finance_review",
                "normal",
            ),
        ],
    },
    {
        "key": "wrong_damaged_missing",
        "label": "Wrong / damaged / missing item",
        "subcategories": [
            ("wrong_item", "Wrong item sent"),
            ("wrong_size_sent", "Wrong size sent"),
            ("damaged", "Damaged"),
            ("defective", "Defective"),
            ("item_missing", "Item missing from order"),
        ],
        "fields": [
            ("order_number", "string", True, None, "order_number"),
            ("item_ref", "ref", True, None, None),
            ("photo", "media", True, None, None),
            ("description", "string", True, None, None),
        ],
        "rules": [
            _rule(
                {
                    "all": [
                        {
                            "field": "subcategory",
                            "op": "in",
                            "value": ["damaged", "defective"],
                        },
                        {"field": "photo", "op": "present"},
                    ]
                },
                "route",
                "priority_replacements",
                "high",
            ),
            _rule(
                {"all": [{"field": "photo", "op": "absent"}]},
                "request_info",
                None,
                "normal",
            ),
            _rule(
                _eq("subcategory", "item_missing"),
                "escalate",
                "verify_order_contents",
                "normal",
            ),
        ],
    },
    {
        "key": "cancel_modify",
        "label": "Cancel or modify order",
        "subcategories": [
            ("cancel", "Cancel order"),
            ("change_size_variant", "Change size/variant"),
            ("change_address", "Change shipping address"),
            ("change_payment", "Change payment"),
        ],
        "fields": [
            ("order_number", "string", True, None, "order_number"),
            (
                "change_type",
                "enum",
                True,
                ["cancel", "size_variant", "shipping_address", "payment"],
                None,
            ),
            ("new_value", "string", False, None, None),  # only when modifying
        ],
        "rules": [
            _rule(
                {"all": [{"field": "order_status", "op": "neq", "value": "shipped"}]},
                "route",
                "order_changes",
                "normal",
            ),
            _rule(
                _eq("order_status", "shipped"),
                "escalate",
                "convert_to_return",
                "normal",
            ),
        ],
    },
    {
        "key": "sizing_fit",
        "label": "Sizing & fit help",
        "subcategories": [
            ("which_size", "Which size should I get"),
            ("fit_measurements", "Fit & measurements"),
            ("fabric_care", "Fabric & care"),
            ("in_stock", "Is it in stock"),
        ],
        "fields": [
            ("product_ref", "string", True, None, None),
            ("question", "string", True, None, None),
        ],
        # Low-stakes: deflect with a size-guide / KB auto-reply. Always-match default.
        "rules": [_rule({"all": []}, "auto_reply", "size_guide_kb", "low")],
    },
    {
        "key": "other",
        "label": "Other / talk to a human",
        "subcategories": [],
        "fields": [
            ("description", "string", True, None, None),
            ("order_number", "string", False, None, "order_number"),  # optional
        ],
        "rules": [_rule({"all": []}, "route", "human", "normal")],
    },
]

# A second tenant with a deliberately different taxonomy, so multi-tenancy is
# demonstrable: different keys, labels, language, policy windows and queues.
SECOND_MERCHANT: dict[str, Any] = {
    "id": SECOND_MERCHANT_ID,
    "name": "Butik Moda",
    "locale": "tr",
    "rtl": False,
    "currency": "TRY",
    "config": {
        "return_window_days": 14,
        "refund_sla_days": 7,
        "auto_approve_threshold": 250.0,
        "order_id_regex": "^BM[0-9]{5,}$",
        "kvkk_url": "https://butikmoda.example.com/kvkk-aydinlatma-metni",
    },
}

SECOND_TAXONOMY: list[dict[str, Any]] = [
    {
        "key": "iade",
        "label": "İade talebi",
        "subcategories": [("beden", "Beden uymadı"), ("fikir_degisti", "Vazgeçtim")],
        "fields": [
            ("siparis_no", "string", True, None, "order_number"),
            ("urun", "ref", True, None, None),
            ("durum", "enum", True, ["etiketli", "etiketsiz"], None),
        ],
        "rules": [
            _rule(_eq("durum", "etiketsiz"), "escalate", "iade_istisna", "high"),
            _rule({"all": []}, "route", "iade_kuyrugu", "normal"),
        ],
    },
    {
        "key": "kargo",
        "label": "Kargo nerede?",
        "subcategories": [("gelmedi", "Hiç gelmedi"), ("gecikti", "Gecikti")],
        "fields": [("siparis_no", "string", True, None, "order_number")],
        "rules": [
            _rule(_eq("subcategory", "gelmedi"), "escalate", "kargo_takip", "high")
        ],
    },
]


def channels() -> list[dict[str, Any]]:
    """Which WhatsApp number reaches which merchant (SPEC §10)."""
    return [
        {
            "merchant_id": MERCHANT_ID,
            "phone_number_id": demo_phone_number_id(),
            "waba_id": os.environ.get("WHATSAPP_BUSINESS_ACCOUNT_ID"),
            "display_number": "Demo Apparel line",
        },
        {
            "merchant_id": SECOND_MERCHANT_ID,
            "phone_number_id": SECOND_PHONE_NUMBER_ID,
            "waba_id": None,
            "display_number": "Butik Moda line",
        },
    ]


DEMO_CASE: dict[str, Any] = {
    "id": CASE_ID,
    "customer_wa_id": "+905551234567",
    "category_key": "return",
    "subcategory_key": "doesnt_fit",
    "status": "open",
    "integration_tier": 0,
    # raw shows messy input; normalized is what the normalization layer produces.
    "fields": [
        ("order_number", "#TR-100 432", "TR100432"),
        ("reason", "Doesn't fit", "doesnt_fit"),
    ],
    "items": [
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
    ],
}


def _j(value: object) -> str | None:
    return None if value is None else js_json_stringify(value)


def seed_merchant(
    db: Queryable, merchant: dict[str, Any], taxonomy: list[dict[str, Any]]
) -> dict[str, str]:
    """One tenant: merchant row, config, categories/subcategories/fields/rules."""
    db.query(
        """insert into merchants (id, name, locale, rtl, currency)
     values ($1, $2, $3, $4, $5)
     on conflict (id) do update
       set name = excluded.name, locale = excluded.locale,
           rtl = excluded.rtl, currency = excluded.currency""",
        [
            merchant["id"],
            merchant["name"],
            merchant["locale"],
            merchant["rtl"],
            merchant["currency"],
        ],
    )
    config = merchant["config"]
    db.query(
        """insert into merchant_config
       (merchant_id, return_window_days, refund_sla_days, auto_approve_threshold, order_id_regex, kvkk_url)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (merchant_id) do update
       set return_window_days = excluded.return_window_days,
           refund_sla_days = excluded.refund_sla_days,
           auto_approve_threshold = excluded.auto_approve_threshold,
           order_id_regex = excluded.order_id_regex,
           kvkk_url = excluded.kvkk_url""",
        [
            merchant["id"],
            config["return_window_days"],
            config["refund_sla_days"],
            config["auto_approve_threshold"],
            config["order_id_regex"],
            config["kvkk_url"],
        ],
    )
    # Rules are owned by the seed -> clear this merchant's rules first.
    db.query(
        """delete from routing_rules
      where category_id in (select id from categories where merchant_id = $1)""",
        [merchant["id"]],
    )
    category_id_by_key: dict[str, str] = {}
    for i, cat in enumerate(taxonomy):
        rows = db.query(
            """insert into categories (merchant_id, key, label, sort_order, enabled)
       values ($1, $2, $3, $4, true)
       on conflict (merchant_id, key) do update
         set label = excluded.label, sort_order = excluded.sort_order, enabled = excluded.enabled
       returning id""",
            [merchant["id"], cat["key"], cat["label"], i + 1],
        )
        category_id = rows[0]["id"]
        category_id_by_key[cat["key"]] = category_id
        for s, (key, label) in enumerate(cat["subcategories"]):
            db.query(
                """insert into subcategories (category_id, key, label, sort_order)
         values ($1, $2, $3, $4)
         on conflict (category_id, key) do update
           set label = excluded.label, sort_order = excluded.sort_order""",
                [category_id, key, label, s + 1],
            )
        # Fields are seeded in the order the spec lists them, and that order is
        # what the intake asks in (sort_order, not alphabetically).
        for f, (key, field_type, required, enum_values, normalize_rule) in enumerate(
            cat["fields"]
        ):
            db.query(
                """insert into field_defs
           (category_id, key, type, required, enum_values, normalize_rule, sort_order)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (category_id, key) do update
           set type = excluded.type, required = excluded.required,
               enum_values = excluded.enum_values,
               normalize_rule = excluded.normalize_rule,
               sort_order = excluded.sort_order""",
                [
                    category_id,
                    key,
                    field_type,
                    required,
                    _j(enum_values),
                    normalize_rule,
                    (f + 1) * 10,
                ],
            )
        # Rules are first-match-wins, so their listed order is their precedence.
        for r, rule in enumerate(cat["rules"]):
            db.query(
                """insert into routing_rules
           (category_id, condition, action_type, target_queue, priority,
            sort_order, auto_resolve)
         values ($1, $2, $3, $4, $5, $6, false)""",
                [
                    category_id,
                    _j(rule["condition"]),
                    rule["action_type"],
                    rule["target_queue"],
                    rule["priority"],
                    r + 1,
                ],
            )
    return category_id_by_key


def seed_demo_case(db: Queryable, category_id_by_key: dict[str, str]) -> None:
    """The demo "order", which belongs to the first merchant only."""
    case = DEMO_CASE
    db.query(
        """insert into cases
       (id, merchant_id, customer_wa_id, category_id, subcategory_id, status, integration_tier)
     values ($1, $2, $3, $4,
             (select id from subcategories
                where category_id = $4 and key = $5), $6, $7)
     on conflict (id) do update
       set merchant_id = excluded.merchant_id, customer_wa_id = excluded.customer_wa_id,
           category_id = excluded.category_id, subcategory_id = excluded.subcategory_id,
           status = excluded.status, integration_tier = excluded.integration_tier""",
        [
            case["id"],
            MERCHANT_ID,
            case["customer_wa_id"],
            category_id_by_key[case["category_key"]],
            case["subcategory_key"],
            case["status"],
            case["integration_tier"],
        ],
    )
    for field_key, raw, normalized in case["fields"]:
        db.query(
            """insert into case_fields (case_id, field_key, raw_value, normalized_value)
       values ($1, $2, $3, $4)
       on conflict (case_id, field_key) do update
         set raw_value = excluded.raw_value, normalized_value = excluded.normalized_value""",
            [case["id"], field_key, raw, normalized],
        )
    # case_items are owned by the seed -> replace.
    db.query("delete from case_items where case_id = $1", [case["id"]])
    for item in case["items"]:
        db.query(
            """insert into case_items (case_id, line_item_id, title, variant, qty)
       values ($1, $2, $3, $4, $5)""",
            [
                case["id"],
                item["line_item_id"],
                item["title"],
                item["variant"],
                item["qty"],
            ],
        )


def seed_channels(db: Queryable) -> None:
    """Channels are owned by the seed: one number per merchant, replaced on re-run."""
    current = channels()
    # Drop numbers this seed no longer claims, so changing WHATSAPP_PHONE_NUMBER_ID
    # re-links the merchant instead of leaving the old number attached as well.
    db.query(
        """delete from whatsapp_channels
      where merchant_id = any($1) and phone_number_id <> all($2)""",
        [[c["merchant_id"] for c in current], [c["phone_number_id"] for c in current]],
    )
    for ch in current:
        db.query(
            """insert into whatsapp_channels
         (merchant_id, phone_number_id, waba_id, display_number, is_primary)
       values ($1, $2, $3, $4, true)
       on conflict (phone_number_id) do update
         set merchant_id = excluded.merchant_id,
             waba_id = excluded.waba_id,
             display_number = excluded.display_number""",
            [
                ch["merchant_id"],
                ch["phone_number_id"],
                ch["waba_id"],
                ch["display_number"],
            ],
        )


def seed(db: Queryable) -> None:
    category_id_by_key = seed_merchant(db, MERCHANT, TAXONOMY)
    seed_demo_case(db, category_id_by_key)
    # The second tenant exists so tenancy is exercised, not assumed: its
    # taxonomy shares no keys with the first merchant's.
    seed_merchant(db, SECOND_MERCHANT, SECOND_TAXONOMY)
    seed_channels(db)


def _count(taxonomy: list[dict[str, Any]], key: str) -> int:
    return sum(len(c[key]) for c in taxonomy)


def main() -> None:
    with psycopg.connect(
        os.environ.get("DATABASE_URL") or LOCAL_DEFAULT, autocommit=True
    ) as conn:
        configure_connection(conn)
        db = ConnectionDatabase(conn)
        with db.transaction():
            seed(db)
    out = sys.stdout
    out.write(
        f'[db:seed] Seeded "{MERCHANT["name"]}": {len(TAXONOMY)} categories, '
        f"{_count(TAXONOMY, 'subcategories')} subcategories, {_count(TAXONOMY, 'fields')} field defs, "
        f"{_count(TAXONOMY, 'rules')} routing rules, 1 demo order ({len(DEMO_CASE['items'])} line items).\n"
    )
    out.write(
        f'[db:seed] Seeded "{SECOND_MERCHANT["name"]}": {len(SECOND_TAXONOMY)} categories, '
        f"{_count(SECOND_TAXONOMY, 'subcategories')} subcategories, {_count(SECOND_TAXONOMY, 'fields')} field defs, "
        f"{_count(SECOND_TAXONOMY, 'rules')} routing rules.\n"
    )
    for ch in channels():
        out.write(
            f"[db:seed] phone_number_id {ch['phone_number_id']} -> {ch['display_number']}\n"
        )
    if not os.environ.get("WHATSAPP_PHONE_NUMBER_ID"):
        out.write(
            "[db:seed] WHATSAPP_PHONE_NUMBER_ID is not set, so the demo merchant is linked to a "
            "placeholder number. Real inbound messages will be dropped as an unknown number until "
            "you re-seed with credentials configured.\n"
        )


if __name__ == "__main__":
    main()
