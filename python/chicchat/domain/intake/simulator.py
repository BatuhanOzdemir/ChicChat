"""Local message simulator — port of intake/simulator.ts.

Drives the intake machine without WhatsApp. Given a script (which
category/subcategory to pick and an answer per field key), it replays the
conversation, recording every prompt and which fields the machine asked for.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field

from chicchat.domain.intake.machine import advance, start_intake
from chicchat.domain.intake.types import IntakeCase, IntakeConfig, IntakeState, Prompt


@dataclass(frozen=True)
class SimulationScript:
    category: str
    """Category selection message (key, label, or 1-based index)."""
    fields: Mapping[str, str]
    """Answer for each field key the machine may ask for."""
    subcategory: str | None = None
    """Subcategory selection message (omit for categories with none)."""
    initial_fields: Mapping[str, str] = field(default_factory=dict)
    """Fields a classifier already extracted (folded in, never asked)."""


@dataclass(frozen=True)
class SimulationResult:
    prompts: list[Prompt]
    asked: list[str]
    """Field keys the machine requested (in order)."""
    state: IntakeState
    case: IntakeCase | None = None


_MAX_STEPS = 50


def simulate_intake(config: IntakeConfig, script: SimulationScript) -> SimulationResult:
    session = start_intake(config, script.initial_fields)
    prompts: list[Prompt] = [session["prompt"]]
    asked: list[str] = []
    for _ in range(_MAX_STEPS):
        prompt = session["prompt"]
        if prompt["kind"] == "complete":
            return SimulationResult(prompts, asked, session["state"], prompt["case"])
        if prompt["kind"] == "select_category":
            message = script.category
        elif prompt["kind"] == "select_subcategory":
            message = script.subcategory or ""
        else:
            key = prompt["field"]["key"]
            asked.append(key)
            if key not in script.fields:
                break  # no scripted answer -> stop
            message = script.fields[key]
        session = advance(config, session["state"], message)
        prompts.append(session["prompt"])
    last = session["prompt"]
    return SimulationResult(
        prompts,
        asked,
        session["state"],
        last["case"] if last["kind"] == "complete" else None,
    )
