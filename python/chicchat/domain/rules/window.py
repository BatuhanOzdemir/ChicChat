"""Computed field `within_return_window` (SPEC.md §2) — port of rules/window.ts.

order_date + merchant.return_window_days vs now. Pure; the result is fed into
the rule context as a field that routing rules can reference.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from chicchat.domain.dates import parse_js_date


def is_within_return_window(
    order_date: datetime | str, return_window_days: int, now: datetime
) -> bool:
    """The deadline adds calendar days in UTC (the deployed server's zone)."""
    start = parse_js_date(order_date) if isinstance(order_date, str) else order_date
    if start is None:
        return False
    deadline = start.astimezone(UTC) + timedelta(days=return_window_days)
    return now <= deadline
