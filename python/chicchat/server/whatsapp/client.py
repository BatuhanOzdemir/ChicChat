"""WhatsApp Cloud API transport — port of server/whatsapp/client.ts.

Send an outbound message via the Graph API. Returns a `Sender` so the intake
handler stays testable with an in-memory stand-in.
"""

from __future__ import annotations

from collections.abc import Callable

import httpx

from chicchat.domain.jscompat import js_json_stringify
from chicchat.domain.whatsapp.types import OutboundMessage
from chicchat.server.whatsapp.config import WhatsAppConfig

Sender = Callable[[OutboundMessage], None]


class WhatsAppSendError(RuntimeError):
    pass


def graph_sender(config: WhatsAppConfig, phone_number_id: str | None = None) -> Sender:
    """`phone_number_id` overrides the environment's number, so a reply goes out
    from the number the customer actually messaged (SPEC §10 multi-tenancy)."""
    sender_id = (
        phone_number_id if phone_number_id is not None else config.phone_number_id
    )

    def send(message: OutboundMessage) -> None:
        url = f"https://graph.facebook.com/{config.graph_version}/{sender_id}/messages"
        body = js_json_stringify(
            {"messaging_product": "whatsapp", "recipient_type": "individual", **message}
        )
        response = httpx.post(
            url,
            content=body.encode("utf-8"),
            headers={
                "Authorization": f"Bearer {config.access_token}",
                "Content-Type": "application/json",
            },
            timeout=15.0,
            follow_redirects=False,
        )
        if not response.is_success:
            raise WhatsAppSendError(
                f"WhatsApp send failed (HTTP {response.status_code})"
            )

    return send
