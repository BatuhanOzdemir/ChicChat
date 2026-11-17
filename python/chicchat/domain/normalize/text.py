"""Free-text normalization (SPEC.md §2) — port of normalize/text.ts.

For fields like `description` / `question`: trim and collapse internal
whitespace so the captured value is clean for the agent handoff.
"""

from __future__ import annotations

import re

from chicchat.domain.jscompat import JS_WS, js_trim

_RUNS = re.compile(JS_WS + "+")


def normalize_text(raw: str) -> str:
    return _RUNS.sub(" ", js_trim(raw))
