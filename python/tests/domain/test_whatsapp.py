"""Port of whatsapp/*.test.ts (verify, inbound, messages)."""

from __future__ import annotations

import hashlib
import hmac
import json
from typing import Any, cast

import pytest

from chicchat.domain.auth.gate import gate_decision, is_open_path, safe_next_path
from chicchat.domain.intake.types import Option, Prompt
from chicchat.domain.logging.mask import mask_phone, redact_log, redact_text
from chicchat.domain.nav import active_section
from chicchat.domain.simulator.envelope import EnvelopeContext, build_inbound_envelope
from chicchat.domain.simulator.protocol import (
    SimulatorMessageInput,
    parse_simulator_request,
)
from chicchat.domain.whatsapp import (
    flow_reply_value,
    generic_error_message,
    inbound_summary,
    nudge_message,
    outbound_summary,
    parse_inbound,
    prompt_to_message,
    verify_signature,
    verify_webhook_challenge,
)
from tests.golden import assert_golden, ts_json

# --- verify ------------------------------------------------------------------------


def test_echoes_the_challenge_on_a_valid_handshake() -> None:
    assert verify_webhook_challenge("subscribe", "secret", "12345", "secret") == "12345"


def test_returns_null_on_a_token_mismatch_or_wrong_mode() -> None:
    assert verify_webhook_challenge("subscribe", "wrong", "12345", "secret") is None
    assert verify_webhook_challenge("unsubscribe", "secret", "12345", "secret") is None


SECRET = "app-secret"
BODY = b'{"hello":"world"}'
GOOD = "sha256=" + hmac.new(SECRET.encode(), BODY, hashlib.sha256).hexdigest()


def test_accepts_a_correct_signature() -> None:
    assert verify_signature(BODY, GOOD, SECRET) is True


def test_rejects_a_tampered_body_or_missing_header() -> None:
    assert verify_signature(b'{"hello":"tampered"}', GOOD, SECRET) is False
    assert verify_signature(BODY, None, SECRET) is False
    assert verify_signature(BODY, "sha256=deadbeef", SECRET) is False


@pytest.mark.parametrize(
    "header",
    [
        "sha256=zz",
        "sha256=" + "g" * 64,
        "sha256=",
        "sha1=abc",
        "sha256=" + GOOD[7:] + "zz",
    ],
)
def test_rejects_malformed_signatures_without_raising(header: str) -> None:
    # Python's bytes.fromhex would raise here; the check must just fail (PORT.md P2).
    expected = header == "sha256=" + GOOD[7:] + "zz"
    assert verify_signature(BODY, header, SECRET) is expected


def test_verifies_the_raw_bytes_not_reserialized_json() -> None:
    raw = '{"b": 1,  "a": "İ"}'.encode()
    signature = "sha256=" + hmac.new(SECRET.encode(), raw, hashlib.sha256).hexdigest()
    assert verify_signature(raw, signature, SECRET) is True
    assert (
        verify_signature(json.dumps(json.loads(raw)).encode(), signature, SECRET)
        is False
    )


# --- inbound ------------------------------------------------------------------------


def envelope(message: object) -> dict[str, Any]:
    return {
        "object": "whatsapp_business_account",
        "entry": [
            {
                "changes": [
                    {
                        "value": {
                            "metadata": {"phone_number_id": "PNID1"},
                            "messages": [message],
                        }
                    }
                ]
            }
        ],
    }


def test_parses_a_text_message() -> None:
    [m] = parse_inbound(
        envelope(
            {
                "from": "905551112233",
                "id": "wamid.1",
                "type": "text",
                "text": {"body": "hi"},
            }
        )
    )
    assert (m["phoneNumberId"], m["from"], m["kind"], m["reply"]) == (
        "PNID1",
        "905551112233",
        "text",
        "hi",
    )


def test_parses_an_interactive_list_reply_to_its_row_id() -> None:
    [m] = parse_inbound(
        envelope(
            {
                "from": "905551112233",
                "id": "wamid.2",
                "type": "interactive",
                "interactive": {"type": "list_reply", "list_reply": {"id": "return"}},
            }
        )
    )
    assert (m["kind"], m["reply"]) == ("interactive", "return")


