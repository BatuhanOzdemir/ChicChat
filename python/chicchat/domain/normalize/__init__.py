"""The normalization layer (SPEC.md §2) — core product IP, framework-free and
unit-testable. Runs on every captured field so the agent never re-cleans.
"""

from chicchat.domain.normalize.enums import EnumResult, constrain_enum
from chicchat.domain.normalize.order_number import (
    OrderNumberResult,
    normalize_order_number,
)
from chicchat.domain.normalize.text import normalize_text

__all__ = [
    "EnumResult",
    "OrderNumberResult",
    "constrain_enum",
    "normalize_order_number",
    "normalize_text",
]
