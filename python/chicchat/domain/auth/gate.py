"""Who may reach the console in a deployed instance — port of auth/gate.ts.

Pure, so the rules are unit-testable and the middleware stays a thin adapter.
The caller verifies an opaque session token against the database. Production
always requires authentication; pages and actions additionally check tenant
membership. The historical cookie name is retained, but shared secrets are
invalid.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

PASSCODE_COOKIE = "chicchat_console"

MIN_PASSCODE_LENGTH = 12
"""The minimum that is worth calling a secret."""

# Paths that must never be gated:
#  - the WhatsApp webhook, which Meta calls and which verifies its own
#    signature (SPEC §10) — gating it would break every conversation;
#  - the maintenance job, which carries its own bearer secret;
#  - the login page and its assets, or there would be no way in.
_OPEN_PREFIXES = (
    "/api/whatsapp/webhook",
    "/api/maintenance/sessions",
    # Reachable by uptime monitors; reports no configuration detail.
    "/api/health",
    "/login",
    "/_next/",
    "/static/",
    "/favicon",
)


def is_open_path(pathname: str) -> bool:
    return any(
        pathname == prefix or (prefix.endswith("/") and pathname.startswith(prefix))
        for prefix in _OPEN_PREFIXES
    )


def constant_time_equal(a: str, b: str) -> bool:
    """Compare without leaking which character differed."""
    import hmac

    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


@dataclass(frozen=True)
class GateDecision:
    kind: Literal["allow", "login", "unavailable"]
    next: str | None = None
    """For `login`: where to return afterwards."""
    reason: str | None = None
    """For `unavailable`: why the deployment refuses outright."""


def gate_decision(
    pathname: str,
    authenticated: bool,
    is_production: bool,
    allow_development_access: bool = False,
) -> GateDecision:
    """`authenticated`: the server verified a live session and enabled account.
    `allow_development_access`: explicit local-development bypass, ignored in
    production."""
    if is_open_path(pathname):
        return GateDecision("allow")
    if authenticated or (not is_production and allow_development_access):
        return GateDecision("allow")
    return GateDecision("login", next=pathname)


_SAFE_NEXT = re.compile(r"/(?!/)[A-Za-z0-9_\-/\[\]?=&%.]*")


def safe_next_path(raw: str | None) -> str:
    """Where to send someone after login: same-site paths only."""
    value = raw or ""
    return value if _SAFE_NEXT.fullmatch(value) else "/cases"
