"""Port of app/(app)/simulator/run-preset.test.ts."""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Any

from chicchat.domain.simulator.presets import PRESETS, play_preset
from chicchat.domain.simulator.protocol import SimulatorMessageInput


@dataclass(frozen=True)
class Response:
    session: Any = None
    completed_case: Any = None
    error: str | None = None


EMPTY = Response()
QUESTION = Response(
    session={
        "status": "collecting_fields",
        "categoryKey": "return",
        "pendingFieldKey": "reason",
        "fields": {},
        "pendingInitial": {},
    }
)


def test_sends_a_rejected_answer_only_once_then_invites_manual_selection() -> None:
    sent: list[SimulatorMessageInput] = []
    notices: list[str] = []

    def send(message: SimulatorMessageInput) -> Response:
        sent.append(message)
        return QUESTION

    play_preset(PRESETS[0], lambda: EMPTY, send, lambda: False, notices.append)
    assert len(sent) == 2  # greeting, then a single answer
    assert any("Choose one of the displayed options" in n for n in notices)


def test_stops_after_the_in_flight_request_and_sends_no_further_answers() -> None:
    state = {"stopped": False, "sends": 0}

    def send(_message: SimulatorMessageInput) -> Response:
        state["sends"] += 1
        state["stopped"] = True
        return QUESTION

    play_preset(
        PRESETS[0], lambda: EMPTY, send, lambda: bool(state["stopped"]), lambda _n: None
    )
    assert state["sends"] == 1


def test_does_not_send_a_greeting_when_reset_is_refused() -> None:
    sent: list[SimulatorMessageInput] = []
    play_preset(
        PRESETS[0],
        lambda: replace(EMPTY, error="real WhatsApp activity"),
        lambda m: sent.append(m),
        lambda: False,
        lambda _n: None,
    )
    assert sent == []


def test_stops_on_a_processing_failure_instead_of_replaying_the_rejected_message() -> (
    None
):
    sent: list[SimulatorMessageInput] = []

    def send(message: SimulatorMessageInput) -> Response:
        sent.append(message)
        return replace(QUESTION, error="delivery pending")

    play_preset(PRESETS[0], lambda: EMPTY, send, lambda: False, lambda _n: None)
    assert len(sent) == 1
