"""Port of db/whatsapp-intake.integration.test.ts: a simulated inbound
WhatsApp conversation, driven through the handler against the live DB,
produces the right List Messages and a completed Tier-0 case."""

from __future__ import annotations

from chicchat.db.cases import build_handoff
from chicchat.db.config import DEMO_MERCHANT_ID
from chicchat.db.database import ConnectionDatabase
from chicchat.db.sessions import load_session
from chicchat.domain.whatsapp.types import OutboundMessage
from chicchat.server.whatsapp.handler import IntakeDeps, handle_inbound
from tests.db.helpers import body, inbound, row_ids

FROM = "905550000009"


def deps_for(db: ConnectionDatabase, sent: list[OutboundMessage]) -> IntakeDeps:
    return IntakeDeps(db=db, send=sent.append)


def test_opens_with_the_merchants_notice_and_does_not_repeat_it(
    db: ConnectionDatabase,
) -> None:
    phone = "905550000077"
    sent: list[OutboundMessage] = []
    handle_inbound(
        deps_for(db, sent), DEMO_MERCHANT_ID, inbound(phone, "text", "merhaba")
    )
    opening = sent[0]
    assert opening["type"] == "interactive"
    # The URL comes from this merchant's own merchant_config, not a constant.
    url = db.query(
        "select kvkk_url from merchant_config where merchant_id = $1",
        [DEMO_MERCHANT_ID],
    )[0]["kvkk_url"]
    assert url is not None
    assert url in body(opening)
    # Unrecognized input re-asks; that is a recovery, not a new conversation.
    handle_inbound(
        deps_for(db, sent), DEMO_MERCHANT_ID, inbound(phone, "text", "pizza please")
    )
    assert sent[1]["type"] == "interactive"
    assert url not in body(sent[1])


def test_walks_lists_and_fields_and_persists_the_case_then_clears_the_session(
    db: ConnectionDatabase,
) -> None:
    sent: list[OutboundMessage] = []
    deps = deps_for(db, sent)
    handle_inbound(deps, DEMO_MERCHANT_ID, inbound(FROM, "text", "hi"))
    assert "wrong_damaged_missing" in row_ids(sent[0])
    handle_inbound(
        deps, DEMO_MERCHANT_ID, inbound(FROM, "interactive", "wrong_damaged_missing")
    )
    assert "damaged" in row_ids(sent[1])
    handle_inbound(deps, DEMO_MERCHANT_ID, inbound(FROM, "interactive", "damaged"))
    assert sent[2]["type"] == "text"

    # Answer whichever field is asked next, so the test does not depend on the
    # merchant's configured field order (it is editable — SPEC §8).
    answers = {
        "order_number": ("text", "#tr-100 432"),
        "item_ref": ("text", "the red dress"),
        "description": ("text", "the seam is torn"),
        "photo": ("image", "wamid.media.9"),
    }
    for _ in range(6):
        session = load_session(db, DEMO_MERCHANT_ID, FROM)
        pending = session.get("pendingFieldKey") if session else None
        if not pending:
            break
        kind, value = answers[pending]
        handle_inbound(
            deps,
            DEMO_MERCHANT_ID,
            inbound(FROM, kind, value, value if kind == "image" else None),
        )

    summary = sent[-1]
    assert summary["type"] == "text"
    assert "wrong_damaged_missing" in summary["text"]["body"]
    assert "TR100432" in summary["text"]["body"]

    rows = db.query(
        "select id from cases where merchant_id = $1 and customer_wa_id = $2",
        [DEMO_MERCHANT_ID, FROM],
    )
    assert len(rows) == 1
    handoff = build_handoff(db, rows[0]["id"])
    assert handoff["category"] == "wrong_damaged_missing"
    assert handoff["subcategory"] == "damaged"
    assert handoff["fields"]["order_number"] == "TR100432"
    assert handoff["photos"] == ["wamid.media.9"]
    assert load_session(db, DEMO_MERCHANT_ID, FROM) is None


def test_re_prompts_the_category_list_when_the_first_pick_is_unrecognized(
    db: ConnectionDatabase,
) -> None:
    sent: list[OutboundMessage] = []
    deps = deps_for(db, sent)
    handle_inbound(deps, DEMO_MERCHANT_ID, inbound(FROM, "text", "hello"))
    handle_inbound(deps, DEMO_MERCHANT_ID, inbound(FROM, "text", "not a category"))
    reprompt = sent[-1]
    assert reprompt["type"] == "interactive"
    assert "didn't catch" in body(reprompt).lower()
