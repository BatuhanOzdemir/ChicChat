"""Parse a WhatsApp webhook POST body into the inbound messages we act on —
port of whatsapp/inbound.ts.

Ignores status/delivery events and anything without a usable payload. Mirrors
the TypeScript property access exactly (`js_get`), including its one crash: a
`null` entry, change or message raises TypeError, as `null.changes` threw in
JavaScript (recorded in docs/PORT.md §9 as a follow-up, not fixed in the port).
"""

from __future__ import annotations

from typing import Any

from chicchat.domain.jscompat import (
    UNDEFINED,
    is_js_number,
    js_get,
    js_json_parse,
    js_nullish,
    js_opt,
    js_string,
    js_truthy,
)
from chicchat.domain.whatsapp.types import InboundMessage


def flow_reply_value(response_json: str) -> str:
    """Reduce a Flow submission to the value the intake machine consumes.

    A single-key payload with a scalar value (the common shape for a one-input
    Flow screen) yields that scalar; anything richer — notably the multi-item
    picker — is passed through as raw JSON.
    """
    try:
        parsed = js_json_parse(response_json)
    except ValueError:
        return response_json
    if not isinstance(parsed, dict):
        return response_json
    if len(parsed) != 1:
        return response_json
    (only,) = parsed.values()
    if isinstance(only, str):
        return only
    if is_js_number(only) or isinstance(only, bool):
        return js_string(only)
    return response_json


def _as_array(value: object) -> list[Any]:
    return value if isinstance(value, list) else []


def parse_inbound(body: object) -> list[InboundMessage]:
    out: list[InboundMessage] = []
    for entry in _as_array(js_opt(body, "entry")):
        for change in _as_array(js_get(entry, "changes")):
            value = js_get(change, "value")
            phone_number_id = js_nullish(
                js_opt(js_opt(value, "metadata"), "phone_number_id"), ""
            )
            for raw in _as_array(js_opt(value, "messages")):
                sender = js_get(raw, "from")
                message_id = js_get(raw, "id")
                if not js_truthy(sender) or not js_truthy(message_id):
                    continue
                kind = js_get(raw, "type")
                interactive = js_get(raw, "interactive")
                if kind == "interactive":
                    response_json = js_opt(
                        js_opt(interactive, "nfm_reply"), "response_json"
                    )
                    reply_id = js_nullish(
                        js_opt(js_opt(interactive, "list_reply"), "id"),
                        js_opt(js_opt(interactive, "button_reply"), "id"),
                    )
                    if js_truthy(response_json):
                        # Meta sends a string; anything else passes through
                        # unchanged, as JSON.parse(nonString) fell back to it.
                        reply = (
                            flow_reply_value(response_json)
                            if isinstance(response_json, str)
                            else response_json
                        )
                        out.append(
                            {
                                "phoneNumberId": phone_number_id,
                                "from": sender,
                                "messageId": message_id,
                                "kind": "flow",
                                "reply": reply,  # type: ignore[typeddict-item]
                                "flowResponse": response_json,  # type: ignore[typeddict-item]
                            }
                        )
                    elif js_truthy(reply_id):
                        out.append(
                            _message(
                                phone_number_id,
                                sender,
                                message_id,
                                "interactive",
                                reply_id,
                            )
                        )
                    continue
                text_body = js_opt(js_get(raw, "text"), "body")
                image_id = js_opt(js_get(raw, "image"), "id")
                if kind == "text" and js_truthy(text_body):
                    out.append(
                        _message(phone_number_id, sender, message_id, "text", text_body)
                    )
                elif kind == "image" and js_truthy(image_id):
                    message = _message(
                        phone_number_id, sender, message_id, "image", image_id
                    )
                    message["mediaId"] = image_id  # type: ignore[typeddict-item]
                    out.append(message)
                else:
                    out.append(
                        _message(phone_number_id, sender, message_id, "other", "")
                    )
    return out


def _message(
    phone_number_id: object,
    sender: object,
    message_id: object,
    kind: str,
    reply: object,
) -> InboundMessage:
    return {
        "phoneNumberId": phone_number_id,
        "from": sender,
        "messageId": message_id,
        "kind": kind,  # type: ignore[typeddict-item]
        "reply": reply,  # type: ignore[typeddict-item]
    }


__all__ = ["UNDEFINED", "flow_reply_value", "parse_inbound"]
