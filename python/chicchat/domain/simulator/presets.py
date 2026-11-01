"""One-click regression scenarios (SPEC §7) — port of the simulator's
presets.ts and run-preset.ts.

Answers are keyed by field, so a preset keeps working when the taxonomy changes
the order fields are asked in: the runner reads `session.pendingFieldKey` and
looks the answer up. The decision rule lives here (Python) so the browser only
loops and handles Stop; `play_preset` drives the same rule for tests.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

from chicchat.domain.simulator.protocol import SimulatorInputKind, SimulatorMessageInput


@dataclass(frozen=True)
class Answer:
    kind: SimulatorInputKind
    value: str


@dataclass(frozen=True)
class Preset:
    id: str
    label: str
    description: str
    greeting: str
    category: str | None = None
    subcategory: str | None = None
    answers: Mapping[str, Answer] = field(default_factory=dict)
    replay_greeting: bool = False
    """Send the greeting twice with the same message id (duplicate delivery)."""


PRESETS: tuple[Preset, ...] = (
    Preset(
        id="messy_order_number",
        label="Messy order number",
        description="Return / doesn't fit, with '  #tr-100 432 ' — must normalize to TR100432.",
        greeting="merhaba",
        category="return",
        subcategory="doesnt_fit",
        answers={
            "order_number": Answer("text", "  #tr-100 432 "),
            "item_ref": Answer("text", "blue slim fit shirt, size M"),
            "reason": Answer("list", "wrong_size"),
            "condition": Answer("text", "unworn_tags_on"),
        },
    ),
    Preset(
        id="photo_flow",
        label="Photo flow",
        description="Damaged item — exercises the required photo field with a fake media upload.",
        greeting="hello",
        category="wrong_damaged_missing",
        subcategory="damaged",
        answers={
            "order_number": Answer("text", "TR100432"),
            "item_ref": Answer("text", "red summer dress"),
            "description": Answer("text", "the seam is torn along the back"),
            "photo": Answer("photo", "media.sim.torn-seam"),
        },
    ),
    Preset(
        id="flow_submission",
        label="Flow submission",
        description="Answers a field via a WhatsApp Flow payload (nfm_reply) instead of typing.",
        greeting="hi",
        category="exchange",
        subcategory="different_size",
        answers={
            "order_number": Answer("text", "TR100999"),
            "item_ref": Answer("flow", '{"item_ref":"Chino Trousers — Beige / 32"}'),
            "desired_variant": Answer("text", "34"),
            "reason": Answer("list", "wrong_size"),
        },
    ),
    Preset(
        id="duplicate_replay",
        label="Duplicate replay",
        description="Delivers the same message id twice — one effect expected (idempotency).",
        greeting="hi",
        replay_greeting=True,
    ),
)

REJECTED = (
    "Preset paused: the answer was not accepted. Choose one of the displayed options "
    "or enter a valid answer to continue."
)
NO_ANSWER = "Preset paused: no scripted answer for this question. Choose an option or answer it yourself to continue."
TOO_LONG = "Preset paused after 30 steps. Continue manually or reset the conversation."
MAX_STEPS = 30


def find_preset(preset_id: str) -> Preset | None:
    return next((p for p in PRESETS if p.id == preset_id), None)


def greeting_message(preset: Preset) -> SimulatorMessageInput:
    return SimulatorMessageInput(
        kind="text",
        value=preset.greeting,
        message_id=f"wamid.sim.replay.{uuid.uuid4()}"
        if preset.replay_greeting
        else None,
    )


@dataclass(frozen=True)
class NextStep:
    """Either a message to send (with the state key it answers) or a pause notice."""

    message: SimulatorMessageInput | None = None
    visited_key: str | None = None
    notice: str | None = None


def next_step(
    preset: Preset, session: Mapping[str, Any], visited: frozenset[str]
) -> NextStep:
    """What to send for the question the session is waiting on.

    A question already answered once means the answer was rejected: hand
    control to the user rather than sending it again.
    """
    status = session.get("status")
    key = f"{status}:{session.get('pendingFieldKey') or ''}"
    if key in visited:
        return NextStep(notice=REJECTED)
    choice = (
        preset.category
        if status == "selecting_category"
        else preset.subcategory
        if status == "selecting_subcategory"
        else None
    )
    pending = session.get("pendingFieldKey")
    answer = (
        Answer("list", choice)
        if choice
        else (preset.answers.get(pending) if pending else None)
    )
    if answer is None:
        return NextStep(notice=NO_ANSWER)
    return NextStep(
        message=SimulatorMessageInput(kind=answer.kind, value=answer.value),
        visited_key=key,
    )


Send = Callable[[SimulatorMessageInput], Any]


def play_preset(
    preset: Preset,
    reset: Callable[[], Any],
    send: Send,
    stopped: Callable[[], bool],
    notify: Callable[[str], None],
) -> None:
    """Send each scripted answer once; a rejected answer hands control to the user.

    `send` and `reset` return a SimulatorResponse-like object (with `error`,
    `completed_case` and `session`) or None.
    """
    reset_response = reset()
    if reset_response is None or reset_response.error or stopped():
        return
    greeting = greeting_message(preset)
    last = send(greeting)
    if last is None or last.error or stopped():
        return
    if preset.replay_greeting:
        send(greeting)
        return
    visited: set[str] = set()
    for _ in range(MAX_STEPS):
        if stopped():
            break
        if last is None or last.error or last.completed_case or not last.session:
            return
        step = next_step(preset, last.session, frozenset(visited))
        if step.message is None:
            notify(step.notice or NO_ANSWER)
            return
        assert step.visited_key is not None
        visited.add(step.visited_key)
        last = send(step.message)
    if not stopped() and last is not None and last.session:
        notify(TOO_LONG)
