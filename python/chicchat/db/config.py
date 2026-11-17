"""Merchant configuration data layer — port of db/config.ts.

Reads the merchant-editable taxonomy and settings and bridges the database into
the intake machine's `IntakeConfig`, so config edits visibly change what the
machine asks for.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, cast

from chicchat.db.database import Queryable
from chicchat.domain.intake.types import CategoryDef, FieldDef, IntakeConfig

DEMO_MERCHANT_ID = "00000000-0000-0000-0000-000000000001"
"""The seed's demo merchant. A fixture id, not a runtime default: the app
resolves its tenant from the inbound `phone_number_id` or the console's
merchant switcher."""


@dataclass(frozen=True)
class EditableField:
    id: str
    key: str
    label: str | None
    type: str
    required: bool
    enum_values: list[str] | None
    normalize_rule: str | None
    sort_order: int


@dataclass(frozen=True)
class Subcategory:
    id: str
    key: str
    label: str


@dataclass(frozen=True)
class EditableCategory:
    id: str
    key: str
    label: str
    enabled: bool
    sort_order: int
    subcategories: list[Subcategory] = field(default_factory=list)
    fields: list[EditableField] = field(default_factory=list)


@dataclass(frozen=True)
class Merchant:
    id: str
    name: str
    locale: str
    rtl: bool
    currency: str


@dataclass(frozen=True)
class EditableMerchantConfig:
    merchant: Merchant
    settings: dict[str, Any]
    """return_window_days, refund_sla_days, auto_approve_threshold,
    order_id_regex, nudge_after_minutes, abandon_after_hours, kvkk_url,
    retention_months — a dict because routing rules reference it by key."""
    categories: list[EditableCategory]


def _js_number(value: object) -> int | float:
    """`Number(numeric)`: node-pg returned numerics as strings; JS has one number type."""
    number = float(cast(Decimal, value))
    return int(number) if number.is_integer() else number


def list_merchants(db: Queryable) -> list[dict[str, Any]]:
    """Merchants available to pick from (simulator selector, SPEC §7)."""
    return db.query("select id, name, locale, rtl from merchants order by name")


def _or(value: object, fallback: object) -> Any:
    return fallback if value is None else value


def load_merchant_config(
    db: Queryable, merchant_id: str
) -> EditableMerchantConfig | None:
    """The full editable config for a merchant (all categories, enabled or not).

    Exactly four queries regardless of taxonomy size — subcategories and field
    defs are fetched for the whole merchant and grouped in memory, because this
    runs on every inbound message (SPEC §10).
    """
    merchant_rows = db.query(
        """select m.id, m.name, m.locale, m.rtl, m.currency,
            c.return_window_days, c.refund_sla_days, c.auto_approve_threshold,
            c.order_id_regex, c.nudge_after_minutes, c.abandon_after_hours,
            c.kvkk_url, c.retention_months
       from merchants m
       left join merchant_config c on c.merchant_id = m.id
      where m.id = $1""",
        [merchant_id],
    )
    if not merchant_rows:
        return None
    row = merchant_rows[0]
    merchant = Merchant(
        row["id"], row["name"], row["locale"], row["rtl"], row["currency"]
    )
    settings: dict[str, Any] = {
        "return_window_days": _or(row["return_window_days"], 30),
        "refund_sla_days": _or(row["refund_sla_days"], 14),
        "auto_approve_threshold": _js_number(_or(row["auto_approve_threshold"], 0)),
        "order_id_regex": row["order_id_regex"],
        "nudge_after_minutes": _or(row["nudge_after_minutes"], 5),
        "abandon_after_hours": _or(row["abandon_after_hours"], 24),
        "kvkk_url": row["kvkk_url"],
        "retention_months": _or(row["retention_months"], 12),
    }

    cat_rows = db.query(
        """select id, key, label, enabled, sort_order
       from categories where merchant_id = $1 order by sort_order, key""",
        [merchant_id],
    )
    sub_rows = db.query(
        """select sc.category_id, sc.id, sc.key, sc.label
       from subcategories sc
       join categories c on c.id = sc.category_id
      where c.merchant_id = $1
      order by sc.sort_order, sc.key""",
        [merchant_id],
    )
    field_rows = db.query(
        """select fd.category_id, fd.id, fd.key, fd.label, fd.type, fd.required,
            fd.enum_values, fd.normalize_rule, fd.sort_order
       from field_defs fd
       join categories c on c.id = fd.category_id
      where c.merchant_id = $1
      order by fd.sort_order, fd.key""",
        [merchant_id],
    )

    subs_by_category: dict[str, list[Subcategory]] = {}
    for s in sub_rows:
        subs_by_category.setdefault(s["category_id"], []).append(
            Subcategory(s["id"], s["key"], s["label"])
        )
    fields_by_category: dict[str, list[EditableField]] = {}
    for f in field_rows:
        fields_by_category.setdefault(f["category_id"], []).append(
            EditableField(
                id=f["id"],
                key=f["key"],
                label=f["label"],
                type=f["type"],
                required=f["required"],
                enum_values=f["enum_values"],
                normalize_rule=f["normalize_rule"],
                sort_order=f["sort_order"],
            )
        )
    categories = [
        EditableCategory(
            id=c["id"],
            key=c["key"],
            label=c["label"],
            enabled=c["enabled"],
            sort_order=c["sort_order"],
            subcategories=subs_by_category.get(c["id"], []),
            fields=fields_by_category.get(c["id"], []),
        )
        for c in cat_rows
    ]
    return EditableMerchantConfig(merchant, settings, categories)


def _field_def(f: EditableField) -> FieldDef:
    out: dict[str, Any] = {"key": f.key}
    if f.label is not None:  # `label ?? undefined`: absent, not null
        out["label"] = f.label
    out.update(
        type=f.type,
        required=f.required,
        enumValues=f.enum_values,
        normalizeRule=f.normalize_rule,
    )
    return cast(FieldDef, out)


def to_intake_config(config: EditableMerchantConfig) -> IntakeConfig:
    """The intake machine's view of an already-loaded config — enabled
    categories only."""
    out: dict[str, Any] = {}
    if config.settings.get("order_id_regex") is not None:
        out["orderIdRegex"] = config.settings["order_id_regex"]
    if config.settings.get("kvkk_url") is not None:
        out["kvkkUrl"] = config.settings["kvkk_url"]
    out["categories"] = [
        cast(
            CategoryDef,
            {
                "key": c.key,
                "label": c.label,
                "subcategories": [
                    {"key": s.key, "label": s.label} for s in c.subcategories
                ],
                "fields": [_field_def(f) for f in c.fields],
            },
        )
        for c in config.categories
        if c.enabled
    ]
    return cast(IntakeConfig, out)


def build_intake_config(db: Queryable, merchant_id: str) -> IntakeConfig:
    """Load the merchant config and reduce it to the intake machine's view."""
    config = load_merchant_config(db, merchant_id)
    if config is None:
        raise LookupError(f"merchant not found: {merchant_id}")
    return to_intake_config(config)


# --- Mutations (single-column edits used by older config UI and tests) ------


def update_merchant_settings(
    db: Queryable, merchant_id: str, return_window_days: int, refund_sla_days: int
) -> None:
    db.query(
        """update merchant_config
        set return_window_days = $2, refund_sla_days = $3
      where merchant_id = $1""",
        [merchant_id, return_window_days, refund_sla_days],
    )


def set_category_enabled(db: Queryable, category_id: str, enabled: bool) -> None:
    db.query("update categories set enabled = $2 where id = $1", [category_id, enabled])


def update_category_label(db: Queryable, category_id: str, label: str) -> None:
    db.query("update categories set label = $2 where id = $1", [category_id, label])


def set_field_required(db: Queryable, field_def_id: str, required: bool) -> None:
    db.query(
        "update field_defs set required = $2 where id = $1", [field_def_id, required]
    )
