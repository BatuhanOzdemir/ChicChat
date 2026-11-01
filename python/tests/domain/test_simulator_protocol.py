"""Port of simulator/protocol.test.ts and simulator/envelope.test.ts."""

from __future__ import annotations

import json
from typing import Any

from chicchat.domain.result import Err, Ok
from chicchat.domain.simulator.envelope import EnvelopeContext, build_inbound_envelope
from chicchat.domain.simulator.protocol import (
    SimulatorMessageInput,
    SimulatorRequest,
    parse_simulator_request,
)
from chicchat.domain.whatsapp import parse_inbound

BASE: dict[str, Any] = {"merchantId": "m1", "phone": "905551112233"}


def test_parses_a_text_message_request() -> None:
    result = parse_simulator_request(
        {**BASE, "action": "message", "message": {"kind": "text", "value": "hi"}}
    )
    assert result == Ok(
        SimulatorRequest(
            action="message",
            merchant_id="m1",
            phone="905551112233",
            message=SimulatorMessageInput(kind="text", value="hi"),
        )
    )


def test_strips_non_digits_from_the_phone() -> None:
    result = parse_simulator_request(
        {**BASE, "phone": "+90 555 111 22 33", "action": "state"}
    )
    assert isinstance(result, Ok) and result.value.phone == "905551112233"


def test_keeps_an_explicit_message_id_so_duplicates_can_be_replayed() -> None:
    result = parse_simulator_request(
        {
            **BASE,
            "action": "message",
            "message": {"kind": "text", "value": "hi", "messageId": "wamid.dup"},
        }
    )
    assert isinstance(result, Ok)
    assert (
        result.value.message is not None
        and result.value.message.message_id == "wamid.dup"
    )


def test_accepts_a_valid_error_injection_and_rejects_an_unknown_one() -> None:
    assert parse_simulator_request(
        {**BASE, "action": "state", "injectError": "handler_exception"}
    ).ok
    assert parse_simulator_request(
        {**BASE, "action": "state", "injectError": "explode"}
    ) == Err(
        "injectError must be one of handler_exception|integration_down|delivery_failure"
    )


def test_requires_a_positive_age_minutes_for_time_travel() -> None:
    assert parse_simulator_request(
        {**BASE, "action": "time_travel", "ageMinutes": 10}
    ).ok
    assert parse_simulator_request(
        {**BASE, "action": "time_travel", "ageMinutes": 0}
    ) == Err("ageMinutes must be a positive number")


def test_rejects_a_boolean_age_like_typeof_number() -> None:
    assert not parse_simulator_request(
        {**BASE, "action": "time_travel", "ageMinutes": True}
    ).ok


def test_rejects_malformed_bodies_without_throwing() -> None:
    assert not parse_simulator_request(None).ok
    assert not parse_simulator_request({"action": "message"}).ok
    assert not parse_simulator_request({**BASE, "action": "nope"}).ok
    assert not parse_simulator_request({**BASE, "action": "message", "message": {}}).ok
    assert not parse_simulator_request(
        {**BASE, "action": "message", "message": {"kind": "text", "value": ""}}
    ).ok
    assert not parse_simulator_request({**BASE, "phone": "12", "action": "state"}).ok


CTX = EnvelopeContext(
    phone_number_id="PNID", from_phone="905551112233", message_id="wamid.sim1"
)


def test_text_round_trips_through_the_production_parser() -> None:
    env = build_inbound_envelope(SimulatorMessageInput(kind="text", value="hi"), CTX)
    assert parse_inbound(env) == [
        {
            "phoneNumberId": "PNID",
            "from": "905551112233",
            "messageId": "wamid.sim1",
            "kind": "text",
            "reply": "hi",
        }
    ]


def test_list_tap_becomes_an_interactive_reply_carrying_the_row_id() -> None:
    [m] = parse_inbound(
        build_inbound_envelope(SimulatorMessageInput(kind="list", value="return"), CTX)
    )
    assert (m["kind"], m["reply"]) == ("interactive", "return")


def test_photo_becomes_an_image_with_a_media_id() -> None:
    [m] = parse_inbound(
        build_inbound_envelope(
            SimulatorMessageInput(kind="photo", value="media_1"), CTX
        )
    )
    assert (m["kind"], m["reply"], m.get("mediaId")) == ("image", "media_1", "media_1")


def test_flow_submission_becomes_a_flow_message_with_the_raw_response_kept() -> None:
    response_json = json.dumps({"item_ref": "Navy jacket"}, separators=(",", ":"))
    [m] = parse_inbound(
        build_inbound_envelope(
            SimulatorMessageInput(kind="flow", value=response_json), CTX
        )
    )
    assert (m["kind"], m["reply"], m.get("flowResponse")) == (
        "flow",
        "Navy jacket",
        response_json,
    )
