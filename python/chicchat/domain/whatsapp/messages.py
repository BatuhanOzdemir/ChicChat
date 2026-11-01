"""Turn an intake `Prompt` into a WhatsApp outbound message (SPEC §6) — port
of whatsapp/messages.ts.

Category/subcategory prompts become static interactive **List Messages** (the
"Listeyi Gör" pattern); field prompts become text; completion becomes a
summary. Respects WhatsApp's field-length caps, counted in UTF-16 units as the
TypeScript did. Every customer-facing sentence is copied verbatim (PORT.md §7).
"""

from __future__ import annotations

from collections.abc import Sequence

from chicchat.domain.intake.types import Option, Prompt
from chicchat.domain.jscompat import js_length, js_slice
from chicchat.domain.whatsapp.types import InboundMessage, ListRow, OutboundMessage

# WhatsApp caps: row title <= 24, description <= 72, button <= 20, header <= 60.
TITLE_MAX = 24
DESC_MAX = 72
BUTTON = "View options"


def _truncate(value: str, limit: int) -> str:
    return value if js_length(value) <= limit else js_slice(value, 0, limit - 1) + "…"


def _humanize(key: str) -> str:
    return key.replace("_", " ")


def _to_rows(options: Sequence[Option]) -> list[ListRow]:
    # Cap at 10 rows (WhatsApp limit); the taxonomy fits comfortably.
    rows: list[ListRow] = []
    for option in options[:10]:
        row: ListRow = {
            "id": option["key"],
            "title": _truncate(option["label"], TITLE_MAX),
        }
        if js_length(option["label"]) > TITLE_MAX:
            row["description"] = _truncate(option["label"], DESC_MAX)
        rows.append(row)
    return rows


def _list(
    to: str,
    header: str,
    body: str,
    section_title: str,
    options: Sequence[Option],
    locale: str = "en",
) -> OutboundMessage:
    return {
        "to": to,
        "type": "interactive",
        "interactive": {
            "type": "list",
            "header": {"type": "text", "text": _truncate(header, 60)},
            "body": {"text": body},
            "action": {
                "button": "Seçenekleri gör" if locale.startswith("tr") else BUTTON,
                "sections": [
                    {
                        "title": _truncate(section_title, TITLE_MAX),
                        "rows": _to_rows(options),
                    }
                ],
            },
        },
    }


def _text(to: str, body: str) -> OutboundMessage:
    return {"to": to, "type": "text", "text": {"body": body}}


def nudge_message(to: str, locale: str = "en") -> OutboundMessage:
    """The single gentle resume prompt sent after `nudge_after_minutes` (SPEC §11)."""
    return _text(
        to,
        "Devam etmek ister misiniz? Kaldığınız yerden sürdürebiliriz."
        if locale.startswith("tr")
        else "Still there? We can pick up right where you left off — your answers are saved.",
    )


def generic_error_message(to: str, locale: str | None = "en") -> OutboundMessage:
    """Generic customer-facing failure message (SPEC §13): never leaks
    diagnostics, and promises a human follow-up because the case may be
    incomplete."""
    tr = (locale if locale is not None else "en").startswith("tr")
    return _text(
        to,
        "Üzgünüz, bir sorun oluştu. Bir temsilcimiz sizinle ilgilenecek."
        if tr
        else "Sorry — something went wrong on our side. An agent will follow up with you shortly.",
    )


def outbound_summary(message: OutboundMessage) -> str:
    """The one line an agent reads in the transcript (SPEC §9): a List Message
    becomes its question plus the options offered."""
    if message["type"] == "text":
        return message["text"]["body"]
    interactive = message["interactive"]
    options = " · ".join(
        row["title"]
        for section in interactive["action"]["sections"]
        for row in section["rows"]
    )
    body = interactive["body"]["text"]
    return body if options == "" else f"{body}\n[{options}]"


