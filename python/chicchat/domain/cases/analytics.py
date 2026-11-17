"""Analytics arithmetic (SPEC §8) — port of cases/analytics.ts.

Pure, so "median" and "abandonment rate" have one definition with tests,
instead of being buried in SQL.
"""

from __future__ import annotations

import math
from collections.abc import Sequence

from chicchat.domain.jscompat import js_round


def median(values: Sequence[float]) -> float | None:
    """Median of a numeric sample; None for an empty sample (never 0, which lies)."""
    if len(values) == 0:
        return None
    ordered = sorted(values)
    mid = len(ordered) // 2
    return (
        ordered[mid] if len(ordered) % 2 == 1 else (ordered[mid - 1] + ordered[mid]) / 2
    )


def abandonment_rate(completed: float, abandoned: float) -> float | None:
    """Share of intakes abandoned rather than finished, as a 0–1 fraction.

    None when nothing finished or abandoned yet — a rate over zero cases is
    meaningless, not zero.
    """
    total = completed + abandoned
    if total <= 0:
        return None
    return abandoned / total


def format_duration(seconds: float | None) -> str:
    """Seconds → a short human duration ("4m 12s"), for the console."""
    if seconds is None:
        return "—"
    whole = max(0, js_round(seconds))
    if whole < 60:
        return f"{whole}s"
    minutes = math.floor(whole / 60)
    if minutes < 60:
        return f"{minutes}m {whole % 60}s"
    hours = math.floor(minutes / 60)
    return f"{hours}h {minutes % 60}m"


def format_percent(fraction: float | None) -> str:
    return "—" if fraction is None else f"{js_round(fraction * 100)}%"
