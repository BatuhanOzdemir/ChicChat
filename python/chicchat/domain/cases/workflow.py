"""Case lifecycle rules for the agent console (SPEC §9) — port of
cases/workflow.ts.

The allowed status transitions live here rather than in the UI or the query
layer, so "can this case be resolved?" has exactly one answer that a unit test
can pin down. Nothing raises: an illegal transition comes back as a result the
caller can show to the agent (Handbook §3).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Literal

from chicchat.domain.dates import as_datetime, millis_between
from chicchat.domain.jscompat import js_length, js_trim
from chicchat.domain.result import Err, Ok, Result

CaseStatus = Literal[
    "open",
    "in_progress",
    "needs_info",
    "handed_off",
    "escalated",
    "resolved",
    "closed",
    "abandoned",
]
CASE_STATUSES: tuple[CaseStatus, ...] = (
    "open",
    "in_progress",
    "needs_info",
    "handed_off",
    "escalated",
    "resolved",
    "closed",
    "abandoned",
)

UNRESOLVED_STATUSES: tuple[CaseStatus, ...] = (
    "open",
    "in_progress",
    "needs_info",
    "handed_off",
    "escalated",
)
"""Statuses that still need someone to act — the default queue view."""

TERMINAL_STATUSES: tuple[CaseStatus, ...] = ("resolved", "closed")
"""Reaching one of these stops the clock (`cases.resolved_at`)."""

Priority = Literal["high", "normal", "low"]
PRIORITIES: tuple[Priority, ...] = ("high", "normal", "low")

# Who may go where. The spine is open → in_progress → resolved → closed
# (SPEC §9); the rest are the real detours: an agent needs more information,
# hands off, escalates, or reopens something that was closed too eagerly. An
# abandoned intake can be picked up, because the captured fields survive
# (SPEC §11).
_TRANSITIONS: dict[str, tuple[CaseStatus, ...]] = {
    "open": ("in_progress", "needs_info", "handed_off", "escalated", "resolved"),
    "in_progress": ("needs_info", "handed_off", "escalated", "resolved", "open"),
    "needs_info": ("in_progress", "escalated", "resolved", "open"),
    "handed_off": ("in_progress", "escalated", "resolved"),
    "escalated": ("in_progress", "resolved"),
    "resolved": ("closed", "in_progress"),
    "closed": ("in_progress",),
    "abandoned": ("in_progress", "closed"),
}


def is_case_status(value: str) -> bool:
    return value in CASE_STATUSES


def is_priority(value: str) -> bool:
    return value in PRIORITIES


def constrain_priority(value: str | None) -> Priority:
    """Unknown priorities degrade to `normal` rather than failing a case (SPEC §2)."""
    trimmed = js_trim(value or "").lower()
    for priority in PRIORITIES:
        if trimmed == priority:
            return priority
    return "normal"


def priority_rank(priority: str) -> int:
    """High first, then normal, then low — the queue's sort key (-1 if unknown)."""
    return PRIORITIES.index(priority) if priority in PRIORITIES else -1


def next_statuses(from_status: str) -> tuple[CaseStatus, ...]:
    """The statuses an agent may move this case to right now."""
    return _TRANSITIONS.get(from_status, ())


def can_transition(from_status: str, to_status: str) -> bool:
    return to_status in next_statuses(from_status)


def is_terminal(status: str) -> bool:
    return status in TERMINAL_STATUSES


@dataclass(frozen=True)
class Transition:
    from_status: CaseStatus
    to_status: CaseStatus
    terminal: bool


def plan_transition(from_status: str, to_status: str) -> Result[Transition]:
    """Validate a requested transition, including the raw (untrusted) target."""
    if not is_case_status(from_status):
        return Err(f'case has an unknown status "{from_status}"')
    if not is_case_status(to_status):
        return Err(f'unknown status "{to_status}"')
    if from_status == to_status:
        return Err(f"case is already {to_status}")
    if not can_transition(from_status, to_status):
        allowed = ", ".join(next_statuses(from_status)) or "none"
        return Err(
            f"cannot move a {from_status} case to {to_status} (allowed: {allowed})"
        )
    return Ok(
        Transition(
            from_status=from_status,  # type: ignore[arg-type]
            to_status=to_status,  # type: ignore[arg-type]
            terminal=is_terminal(to_status),
        )
    )


NOTE_MAX_LENGTH = 2000


def parse_note(raw: str) -> Result[str]:
    """Internal notes are agent-authored text: trimmed, non-empty, bounded."""
    body = js_trim(raw)
    if body == "":
        return Err("a note cannot be empty")
    if js_length(body) > NOTE_MAX_LENGTH:
        return Err(f"a note cannot exceed {NOTE_MAX_LENGTH} characters")
    return Ok(body)


def age_label(created_at: datetime | str, now: datetime) -> str:
    """How long a case has been waiting, for the queue's age column."""
    created = as_datetime(created_at)
    if created is None:
        return "—"
    minutes = millis_between(now, created) // 60_000
    if minutes < 1:
        return "just now"
    if minutes < 60:
        return f"{minutes}m"
    hours = minutes // 60
    if hours < 48:
        return f"{hours}h"
    return f"{hours // 24}d"