def inbound_summary(message: InboundMessage) -> str:
    """The same, for what the customer sent."""
    kind = message["kind"]
    if kind == "interactive":
        return f'tapped "{message["reply"]}"'
    if kind == "image":
        media_id = message.get("mediaId")
        return f"sent a photo ({message['reply'] if media_id is None else media_id})"
    if kind == "flow":
        return f"submitted a form: {message['reply']}"
    return message["reply"]


def _with_disclosure(body: str, url: str | None, locale: str) -> str:
    """Prepend the KVKK notice to an opening message (SPEC §12).

    It rides on the message the customer was going to receive anyway: a
    standalone legal notice before the greeting reads as spam, and on WhatsApp
    it would also cost an extra delivery.
    """
    if not url:
        return body
    notice = (
        "Kişisel verilerinizin işlenmesine ilişkin aydınlatma metni:"
        if locale.startswith("tr")
        else "Read how we handle your personal data:"
    )
    return f"{body}\n\n{notice} {url}"


def prompt_to_message(prompt: Prompt, to: str, locale: str = "en") -> OutboundMessage:
    tr = locale.startswith("tr")
    if prompt["kind"] == "select_category":
        if prompt["retry"]:
            body = (
                "Lütfen bir konu seçin:"
                if tr
                else "Sorry, I didn't catch that. Please pick a topic:"
            )
        else:
            body = "Lütfen bir konu seçin:" if tr else "Please pick a topic:"
        return _list(
            to,
            "Nasıl yardımcı olabiliriz?" if tr else "How can we help?",
            _with_disclosure(body, prompt.get("disclosure"), locale),
            "Konular" if tr else "Topics",
            prompt["options"],
            locale,
        )
    if prompt["kind"] == "select_subcategory":
        if prompt["retry"]:
            body = (
                "Lütfen bir seçenek seçin:"
                if tr
                else "Sorry, I didn't catch that. Please choose one:"
            )
        else:
            body = (
                "Hangisi durumu en iyi açıklıyor?" if tr else "Which best describes it?"
            )
        return _list(
            to,
            "Biraz daha ayrıntı" if tr else "A bit more detail",
            body,
            "Seçenekler" if tr else "Options",
            prompt["options"],
            locale,
        )
    if prompt["kind"] == "select_field":
        # Enum fields are always tappable (SPEC §5) — the customer never guesses.
        field = prompt["field"]
        label = field.get("label")
        label = _humanize(field["key"]) if label is None else label
        if prompt["retry"]:
            body = (
                f"{label} için bir seçenek seçin:"
                if tr
                else f"Please choose one of the options for {label}:"
            )
        else:
            body = f"{label} seçin:" if tr else f"Please choose your {label}:"
        return _list(
            to,
            label,
            body,
            "Seçenekler" if tr else "Options",
            prompt["options"],
            locale,
        )
    if prompt["kind"] == "request_field":
        field = prompt["field"]
        prefix = (
            ("Lütfen tekrar deneyin. " if tr else "Sorry, that didn't look right. ")
            if prompt["retry"]
            else ""
        )
        if field["type"] == "media":
            body = prefix + (
                "Lütfen ürünün fotoğrafını gönderin."
                if tr
                else "Please send a photo of the item."
            )
        else:
            label = field.get("label")
            label = _humanize(field["key"]) if label is None else label
            body = (
                f"{prefix}{'Lütfen paylaşın:' if tr else 'Please share your'} {label}."
            )
        return _text(to, body)
    case = prompt["case"]
    subcategory = f" / {case['subcategory']}" if case["subcategory"] else ""
    lines = [
        "✅ Teşekkürler! Talebinizi kaydettik:"
        if tr
        else "✅ Thanks! We've logged your request:",
        f"• {'Kategori' if tr else 'Category'}: {case['category']}{subcategory}",
        *(
            f"• {_humanize(f['key'])}: {'—' if f['normalized'] is None else f['normalized']}"
            for f in case["fields"]
        ),
        "",
        "Bir temsilcimiz sizinle ilgilenecek."
        if tr
        else "An agent will follow up shortly.",
    ]
    return _text(to, "\n".join(lines))
