"""WhatsApp Cloud API message shapes (SPEC §6) — port of whatsapp/types.ts.

Only the fields ChicChat uses. These are stored as JSON (`message_inbox.payload`,
`message_outbox.payload`), so they are TypedDicts with the exact JSON keys
(docs/PORT.md P3). `InboundMessage` uses the functional form because `from` is
a Python keyword.
"""

from __future__ import annotations

from typing import Any, Literal, NotRequired, TypedDict

InboundKind = Literal["text", "interactive", "image", "flow", "other"]

InboundMessage = TypedDict(
    "InboundMessage",
    {
        "phoneNumberId": Any,
        "from": Any,
        "messageId": Any,
        "kind": InboundKind,
        # The value fed to intake `advance()`: list-reply id, text body, media
        # id, or a Flow submission value.
        "reply": str,
        # Present for image messages (a WhatsApp media id used as the photo ref).
        "mediaId": NotRequired[str],
        # Raw `response_json` of a Flow submission (kind `flow`).
        "flowResponse": NotRequired[str],
    },
)
"""A parsed inbound message, reduced to what the intake machine needs.

`phoneNumberId`, `from` and `messageId` are typed `Any` on purpose: they are
copied from the webhook as-is (Meta sends strings; malformed input is passed
through exactly as the TypeScript did).
"""


class ListRow(TypedDict):
    id: str
    title: str
    description: NotRequired[str]


class _TextBody(TypedDict):
    body: str


class TextMessage(TypedDict):
    to: str
    type: Literal["text"]
    text: _TextBody


class _Header(TypedDict):
    type: Literal["text"]
    text: str


class _Body(TypedDict):
    text: str


class _Section(TypedDict):
    title: str
    rows: list[ListRow]


class _Action(TypedDict):
    button: str
    sections: list[_Section]


class _Interactive(TypedDict):
    type: Literal["list"]
    header: NotRequired[_Header]
    body: _Body
    action: _Action


class InteractiveMessage(TypedDict):
    to: str
    type: Literal["interactive"]
    interactive: _Interactive


OutboundMessage = TextMessage | InteractiveMessage
"""An outbound message body (without messaging_product, which the client adds)."""
