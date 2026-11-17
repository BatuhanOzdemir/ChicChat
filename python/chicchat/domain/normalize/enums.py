"""Enum constraining (SPEC.md §2) — port of normalize/enums.ts.

Subcategory / reason / condition / etc. are constrained to the merchant's
configured values. Matching is case-insensitive by default and returns the
canonical allowed value (not the user's casing).
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from chicchat.domain.jscompat import js_trim


@dataclass(frozen=True)
class EnumResult:
    raw: str
    normalized: str | None
    """The matched canonical allowed value, or None when not allowed."""
    valid: bool


def constrain_enum(
    raw: str, allowed: Sequence[str], case_insensitive: bool = True
) -> EnumResult:
    trimmed = js_trim(raw)
    match = next(
        (
            value
            for value in allowed
            if (
                value.lower() == trimmed.lower()
                if case_insensitive
                else value == trimmed
            )
        ),
        None,
    )
    return EnumResult(raw=raw, normalized=match, valid=match is not None)
