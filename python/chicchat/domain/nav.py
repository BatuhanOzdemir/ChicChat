"""The operator application's top-level sections (SPEC §§7–9) — port of nav.ts.

Every operator surface is reachable from every other one. Pure by design
(Handbook §2): the "which tab is highlighted" rule is a string question,
answerable without a router, a request, or a DOM.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class NavSection:
    href: str
    """Route the tab links to, and the prefix that marks it active."""
    label: str
    hint: str
    """Short "what is this for", shown as the link title."""
    simulator_only: bool = False
    """The simulator is absent in production unless explicitly enabled."""


NAV_SECTIONS: tuple[NavSection, ...] = (
    NavSection("/console", "Console", "Work queue: cases waiting for an agent"),
    NavSection("/cases", "Cases", "Every case, with filters and counters"),
    NavSection(
        "/config", "Configuration", "Categories, fields, policies and routing rules"
    ),
    NavSection(
        "/simulator",
        "Simulator",
        "Drive a WhatsApp conversation by hand",
        simulator_only=True,
    ),
)


def visible_sections(simulator_enabled: bool) -> list[NavSection]:
    """The tabs to render."""
    return [s for s in NAV_SECTIONS if not s.simulator_only or simulator_enabled]


def active_section(pathname: str) -> str | None:
    """Which section owns this path, or None on a page outside the sections.

    A detail page belongs to its section, so `/console/<id>` keeps the Console
    tab lit; the trailing slash keeps the match on a path boundary.
    """
    matches = sorted(
        (
            s.href
            for s in NAV_SECTIONS
            if pathname == s.href or pathname.startswith(f"{s.href}/")
        ),
        key=len,
        reverse=True,
    )
    return matches[0] if matches else None
