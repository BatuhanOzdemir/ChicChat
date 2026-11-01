"""Build a real WhatsApp webhook envelope from simulator input (SPEC §7) — port
of simulator/envelope.ts.

The simulator injects synthetic messages into the *production* pipeline: the
envelope produced here is the same shape Meta POSTs, so it goes through the
same `parse_inbound` and the same handler. Only the signature check is
bypassed — everything downstream is identical.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from chicchat.domain.simulator.protocol import SimulatorMessageInput


@dataclass(frozen=True)
class EnvelopeContext:
    phone_number_id: str
    from_phone: str
    message_id: str
    display_phone_number: str | None = None
    business_account_id: str | None = None


def _message_for(item: SimulatorMessageInput, ctx: EnvelopeContext) -> dict[str, Any]:
    base: dict[str, Any] = {
        "from": ctx.from_phone,
        "id": ctx.message_id,
        "timestamp": "0",
    }
    if item.kind == "text":
        return {**base, "type": "text", "text": {"body": item.value}}
    if item.kind == "list":
        # A tapped List Message row (the "Listeyi Gör" pattern, SPEC §6).
        return {
            **base,
            "type": "interactive",
            "interactive": {
                "type": "list_reply",
                "list_reply": {"id": item.value, "title": item.value},
            },
        }
    if item.kind == "photo":
        return {
            **base,
            "type": "image",
            "image": {"id": item.value, "mime_type": "image/jpeg"},
        }
    # Flow submission: Meta delivers the payload as an nfm_reply.
    return {
        **base,
        "type": "interactive",
        "interactive": {
            "type": "nfm_reply",
            "nfm_reply": {"name": "flow", "body": "Sent", "response_json": item.value},
        },
    }


def build_inbound_envelope(
    item: SimulatorMessageInput, ctx: EnvelopeContext
) -> dict[str, Any]:
    display = (
        ctx.display_phone_number
        if ctx.display_phone_number is not None
        else ctx.phone_number_id
    )
    account = (
        ctx.business_account_id
        if ctx.business_account_id is not None
        else "SIMULATOR_WABA"
    )
    return {
        "object": "whatsapp_business_account",
        "entry": [
            {
                "id": account,
                "changes": [
                    {
                        "field": "messages",
                        "value": {
                            "messaging_product": "whatsapp",
                            "metadata": {
                                "display_phone_number": display,
                                "phone_number_id": ctx.phone_number_id,
                            },
                            "contacts": [
                                {
                                    "profile": {"name": "Simulator"},
                                    "wa_id": ctx.from_phone,
                                }
                            ],
                            "messages": [_message_for(item, ctx)],
                        },
                    }
                ],
            }
        ],
    }
