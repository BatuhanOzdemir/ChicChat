"""Port of normalize/*.test.ts, plus golden comparison with the TypeScript."""

from __future__ import annotations

import re
from dataclasses import asdict
from typing import Any

from chicchat.domain.normalize import (
    constrain_enum,
    normalize_order_number,
    normalize_text,
)
from tests.golden import assert_golden

REASONS = ("damaged", "defective", "wrong_item")

# --- normalizeOrderNumber -------------------------------------------------


def test_strips_spaces_and_separators_from_a_messy_id() -> None:
    r = normalize_order_number("  12/3 4-5 ")
    assert r.normalized == "12345"
    assert r.valid is True


def test_strips_hash_and_leading_zeros() -> None:
    r = normalize_order_number("#00420")
    assert r.normalized == "420"
    assert r.valid is True


def test_uppercases_and_strips_hash_and_dash_spec_demo() -> None:
    assert normalize_order_number("#tr-100 432").normalized == "TR100432"


def test_keeps_a_single_0_for_an_all_zero_id() -> None:
    assert normalize_order_number("#0000").normalized == "0"


def test_can_keep_leading_zeros_when_configured() -> None:
    assert (
        normalize_order_number("#00420", strip_leading_zeros=False).normalized
        == "00420"
    )


def test_validates_the_normalized_value_against_a_merchant_regex() -> None:
    pattern = "^[A-Z0-9]{4,}$"
    assert normalize_order_number("tr-100 432", pattern=pattern).valid is True
    # too short after normalization -> invalid id
    assert normalize_order_number("#00420", pattern=pattern).valid is False


def test_treats_empty_noise_only_input_as_invalid() -> None:
    r = normalize_order_number("  ## // ")
    assert r.normalized == ""
    assert r.valid is False


def test_accepts_a_compiled_pattern() -> None:
    pattern = re.compile(r"^[A-Z]{2}[0-9]{2}\Z")
    assert normalize_order_number("AB12", pattern=pattern).valid is True
    assert normalize_order_number("ABC", pattern=pattern).valid is False


# --- constrainEnum ----------------------------------------------------------


def test_matches_case_insensitively_and_returns_the_canonical_value() -> None:
    r = constrain_enum("Damaged", REASONS)
    assert r.normalized == "damaged"
    assert r.valid is True


def test_trims_surrounding_whitespace() -> None:
    assert constrain_enum("  defective  ", REASONS).normalized == "defective"


def test_rejects_a_value_outside_the_allowed_set() -> None:
    r = constrain_enum("blue", REASONS)
    assert r.normalized is None
    assert r.valid is False


def test_can_require_an_exact_case_sensitive_match() -> None:
    assert constrain_enum("Damaged", REASONS, case_insensitive=False).valid is False


# --- normalizeText ------------------------------------------------------------


def test_trims_and_collapses_internal_whitespace() -> None:
    assert normalize_text("  it   arrived\tbroken \n") == "it arrived broken"


def test_leaves_clean_text_unchanged() -> None:
    assert normalize_text("size 32 too tight") == "size 32 too tight"


# --- golden -----------------------------------------------------------------


def _order(raw: str, options: dict[str, Any]) -> dict[str, Any]:
    return asdict(
        normalize_order_number(
            raw,
            pattern=options.get("pattern"),
            strip_leading_zeros=options.get("stripLeadingZeros", True),
        )
    )


def _enum(raw: str, allowed: list[str], options: dict[str, Any]) -> dict[str, Any]:
    return asdict(
        constrain_enum(
            raw, allowed, case_insensitive=options.get("caseInsensitive", True)
        )
    )


def test_matches_the_typescript_implementation() -> None:
    assert (
        assert_golden(
            "normalize",
            {
                "normalizeText": normalize_text,
                "normalizeOrderNumber": _order,
                "constrainEnum": _enum,
            },
        )
        > 500
    )