def test_parses_an_image_to_its_media_id() -> None:
    [m] = parse_inbound(
        envelope(
            {
                "from": "9055",
                "id": "wamid.3",
                "type": "image",
                "image": {"id": "media_9"},
            }
        )
    )
    assert (m["kind"], m["reply"], m.get("mediaId")) == ("image", "media_9", "media_9")


def test_ignores_status_delivery_events() -> None:
    assert (
        parse_inbound(
            {
                "entry": [
                    {"changes": [{"value": {"statuses": [{"status": "delivered"}]}}]}
                ]
            }
        )
        == []
    )


def test_never_throws_on_malformed_input() -> None:
    assert parse_inbound(None) == []
    assert parse_inbound({}) == []


def test_parses_a_flow_submission_into_a_flow_message() -> None:
    response_json = json.dumps({"condition": "unworn_tags_on"}, separators=(",", ":"))
    [m] = parse_inbound(
        envelope(
            {
                "from": "9055",
                "id": "wamid.4",
                "type": "interactive",
                "interactive": {
                    "type": "nfm_reply",
                    "nfm_reply": {"response_json": response_json},
                },
            }
        )
    )
    assert (m["kind"], m["reply"], m.get("flowResponse")) == (
        "flow",
        "unworn_tags_on",
        response_json,
    )


def test_unwraps_a_single_key_scalar_payload() -> None:
    assert flow_reply_value('{"order_number":"TR100432"}') == "TR100432"
    assert flow_reply_value('{"qty":2}') == "2"


def test_passes_richer_payloads_through_as_raw_json() -> None:
    multi = '{"selected_items":["li_1","li_2"]}'
    assert flow_reply_value(multi) == multi
    two_keys = '{"a":"1","b":"2"}'
    assert flow_reply_value(two_keys) == two_keys


def test_returns_the_input_unchanged_when_it_is_not_json() -> None:
    assert flow_reply_value("not json") == "not json"


# --- messages -----------------------------------------------------------------------

TO = "905551112233"


def _json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False)


def test_uses_the_merchants_turkish_locale_for_prompts_reminders_and_failures() -> None:
    prompt = prompt_to_message(
        {
            "kind": "select_category",
            "options": [{"key": "iade", "label": "İade"}],
            "retry": False,
            "disclosure": "https://example.com/kvkk",
        },
        TO,
        "tr",
    )
    assert "Nasıl yardımcı olabiliriz?" in _json(prompt)
    assert "aydınlatma metni" in _json(prompt)
    assert "Kaldığınız yerden" in _json(nudge_message(TO, "tr"))
    assert "temsilcimiz" in _json(generic_error_message(TO, "tr"))


OPTIONS: list[Option] = [{"key": "return", "label": "Return request"}]


def _interactive(message: Any) -> dict[str, Any]:
    assert message["type"] == "interactive"
    return cast(dict[str, Any], message["interactive"])


def test_carries_the_notice_in_the_opening_message_rather_than_a_separate_one() -> None:
    message = prompt_to_message(
        {
            "kind": "select_category",
            "retry": False,
            "options": OPTIONS,
            "disclosure": "https://example.com/kvkk",
        },
        TO,
    )
    body = _interactive(message)["body"]["text"]
    assert "https://example.com/kvkk" in body
    assert "Please pick a topic:" in body
    assert len(body) <= 1024


def test_leaves_the_message_untouched_when_there_is_no_disclosure() -> None:
    message = prompt_to_message(
        {"kind": "select_category", "retry": False, "options": OPTIONS}, TO
    )
    body = _interactive(message)["body"]["text"].lower()
    assert "agree" not in body and "personal data" not in body


def test_renders_a_category_prompt_as_an_interactive_list_message() -> None:
    prompt: Prompt = {
        "kind": "select_category",
        "retry": False,
        "options": [
            {"key": "return", "label": "Return request"},
            {"key": "wrong_damaged_missing", "label": "Wrong / damaged / missing item"},
        ],
    }
    interactive = _interactive(prompt_to_message(prompt, TO))
    assert interactive["type"] == "list"
    assert len(interactive["action"]["button"]) <= 20
    rows = interactive["action"]["sections"][0]["rows"]
    assert [r["id"] for r in rows] == ["return", "wrong_damaged_missing"]
    assert len(rows[1]["title"]) <= 24
    assert rows[1]["description"] == "Wrong / damaged / missing item"


