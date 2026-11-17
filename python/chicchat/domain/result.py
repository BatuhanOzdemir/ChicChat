"""Discriminated results (Handbook §3) — the Python form of TypeScript's
`{ ok: true; value } | { ok: false; error }`.

Expected failures (bad form input, illegal transitions) are returned, never
raised, so callers handle them deliberately.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class Ok[T]:
    value: T
    ok: Literal[True] = True


@dataclass(frozen=True)
class Err:
    error: str
    ok: Literal[False] = False


type Result[T] = Ok[T] | Err
