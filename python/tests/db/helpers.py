"""Shared helpers for the database tests."""

from __future__ import annotations

import itertools
from typing import Any

from chicchat.domain.whatsapp.types import InboundMessage, OutboundMessage

_counter = itertools.count(1)


def inbound(
    phone: str,
    kind: str,
    reply: str,
    media_id: str | None = None,
    message_id: str | None = None,
) -> InboundMessage:
    """Every real delivery has its own id; reusing one is (correctly) skipped as
    a duplicate, because processing is idempotent (SPEC §11)."""
    message: dict[str, Any] = {
        "phoneNumberId": "PNID",
        "from": phone,
        "messageId": message_id or f"wamid.test.{next(_counter)}",
        "kind": kind,
        "reply": reply,
    }
    if media_id is not None:
        message["mediaId"] = media_id
    return message  # type: ignore[return-value]


def body(message: OutboundMessage) -> str:
    if message["type"] == "text":
        return message["text"]["body"]
    return message["interactive"]["body"]["text"]


def row_ids(message: OutboundMessage) -> list[str]:
    assert message["type"] == "interactive", "expected a list"
    return [r["id"] for r in message["interactive"]["action"]["sections"][0]["rows"]]


class RecordingLogger:
    """Logger that records lines so tests can assert on structured output."""

    def __init__(self) -> None:
        self.lines: list[dict[str, Any]] = []

    def info(self, event: str, context: dict[str, Any] | None = None) -> None:
        self.lines.append({"level": "info", "event": event, "context": context or {}})

    def warn(self, event: str, context: dict[str, Any] | None = None) -> None:
        self.lines.append({"level": "warn", "event": event, "context": context or {}})

    def error(
        self, event: str, error: object, context: dict[str, Any] | None = None
    ) -> None:
        self.lines.append(
            {
                "level": "error",
                "event": event,
                "context": {**(context or {}), "error_message": str(error)},
            }
        )


def simulate(db: Any, action: str, phone: str, merchant_id: str, **extra: Any) -> Any:
    """Drive the simulator service like the browser does (camelCase body)."""
    from chicchat.domain.result import Ok
    from chicchat.domain.simulator.protocol import parse_simulator_request
    from chicchat.server.simulator import run_simulator_action

    request = parse_simulator_request(
        {"action": action, "merchantId": merchant_id, "phone": phone, **extra}
    )
    assert isinstance(request, Ok), request
    return run_simulator_action(db, request.value)


def sent_to(response: Any, phone: str) -> list[OutboundMessage]:
    """Messages this run would have sent to one phone. The job sweeps every
    session the merchant has, so assertions scope to their own conversation
    (retrofit finding R6b)."""
    return [m for m in response.outbound if m["to"] == phone]


def say(
    db: Any,
    merchant_id: str,
    phone: str,
    kind: str,
    value: str,
    inject: str | None = None,
) -> Any:
    extra: dict[str, Any] = {"message": {"kind": kind, "value": value}}
    if inject:
        extra["injectError"] = inject
    return simulate(db, "message", phone, merchant_id, **extra)


def complete_intake(
    db: Any,
    merchant_id: str,
    phone: str,
    category: str,
    subcategory: str,
    answers: dict[str, tuple[str, str]],
) -> Any:
    """Complete an intake in the simulator, answering whatever is asked."""
    say(db, merchant_id, phone, "text", "merhaba")
    say(db, merchant_id, phone, "list", category)
    last = say(db, merchant_id, phone, "list", subcategory)
    for _ in range(12):
        pending = (last.session or {}).get("pendingFieldKey")
        if not pending:
            break
        kind, value = answers[pending]
        last = say(db, merchant_id, phone, kind, value)
    return last


RETURN_ANSWERS: dict[str, tuple[str, str]] = {
    "order_number": ("text", "  #tr-100 432 "),
    "item_ref": ("text", "blue shirt"),
    "reason": ("list", "wrong_size"),
    "condition": ("list", "unworn_tags_on"),
}