def test_offers_an_enum_field_as_a_tappable_list_never_as_free_text() -> None:
    prompt: Prompt = {
        "kind": "select_field",
        "retry": False,
        "field": {
            "key": "refund_method",
            "type": "enum",
            "required": True,
            "enumValues": ["original_payment", "store_credit", "bank_transfer"],
        },
        "options": [
            {"key": "original_payment", "label": "Original payment"},
            {"key": "store_credit", "label": "Store credit"},
            {"key": "bank_transfer", "label": "Bank transfer"},
        ],
    }
    interactive = _interactive(prompt_to_message(prompt, TO))
    assert [r["id"] for r in interactive["action"]["sections"][0]["rows"]] == [
        "original_payment",
        "store_credit",
        "bank_transfer",
    ]
    assert "refund method" in interactive["body"]["text"]


def test_asks_for_a_normal_field_as_text() -> None:
    message = prompt_to_message(
        {
            "kind": "request_field",
            "retry": False,
            "field": {"key": "order_number", "type": "string", "required": True},
        },
        TO,
    )
    assert message["type"] == "text"
    assert "order number" in message["text"]["body"].lower()


def test_asks_for_a_photo_for_media_fields_with_a_retry_prefix_when_retrying() -> None:
    message = prompt_to_message(
        {
            "kind": "request_field",
            "retry": True,
            "field": {"key": "photo", "type": "media", "required": True},
        },
        TO,
    )
    assert message["type"] == "text"
    body = message["text"]["body"].lower()
    assert "photo" in body and "sorry" in body


def test_summarizes_a_completed_case() -> None:
    message = prompt_to_message(
        {
            "kind": "complete",
            "case": {
                "category": "return",
                "subcategory": "doesnt_fit",
                "integration_tier": 0,
                "fields": [
                    {"key": "order_number", "raw": "TR100432", "normalized": "TR100432"}
                ],
            },
        },
        TO,
    )
    assert message["type"] == "text"
    assert "return" in message["text"]["body"]
    assert "TR100432" in message["text"]["body"]


# --- golden -------------------------------------------------------------------------


def _simulator_request(body: object) -> Any:
    converted = ts_json(parse_simulator_request(body))
    if converted["ok"]:
        # TypeScript only set optional keys when present.
        value = {k: v for k, v in converted["value"].items() if v is not None}
        if "message" in value:
            value["message"] = {
                k: v for k, v in value["message"].items() if v is not None
            }
        converted["value"] = value
    return converted


def _envelope(item: dict[str, str], ctx: dict[str, str]) -> Any:
    return build_inbound_envelope(
        SimulatorMessageInput(kind=item["kind"], value=item["value"]),  # type: ignore[arg-type]
        EnvelopeContext(
            phone_number_id=ctx["phoneNumberId"],
            from_phone=ctx["from"],
            message_id=ctx["messageId"],
        ),
    )


def _gate(inp: dict[str, Any]) -> Any:
    decision = gate_decision(
        inp["pathname"],
        inp["authenticated"],
        inp["isProduction"],
        inp.get("allowDevelopmentAccess", False),
    )
    return {k: v for k, v in ts_json(decision).items() if v is not None}


def test_matches_the_typescript_implementation() -> None:
    assert (
        assert_golden(
            "whatsapp",
            {
                "parseInbound": lambda body: parse_inbound(body),
                "flowReplyValue": flow_reply_value,
                "promptToMessage": prompt_to_message,
                "nudgeMessage": nudge_message,
                "genericErrorMessage": generic_error_message,
                "outboundSummary": outbound_summary,
                "inboundSummary": inbound_summary,
                "buildInboundEnvelope": _envelope,
                "parseSimulatorRequest": _simulator_request,
                "maskPhone": mask_phone,
                "redactText": redact_text,
                "redactLog": redact_log,
                "isOpenPath": is_open_path,
                "gateDecision": _gate,
                "safeNextPath": safe_next_path,
                "activeSection": active_section,
            },
        )
        > 300
    )
