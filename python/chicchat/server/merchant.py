"""Which merchant do the console pages act as? — port of server/merchant/current.ts.

The selection cookie is only a preference. Every request resolves current
account membership before selecting a tenant; a stale preference falls back to
the first authorized merchant. Reading the cookie is the web layer's job: it
passes the principal and the cookie value in.
"""

from __future__ import annotations

from dataclasses import dataclass

from chicchat.db.auth import Principal
from chicchat.db.config import list_merchants
from chicchat.db.database import Queryable

MERCHANT_COOKIE = "chicchat_merchant"


@dataclass(frozen=True)
class MerchantOption:
    id: str
    name: str
    locale: str
    rtl: bool


@dataclass(frozen=True)
class MerchantContext:
    current: MerchantOption
    """The merchant every query on this page is scoped to."""
    options: list[MerchantOption]
    """Everything available to switch to."""


def merchant_context(
    db: Queryable, principal: Principal | None, selected: str | None
) -> MerchantContext | None:
    """None when the current account has no available merchants.

    `principal` is None only under the local-development bypass, which sees
    every merchant.
    """
    options = [
        MerchantOption(m["id"], m["name"], m["locale"], m["rtl"])
        for m in list_merchants(db)
        if principal is None or m["id"] in principal.merchant_ids
    ]
    if not options:
        return None
    current = next((m for m in options if m.id == selected), options[0])
    return MerchantContext(current=current, options=options)
