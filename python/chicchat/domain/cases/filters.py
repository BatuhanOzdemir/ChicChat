"""Case-list filter parsing (SPEC §8) — port of cases/filters.ts.

Filters come from a URL query string, i.e. entirely user-controlled input
(Handbook §5). Anything unrecognised is rejected rather than silently ignored,
so a typo shows up as a message instead of a surprising result set.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from chicchat.domain.cases.workflow import CASE_STATUSES, CaseStatus, is_case_status
from chicchat.domain.jscompat import is_js_integer, js_number, js_trim
from chicchat.domain.normalize import normalize_order_number
from chicchat.domain.result import Err, Ok, Result

__all__ = ["CASE_STATUSES", "UNROUTED_QUEUE", "CaseFilters", "parse_case_filters"]

UNROUTED_QUEUE = "unrouted"
"""`?queue=unrouted` selects the cases no rule routed (SPEC §9)."""


@dataclass(frozen=True)
class CaseFilters:
    status: CaseStatus | None
    category_key: str | None
    queue: str | None
    """Queue name, or `UNROUTED_QUEUE` for "no queue"."""
    from_date: str | None
    """Inclusive date bounds (YYYY-MM-DD), interpreted by the query as UTC days."""
    to_date: str | None
    order_number: str | None
    """Normalized, so searching "#tr-100 432" finds the stored TR100432."""
    page: int


_DATE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")

Params = Mapping[str, str | Sequence[str] | None]


def _pick(params: Params, name: str) -> str:
    raw = params.get(name)
    value = raw if isinstance(raw, str) or raw is None else (raw[0] if raw else None)
    return js_trim(value or "")


def parse_case_filters(params: Params) -> Result[CaseFilters]:
    status = _pick(params, "status")
    if status != "" and not is_case_status(status):
        return Err(f'unknown status "{status}"')

    for name in ("from", "to"):
        value = _pick(params, name)
        if value != "" and not _DATE.fullmatch(value):
            return Err(f"{name} must be a date (YYYY-MM-DD)")
    from_date = _pick(params, "from")
    to_date = _pick(params, "to")
    if from_date != "" and to_date != "" and from_date > to_date:
        return Err("from must not be after to")

    raw_order = _pick(params, "order_number")
    # Search by the normalized form, since that is what was stored.
    order_number = (
        None if raw_order == "" else normalize_order_number(raw_order).normalized
    )

    raw_page = _pick(params, "page")
    page = 1.0 if raw_page == "" else js_number(raw_page)
    if not is_js_integer(page) or page < 1:
        return Err("page must be a positive whole number")

    category_key = _pick(params, "category")
    queue = _pick(params, "queue")
    return Ok(
        CaseFilters(
            status=None if status == "" else status,  # type: ignore[arg-type]
            category_key=None if category_key == "" else category_key,
            queue=None if queue == "" else queue,
            from_date=None if from_date == "" else from_date,
            to_date=None if to_date == "" else to_date,
            order_number=None if order_number in (None, "") else order_number,
            page=int(page),
        )
    )
