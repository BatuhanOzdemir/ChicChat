"""Stable operator-facing timestamps — port of cases/date.ts.

DD/MM/YYYY, 24-hour, Istanbul time, independent of server defaults (needs the
`tzdata` package where the system has no time-zone database, PORT.md P17).
"""

from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

from chicchat.domain.dates import as_datetime

_ISTANBUL = ZoneInfo("Europe/Istanbul")


def format_date_time(value: datetime | str) -> str:
    moment = as_datetime(value)
    if moment is None:
        return "—"
    return moment.astimezone(_ISTANBUL).strftime("%d/%m/%Y, %H:%M")
