"""The intake state machine — taxonomy-driven, Tier-0, framework-free, plus a
local message simulator for driving it without WhatsApp.
"""

from chicchat.domain.intake.inactivity import (
    InactivityAction,
    InactivityThresholds,
    SessionTiming,
    inactivity_action,
)
from chicchat.domain.intake.machine import advance, start_intake
from chicchat.domain.intake.simulator import (
    SimulationResult,
    SimulationScript,
    simulate_intake,
)
from chicchat.domain.intake.types import (
    CategoryDef,
    FieldDef,
    IntakeCase,
    IntakeConfig,
    IntakeSession,
    IntakeState,
    Option,
    Prompt,
)

__all__ = [
    "CategoryDef",
    "FieldDef",
    "InactivityAction",
    "InactivityThresholds",
    "IntakeCase",
    "IntakeConfig",
    "IntakeSession",
    "IntakeState",
    "Option",
    "Prompt",
    "SessionTiming",
    "SimulationResult",
    "SimulationScript",
    "advance",
    "inactivity_action",
    "simulate_intake",
    "start_intake",
]
