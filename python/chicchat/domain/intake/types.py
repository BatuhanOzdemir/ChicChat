"""Intake state-machine types (SPEC.md §0.4, §6) — port of intake/types.ts.

Taxonomy-driven: category -> subcategory -> required fields -> case. The config
shapes mirror the seeded taxonomy (categories / subcategories / field_defs).
Tier-0: no integration, so item_ref is captured as text (§6.4).

Everything here is a TypedDict whose keys are exactly the JSON keys the
TypeScript code wrote (`categoryKey`, `pendingInitial`, …): `IntakeState` is
stored in `intake_sessions.state`, and sessions written by the TypeScript
version must keep working (docs/PORT.md P3). A key TypeScript left `undefined`
is *absent* from the dict, never None.
"""

from __future__ import annotations

from typing import Literal, NotRequired, TypedDict

FieldType = Literal["string", "enum", "media", "ref"]


class FieldDef(TypedDict):
    key: str
    type: FieldType
    required: bool
    label: NotRequired[str]
    enumValues: NotRequired[list[str] | None]
    """Allowed values for enum fields; null/empty means free text."""
    normalizeRule: NotRequired[str | None]
    """Named normalization rule, e.g. "order_number"."""


class Option(TypedDict):
    key: str
    label: str


class CategoryDef(TypedDict):
    key: str
    label: str
    subcategories: list[Option]
    fields: list[FieldDef]


class IntakeConfig(TypedDict):
    categories: list[CategoryDef]
    orderIdRegex: NotRequired[str]
    """merchant_config.order_id_regex — applied to order_number fields."""
    kvkkUrl: NotRequired[str]
    """Where the customer can read how their data is handled (SPEC §12)."""


class CapturedField(TypedDict):
    raw: str
    normalized: str | None
    valid: bool


IntakeStatus = Literal[
    "selecting_category", "selecting_subcategory", "collecting_fields", "complete"
]


class IntakeState(TypedDict):
    status: IntakeStatus
    categoryKey: NotRequired[str]
    subcategoryKey: NotRequired[str]
    pendingFieldKey: NotRequired[str]
    """The field key the machine is currently waiting on an answer for."""
    fields: dict[str, CapturedField]
    pendingInitial: dict[str, str]
    """Raw fields pre-extracted by a classifier, folded in once collection starts."""


class CaseField(TypedDict):
    key: str
    raw: str
    normalized: str | None


class IntakeCase(TypedDict):
    """The clean, complete structured case the machine assembles (Tier 0)."""

    category: str
    subcategory: str | None
    integration_tier: Literal[0]
    fields: list[CaseField]


class SelectCategoryPrompt(TypedDict):
    kind: Literal["select_category"]
    options: list[Option]
    retry: bool
    disclosure: NotRequired[str]
    """KVKK disclosure URL, set only on the opening message of a new
    conversation — never on a retry or a mid-conversation recovery."""


class SelectSubcategoryPrompt(TypedDict):
    kind: Literal["select_subcategory"]
    category: str
    options: list[Option]
    retry: bool


class RequestFieldPrompt(TypedDict):
    """Free-form answer (string, media, ref, or an enum with no fixed values)."""

    kind: Literal["request_field"]
    field: FieldDef
    retry: bool


class SelectFieldPrompt(TypedDict):
    """An enum field with configured values: always a tappable list (SPEC §5)."""

    kind: Literal["select_field"]
    field: FieldDef
    options: list[Option]
    retry: bool


class CompletePrompt(TypedDict):
    kind: Literal["complete"]
    case: IntakeCase


Prompt = (
    SelectCategoryPrompt
    | SelectSubcategoryPrompt
    | RequestFieldPrompt
    | SelectFieldPrompt
    | CompletePrompt
)


class IntakeSession(TypedDict):
    state: IntakeState
    prompt: Prompt
