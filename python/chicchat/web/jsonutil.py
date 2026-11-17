"""JSON responses shaped like the TypeScript ones (PORT.md P12).

`Response.json` in Next.js serialized dates with `toISOString()` (UTC,
milliseconds, `Z`) and bytes never reached JSON. This encoder does the same so
the simulator UI and API clients see identical payloads.
"""

from __future__ import annotations

import json
from dataclasses import asdict, is_dataclass
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from fastapi.responses import JSONResponse

from chicchat.domain.dates import to_js_iso


def _default(value: Any) -> Any:
    if isinstance(value, datetime):
        return to_js_iso(value)
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Decimal):
        number = float(value)
        return int(number) if number.is_integer() else number
    if is_dataclass(value) and not isinstance(value, type):
        return asdict(value)
    raise TypeError(f"not JSON serializable: {type(value).__name__}")


def dumps(value: Any) -> str:
    return json.dumps(
        value, default=_default, ensure_ascii=False, separators=(",", ":")
    )


class JsJSONResponse(JSONResponse):
    def render(self, content: Any) -> bytes:
        return dumps(content).encode("utf-8")


def json_response(content: Any, status_code: int = 200) -> JsJSONResponse:
    return JsJSONResponse(content, status_code=status_code)
