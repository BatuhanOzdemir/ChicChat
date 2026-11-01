"""Order-number normalization (SPEC.md §2) — port of normalize/order-number.ts.

Runs the moment an order number is captured so agents never clean it and the
bot never re-asks. Strips separators/noise (spaces, `/`, `#`, `-`, ...),
uppercases, optionally strips leading zeros, and validates the result against
the merchant's configurable order-id regex.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from chicchat.domain.jscompat import js_regex, js_test

_NOT_ALNUM = re.compile(r"[^A-Z0-9]")


@dataclass(frozen=True)
class OrderNumberResult:
    raw: str
    """The original input, untouched."""
    normalized: str
    """Cleaned, uppercased (and optionally zero-stripped) order number."""
    valid: bool
    """True when normalized is non-empty and matches `pattern` (if provided)."""


def _compile(pattern: str | re.Pattern[str]) -> re.Pattern[str]:
    return js_regex(pattern) if isinstance(pattern, str) else pattern


def normalize_order_number(
    raw: str,
    pattern: str | re.Pattern[str] | None = None,
    strip_leading_zeros: bool = True,
) -> OrderNumberResult:
    """`pattern` is the merchant's `order_id_regex` in JavaScript syntax (a
    string), or an already-compiled pattern. Raises `JsRegexError` for an
    invalid string pattern, as `new RegExp` threw in TypeScript.
    """
    # Uppercase, then drop everything that isn't A–Z / 0–9 (spaces, /, #, -, …).
    normalized = _NOT_ALNUM.sub("", raw.upper())

    if strip_leading_zeros and len(normalized) > 0:
        stripped = normalized.lstrip("0")
        # Keep a single "0" if the id was all zeros.
        normalized = stripped if len(stripped) > 0 else "0"

    # The pattern is only compiled once there is something to test, exactly as
    # `normalized.length > 0 && (pattern ? new RegExp(pattern).test(...) : true)`
    # short-circuits in TypeScript: an empty input never throws.
    valid = len(normalized) > 0 and (
        js_test(_compile(pattern), normalized) if pattern else True
    )
    return OrderNumberResult(raw=raw, normalized=normalized, valid=valid)
