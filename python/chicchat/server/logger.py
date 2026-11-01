"""Structured logging (Handbook §8, SPEC §16) — port of server/logging/logger.ts.

One JSON line per event, always carrying `merchant_id` and a correlation id
(the WhatsApp message id), and never carrying PII beyond a masked phone. Error
lines go to stderr so hosting platforms split them. Python's `logging` module
is deliberately not used: it would add its own formatting (PORT.md P19).
"""

from __future__ import annotations

import json
import sys
import traceback
from dataclasses import asdict, is_dataclass
from datetime import UTC, datetime
from typing import Any, Literal, Protocol

from chicchat.domain.dates import to_js_iso
from chicchat.domain.logging.mask import mask_phone, redact_log

LogEvent = Literal[
    "webhook_received",
    "webhook_rejected",
    "validation_failed",
    "message_skipped_duplicate",
    "routing_decision",
    "integration_call",
    "integration_failure",
    "case_persisted",
    "session_nudged",
    "session_abandoned",
    "session_errored",
    "unexpected_exception",
]


class Logger(Protocol):
    def info(self, event: LogEvent, context: dict[str, Any] | None = None) -> None: ...
    def warn(self, event: LogEvent, context: dict[str, Any] | None = None) -> None: ...
    def error(
        self,
        event: LogEvent,
        error: BaseException | object,
        context: dict[str, Any] | None = None,
    ) -> None: ...


def error_message(error: BaseException | object) -> str:
    """`err.message` in JavaScript: the primary message only.

    psycopg's `str(error)` appends DETAIL lines that can quote row values, so
    its primary diagnostic is used instead.
    """
    if isinstance(error, BaseException):
        diag = getattr(error, "diag", None)
        primary = getattr(diag, "message_primary", None) if diag is not None else None
        return primary if isinstance(primary, str) else str(error)
    return str(error)


def _plain(value: Any) -> Any:
    """JSON.stringify semantics for the values our code logs."""
    if isinstance(value, datetime):
        return to_js_iso(value)
    if is_dataclass(value) and not isinstance(value, type):
        return _plain(asdict(value))
    if isinstance(value, dict):
        return {str(k): _plain(v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [_plain(v) for v in value]
    return value


def emit(
    level: Literal["info", "warn", "error"],
    event: LogEvent,
    context: dict[str, Any] | None = None,
) -> None:
    ctx = dict(context or {})
    merchant_id = ctx.pop("merchantId", None)
    correlation_id = ctx.pop("correlationId", None)
    phone = ctx.pop("phone", None)
    line: dict[str, Any] = {
        "ts": to_js_iso(datetime.now(UTC)),
        "level": level,
        "event": event,
        "merchant_id": merchant_id,
        "correlation_id": correlation_id,
    }
    if phone is not None:
        line["phone"] = mask_phone(str(phone))
    line.update(ctx)
    # `undefined` values vanish from JSON.stringify output; None is the closest.
    serialized = json.dumps(
        redact_log(_plain(line)), ensure_ascii=False, separators=(",", ":"), default=str
    )
    stream = sys.stderr if level == "error" else sys.stdout
    stream.write(serialized + "\n")
    stream.flush()


class JsonLogger:
    def info(self, event: LogEvent, context: dict[str, Any] | None = None) -> None:
        emit("info", event, context)

    def warn(self, event: LogEvent, context: dict[str, Any] | None = None) -> None:
        emit("warn", event, context)

    def error(
        self,
        event: LogEvent,
        error: BaseException | object,
        context: dict[str, Any] | None = None,
    ) -> None:
        stack = (
            "".join(traceback.format_exception(error))
            if isinstance(error, BaseException)
            else None
        )
        details: dict[str, Any] = {
            **(context or {}),
            "error_message": error_message(error),
        }
        if stack is not None:
            details["stack"] = stack
        emit("error", event, details)


logger: Logger = JsonLogger()
