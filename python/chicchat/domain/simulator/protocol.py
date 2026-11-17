"""Simulator wire protocol (SPEC §7) — port of simulator/protocol.ts.

The simulator endpoint is external input like any other, so its body is parsed
and validated here (Handbook §5) and the result is a `Result` rather than an
exception (Handbook §3).
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Literal

from chicchat.domain.jscompat import is_js_number, js_trim
from chicchat.domain.result import Err, Ok, Result

SimulatorInputKind = Literal["text", "list", "photo", "flow"]
SimulatorErrorInjection = Literal[
    "handler_exception", "integration_down", "delivery_failure"
]
"""Error injection (SPEC §7). `handler_exception` forces a real exception inside
message processing. `integration_down` is accepted and echoed but has nothing
to degrade (no commerce integration is in scope)."""
SimulatorAction = Literal[
    "message", "reset", "time_travel", "state", "retry_delivery", "maintenance"
]

_ACTIONS: tuple[str, ...] = (
    "message",
    "reset",
    "time_travel",
    "state",
    "maintenance",
    "retry_delivery",
)
_KINDS: tuple[str, ...] = ("text", "list", "photo", "flow")
_INJECTIONS: tuple[str, ...] = (
    "handler_exception",
    "integration_down",
    "delivery_failure",
)
_NON_DIGITS = re.compile(r"[^0-9]")


@dataclass(frozen=True)
class SimulatorMessageInput:
    """What the tester did in the chat UI."""

    kind: SimulatorInputKind
    value: str
    """text body · tapped list-row id · fake media id · Flow `response_json`."""
    message_id: str | None = None
    """Reuse a previous id to replay a duplicate delivery (SPEC §11 idempotency)."""


@dataclass(frozen=True)
class SimulatorRequest:
    action: SimulatorAction
    merchant_id: str
    phone: str
    """Fake customer phone, digits only (E.164 without `+`)."""
    message: SimulatorMessageInput | None = None
    age_minutes: int | None = None
    """Minutes to age the session by (action `time_travel`)."""
    inject_error: SimulatorErrorInjection | None = None


def _str(value: object) -> str | None:
    return value if isinstance(value, str) and js_trim(value) != "" else None


def _as_object(value: object) -> dict[str, object] | None:
    """`typeof value === "object" && value !== null`: arrays count, with no keys."""
    if isinstance(value, dict):
        return value
    if isinstance(value, list):
        return {}
    return None


def _parse_message(value: object) -> Result[SimulatorMessageInput]:
    raw = _as_object(value)
    if raw is None:
        return Err("message must be an object")
    kind = _str(raw.get("kind"))
    if not kind or kind not in _KINDS:
        return Err(f"message.kind must be one of {'|'.join(_KINDS)}")
    # A photo/flow value may be long, a text value may be any non-empty string.
    value = raw.get("value")
    if not isinstance(value, str) or value == "":
        return Err("message.value must be a non-empty string")
    return Ok(
        SimulatorMessageInput(
            kind=kind,  # type: ignore[arg-type]
            value=value,
            message_id=_str(raw.get("messageId")),
        )
    )


def parse_simulator_request(value: object) -> Result[SimulatorRequest]:
    body = _as_object(value)
    if body is None:
        return Err("body must be a JSON object")
    action = _str(body.get("action"))
    if not action or action not in _ACTIONS:
        return Err(f"action must be one of {'|'.join(_ACTIONS)}")
    merchant_id = _str(body.get("merchantId"))
    if not merchant_id:
        return Err("merchantId is required")
    raw_phone = _str(body.get("phone"))
    if not raw_phone:
        return Err("phone is required")
    phone = _NON_DIGITS.sub("", raw_phone)
    if len(phone) < 6:
        return Err("phone must contain at least 6 digits")
    inject = _str(body.get("injectError"))
    if inject and inject not in _INJECTIONS:
        return Err(f"injectError must be one of {'|'.join(_INJECTIONS)}")

    message: SimulatorMessageInput | None = None
    if action == "message":
        parsed = _parse_message(body.get("message"))
        if isinstance(parsed, Err):
            return parsed
        message = parsed.value

    age_minutes: int | None = None
    if action == "time_travel":
        raw_minutes = body.get("ageMinutes")
        minutes = float(raw_minutes) if is_js_number(raw_minutes) else math.nan  # type: ignore[arg-type]
        if not math.isfinite(minutes) or minutes <= 0:
            return Err("ageMinutes must be a positive number")
        age_minutes = math.floor(minutes)

    return Ok(
        SimulatorRequest(
            action=action,  # type: ignore[arg-type]
            merchant_id=merchant_id,
            phone=phone,
            message=message,
            age_minutes=age_minutes,
            inject_error=inject,  # type: ignore[arg-type]
        )
    )
