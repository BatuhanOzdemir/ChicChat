"""Session inactivity decisions (SPEC §11) — port of intake/inactivity.ts.

Pure, so the thresholds are testable without a clock or a database. The product
rule this encodes: WhatsApp is asynchronous, so partial progress is NEVER
discarded early. A quiet session gets exactly one gentle nudge, and only after
the (much longer) abandon horizon is it closed — and even then, a session that
captured anything becomes an `abandoned` case rather than vanishing.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Literal

from chicchat.domain.dates import millis_between

SessionLifecycle = Literal["active", "nudged", "errored"]
InactivityAction = Literal["none", "nudge", "abandon"]

_MINUTE = 60_000
_HOUR = 60 * _MINUTE


@dataclass(frozen=True)
class InactivityThresholds:
    nudge_after_minutes: float
    abandon_after_hours: float


@dataclass(frozen=True)
class SessionTiming:
    status: str
    updated_at: datetime
    """Last customer activity."""
    nudged_at: datetime | None = None


def inactivity_action(
    timing: SessionTiming, thresholds: InactivityThresholds, now: datetime
) -> InactivityAction:
    """What maintenance should do with this session right now.

    Abandonment is checked first so a long-quiet session is closed rather than
    nudged again.
    """
    idle = millis_between(now, timing.updated_at)
    if idle >= thresholds.abandon_after_hours * _HOUR:
        return "abandon"
    # One nudge per session: only sessions still in `active` qualify. An
    # `errored` session is a merchant-console concern, not a nudge target.
    if (
        timing.status == "active"
        and timing.nudged_at is None
        and idle >= thresholds.nudge_after_minutes * _MINUTE
    ):
        return "nudge"
    return "none"
