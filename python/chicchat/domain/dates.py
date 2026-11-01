"""JavaScript-compatible date handling (docs/PORT.md §6 P12, P17).

The TypeScript code parsed timestamps with `new Date(text)` and serialized them
with `toISOString()`. Every timestamp that reaches these call sites comes from
PostgreSQL, so `parse_js_date` reproduces V8 for ISO-8601 forms (including its
day overflow, `2026-02-30` → 2 March, and `24:00`) and returns None for
anything else. V8's legacy formats (`June 22, 2026`, `12/31/2026`) are
deliberately not supported — see PORT.md §9.

A timestamp without an offset is read as UTC, the deployed server's zone.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta

_ISO = re.compile(
    r"(?P<year>[+-][0-9]{6}|[0-9]{4})"
    r"(?:-(?P<month>[0-9]{1,2})(?:-(?P<day>[0-9]{1,2}))?)?"
    r"(?:[T ](?P<hour>[0-9]{2}):(?P<minute>[0-9]{2})"
    r"(?::(?P<second>[0-9]{2})(?:\.(?P<fraction>[0-9]+))?)?)?"
    r"(?P<zone>Z|[+-][0-9]{2}:?[0-9]{2})?",
    re.ASCII,
)


def parse_js_date(text: str) -> datetime | None:
    """`new Date(text)` for ISO timestamps; None where V8 gives Invalid Date."""
    match = _ISO.fullmatch(text.strip())
    if not match:
        return None
    parts = match.groupdict()
    year = int(parts["year"])
    month = int(parts["month"] or 1)
    day = int(parts["day"] or 1)
    hour = int(parts["hour"] or 0)
    minute = int(parts["minute"] or 0)
    second = int(parts["second"] or 0)
    millis = int((parts["fraction"] or "0")[:3].ljust(3, "0"))
    if not (1 <= month <= 12 and 1 <= day <= 31 and minute <= 59 and second <= 59):
        return None
    if hour > 24 or (hour == 24 and (minute or second or millis)):
        return None
    try:
        base = datetime(year, month, 1, tzinfo=UTC)
    except ValueError:
        return None
    moment = base + timedelta(
        days=day - 1, hours=hour, minutes=minute, seconds=second, milliseconds=millis
    )
    zone = parts["zone"]
    if zone and zone != "Z":
        sign = 1 if zone[0] == "+" else -1
        digits = zone[1:].replace(":", "")
        moment -= sign * timedelta(hours=int(digits[:2]), minutes=int(digits[2:]))
    return moment


def to_js_iso(moment: datetime) -> str:
    """`Date.prototype.toISOString`: UTC, milliseconds, trailing `Z`."""
    utc = moment.astimezone(UTC)
    return utc.strftime("%Y-%m-%dT%H:%M:%S.") + f"{utc.microsecond // 1000:03d}Z"


def as_datetime(value: datetime | str) -> datetime | None:
    """A database timestamp (datetime) or its text form, as an aware datetime."""
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=UTC)
    return parse_js_date(value)


def millis_between(later: datetime, earlier: datetime) -> int:
    """`later.getTime() - earlier.getTime()`: whole milliseconds."""
    delta = later - earlier
    return (delta.days * 86_400 + delta.seconds) * 1000 + delta.microseconds // 1000
