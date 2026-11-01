"""Form protection and session cookies for the web layer (PORT.md P1, P4, P5).

Next.js server actions checked the request origin automatically; plain HTML
forms do not. Every state-changing request (except the two endpoints that
authenticate themselves) must therefore carry the per-browser CSRF token —
as a hidden form field, or as the `X-CSRF-Token` header from the simulator's
script — and, when the browser sends an Origin header, come from this site.
"""

from __future__ import annotations

import secrets
from urllib.parse import urlsplit

from fastapi import HTTPException, Request, Response

from chicchat.domain.auth.gate import constant_time_equal
from chicchat.server.env import is_production

CSRF_COOKIE = "chicchat_csrf"
CSRF_FIELD = "csrf_token"
CSRF_HEADER = "x-csrf-token"

# These authenticate themselves (Meta signature, bearer secret) and are called
# by machines that have no browser session or CSRF cookie.
CSRF_EXEMPT = ("/api/whatsapp/webhook", "/api/maintenance/sessions")


def csrf_token(request: Request) -> str:
    """The token for this browser: the cookie value, or a fresh one the
    middleware will set on the response."""
    token = getattr(request.state, "csrf_token", None)
    if isinstance(token, str):
        return token
    existing = request.cookies.get(CSRF_COOKIE)
    token = existing if existing and len(existing) == 64 else secrets.token_hex(32)
    request.state.csrf_token = token
    return token


def _same_origin(request: Request) -> bool:
    origin = request.headers.get("origin")
    if origin is None or origin == "null":
        # Browsers send Origin on cross-site POSTs; absent means same-site
        # navigation or a non-browser client, which the token still covers.
        return origin is None
    parts = urlsplit(origin)
    host = request.headers.get("host", "")
    return parts.netloc == host


async def verify_csrf(request: Request) -> None:
    """FastAPI dependency for every state-changing route."""
    if request.method in ("GET", "HEAD", "OPTIONS") or request.url.path in CSRF_EXEMPT:
        return
    if not _same_origin(request):
        raise HTTPException(status_code=403, detail="cross-site request refused")
    expected = request.cookies.get(CSRF_COOKIE) or ""
    provided = request.headers.get(CSRF_HEADER)
    if provided is None:
        content_type = request.headers.get("content-type", "")
        if "form" in content_type:
            form = await request.form()
            value = form.get(CSRF_FIELD)
            provided = value if isinstance(value, str) else None
    if not expected or not provided or not constant_time_equal(expected, provided):
        raise HTTPException(status_code=403, detail="missing or invalid form token")


def set_private_cookie(response: Response, name: str, value: str, max_age: int) -> None:
    """httpOnly, SameSite=Lax, Secure in production — as the TypeScript set them."""
    response.set_cookie(
        name,
        value,
        max_age=max_age,
        path="/",
        httponly=True,
        samesite="lax",
        secure=is_production(),
    )
