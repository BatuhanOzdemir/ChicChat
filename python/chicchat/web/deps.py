"""Request-scoped helpers: database, signed-in account, current merchant."""

from __future__ import annotations

from fastapi import Request

from chicchat.db.auth import Principal, session_principal
from chicchat.db.client import PoolDatabase, get_database
from chicchat.domain.auth.gate import PASSCODE_COOKIE
from chicchat.server.env import development_access
from chicchat.server.merchant import MERCHANT_COOKIE, MerchantContext, merchant_context


def database() -> PoolDatabase:
    return get_database()


class LoginRequiredError(Exception):
    """Raised when a page needs an account; the app turns it into a redirect."""


def current_principal(request: Request) -> Principal | None:
    return session_principal(database(), request.cookies.get(PASSCODE_COOKIE))


def require_principal(request: Request) -> Principal | None:
    """The signed-in account; None only under the local-development bypass."""
    principal = current_principal(request)
    if principal is None and not development_access():
        raise LoginRequiredError
    return principal


def current_merchant(request: Request) -> MerchantContext | None:
    """Which merchant this page acts as, re-checked against membership."""
    return merchant_context(
        database(), require_principal(request), request.cookies.get(MERCHANT_COOKIE)
    )
