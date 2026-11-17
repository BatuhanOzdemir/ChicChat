"""Port of db/config.integration.test.ts: merchant-config edits persist AND
visibly change what the intake machine asks for."""

from __future__ import annotations

from chicchat.db.config import (
    DEMO_MERCHANT_ID,
    build_intake_config,
    load_merchant_config,
    set_category_enabled,
    set_field_required,
    update_merchant_settings,
)
from chicchat.db.database import ConnectionDatabase
from chicchat.domain.intake import SimulationScript, simulate_intake


def asked_fields_for(db: ConnectionDatabase, category: str) -> list[str]:
    """Which fields the intake asks for a given category, given the current config."""
    config = build_intake_config(db, DEMO_MERCHANT_ID)
    cat = next((c for c in config["categories"] if c["key"] == category), None)
    if cat is None:
        return []
    answers = {
        f["key"]: "wamid.x" if f["type"] == "media" else "value" for f in cat["fields"]
    }
    subcategory = cat["subcategories"][0]["key"] if cat["subcategories"] else None
    return simulate_intake(
        config,
        SimulationScript(category=category, subcategory=subcategory, fields=answers),
    ).asked


def category_keys(db: ConnectionDatabase) -> list[str]:
    return [c["key"] for c in build_intake_config(db, DEMO_MERCHANT_ID)["categories"]]


def test_drops_photo_from_what_wrong_damaged_intake_asks(
    db: ConnectionDatabase,
) -> None:
    assert "photo" in asked_fields_for(db, "wrong_damaged_missing")
    config = load_merchant_config(db, DEMO_MERCHANT_ID)
    assert config is not None
    cat = next(c for c in config.categories if c.key == "wrong_damaged_missing")
    photo = next(f for f in cat.fields if f.key == "photo")
    set_field_required(db, photo.id, False)
    assert "photo" not in asked_fields_for(db, "wrong_damaged_missing")


def test_hides_return_once_disabled(db: ConnectionDatabase) -> None:
    assert "return" in category_keys(db)
    config = load_merchant_config(db, DEMO_MERCHANT_ID)
    assert config is not None
    ret = next(c for c in config.categories if c.key == "return")
    set_category_enabled(db, ret.id, False)
    assert "return" not in category_keys(db)


def test_updates_return_window_and_refund_sla(db: ConnectionDatabase) -> None:
    update_merchant_settings(
        db, DEMO_MERCHANT_ID, return_window_days=45, refund_sla_days=21
    )
    config = load_merchant_config(db, DEMO_MERCHANT_ID)
    assert config is not None
    assert config.settings["return_window_days"] == 45
    assert config.settings["refund_sla_days"] == 21
