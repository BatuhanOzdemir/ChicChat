"""The taxonomy-driven intake state machine — port of intake/machine.ts.

Pure and framework-free: `start_intake` returns the first prompt; `advance`
folds one inbound message into the state and returns the next prompt. It only
ever asks for *missing required* fields (§0.4), normalizes captured values via
the normalization layer, re-asks on invalid input, and assembles a clean
Tier-0 case.

States are never mutated: every step returns new dicts. Keys TypeScript set to
`undefined` are removed (`_without`), so the stored JSON is identical.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any, cast

from chicchat.domain.intake.types import (
    CapturedField,
    CaseField,
    CategoryDef,
    FieldDef,
    IntakeCase,
    IntakeConfig,
    IntakeSession,
    IntakeState,
    Option,
    Prompt,
)
from chicchat.domain.jscompat import js_number, js_slice, js_trim
from chicchat.domain.normalize import (
    constrain_enum,
    normalize_order_number,
    normalize_text,
)

_SEPARATORS = re.compile(r"[_-]+")
_DIGITS = re.compile(r"[0-9]+")


def _with(state: IntakeState, **changes: Any) -> IntakeState:
    """`{ ...state, ...changes }` — a copy with some keys replaced."""
    return cast(IntakeState, {**state, **changes})


def _without(state: IntakeState, *keys: str) -> IntakeState:
    """`{ ...state, key: undefined }` — JSON.stringify drops those keys."""
    return cast(IntakeState, {k: v for k, v in state.items() if k not in keys})


def _find_category(config: IntakeConfig, key: str | None) -> CategoryDef | None:
    """None rather than raising: a live session can outlive the category it
    selected (the merchant may disable or rename it mid-conversation), and the
    machine recovers by asking again instead of failing the conversation.
    """
    return next((c for c in config["categories"] if c["key"] == key), None)


def _option_for_value(value: str) -> Option:
    """Turn an enum value into a readable label ("store_credit" → "Store credit")."""
    words = js_trim(_SEPARATORS.sub(" ", value))
    # charAt(0).toUpperCase() + slice(1): by UTF-16 unit, as JavaScript does.
    return {"key": value, "label": js_slice(words, 0, 1).upper() + js_slice(words, 1)}


def _has_values(field: FieldDef) -> bool:
    values = field.get("enumValues")
    return field["type"] == "enum" and bool(values)


def _field_prompt(field: FieldDef, retry: bool) -> Prompt:
    """Enum fields with configured values are always a tappable list (SPEC §5)."""
    if _has_values(field):
        return {
            "kind": "select_field",
            "field": field,
            "options": [_option_for_value(v) for v in field.get("enumValues") or []],
            "retry": retry,
        }
    return {"kind": "request_field", "field": field, "retry": retry}


def _category_options(config: IntakeConfig) -> list[Option]:
    return [{"key": c["key"], "label": c["label"]} for c in config["categories"]]


def _category_prompt(
    config: IntakeConfig, state: IntakeState, retry: bool
) -> IntakeSession:
    """A fresh category selection, used to start and to recover."""
    cleared = _without(state, "categoryKey", "subcategoryKey", "pendingFieldKey")
    return {
        "state": _with(cleared, status="selecting_category"),
        "prompt": {
            "kind": "select_category",
            "options": _category_options(config),
            "retry": retry,
        },
    }


def _is_collected(fields: Mapping[str, CapturedField], key: str) -> bool:
    captured = fields.get(key)
    return captured is not None and captured.get("valid") is True


def _match_option(message: str, options: list[Option]) -> Option | None:
    """Match an inbound message to a list option by index, key, or label (lenient)."""
    trimmed = js_trim(message)
    if trimmed == "":
        return None
    if _DIGITS.fullmatch(trimmed):
        index = js_number(trimmed) - 1
        if 0 <= index < len(options):
            return options[int(index)]
    lower = trimmed.lower()
    for option in options:
        key = option["key"].lower()
        label = option["label"].lower()
        if key == lower or label == lower or lower in label:
            return option
    return None


def _normalize_field(
    field: FieldDef, message: str, config: IntakeConfig
) -> CapturedField:
    """Normalize a captured value per the field's rule/type."""
    if field.get("normalizeRule") == "order_number":
        order = normalize_order_number(message, pattern=config.get("orderIdRegex"))
        return {"raw": message, "normalized": order.normalized, "valid": order.valid}
    if _has_values(field):
        choice = constrain_enum(message, field.get("enumValues") or [])
        return {"raw": message, "normalized": choice.normalized, "valid": choice.valid}
    # ref (Tier-0 text, §6.4), media reference, free-text enum, and string.
    text = normalize_text(message)
    return {
        "raw": message,
        "normalized": None if text == "" else text,
        "valid": text != "",
    }


def _assemble(cat: CategoryDef, state: IntakeState) -> IntakeCase:
    fields: list[CaseField] = [
        {
            "key": fd["key"],
            "raw": state["fields"][fd["key"]]["raw"],
            "normalized": state["fields"][fd["key"]]["normalized"],
        }
        for fd in cat["fields"]
        if _is_collected(state["fields"], fd["key"])
    ]
    return {
        "category": cat["key"],
        "subcategory": state.get("subcategoryKey"),
        "integration_tier": 0,
        "fields": fields,
    }


def _fold_initial_fields(
    cat: CategoryDef, state: IntakeState, config: IntakeConfig
) -> IntakeState:
    """Fold classifier-extracted raw values into the captured set, once."""
    if len(state["pendingInitial"]) == 0:
        return _with(state, pendingInitial={})
    fields = dict(state["fields"])
    for fd in cat["fields"]:
        raw = state["pendingInitial"].get(fd["key"])
        if raw is not None and not _is_collected(fields, fd["key"]):
            captured = _normalize_field(fd, raw, config)
            if captured["valid"]:
                fields[fd["key"]] = captured
    return _with(state, fields=fields, pendingInitial={})


def _collect_fields(
    config: IntakeConfig, cat: CategoryDef, state: IntakeState
) -> IntakeSession:
    """Ask for the next missing required field, or complete the case."""
    folded = _fold_initial_fields(cat, state, config)
    pending = next(
        (
            fd
            for fd in cat["fields"]
            if fd["required"] and not _is_collected(folded["fields"], fd["key"])
        ),
        None,
    )
    if pending is not None:
        return {
            "state": _with(folded, pendingFieldKey=pending["key"]),
            "prompt": _field_prompt(pending, False),
        }
    complete = _with(_without(folded, "pendingFieldKey"), status="complete")
    return {
        "state": complete,
        "prompt": {"kind": "complete", "case": _assemble(cat, complete)},
    }


def _proceed(config: IntakeConfig, state: IntakeState) -> IntakeSession:
    """Decide what to ask next given the current (already-transitioned) state."""
    if state["status"] == "selecting_category":
        return _category_prompt(config, state, False)
    cat = _find_category(config, state.get("categoryKey"))
    # The selected category disappeared (disabled/renamed) — recover, don't fail.
    if cat is None:
        return _category_prompt(config, state, True)
    if state["status"] == "selecting_subcategory":
        return {
            "state": state,
            "prompt": {
                "kind": "select_subcategory",
                "category": cat["key"],
                "options": cat["subcategories"],
                "retry": False,
            },
        }
    return _collect_fields(config, cat, state)


def start_intake(
    config: IntakeConfig, initial_fields: Mapping[str, str] | None = None
) -> IntakeSession:
    """Begin an intake session. `initial_fields` are raw values a classifier extracted."""
    state: IntakeState = {
        "status": "selecting_category",
        "fields": {},
        "pendingInitial": dict(initial_fields or {}),
    }
    session = _proceed(config, state)
    # The KVKK disclosure belongs to the first message of a *new conversation*
    # (SPEC §12), which is precisely here and nowhere else. `_category_prompt`
    # is also how the machine recovers mid-conversation — after unrecognized
    # input, or when the merchant disables the category a live session had
    # chosen — and repeating the notice on every stumble would train customers
    # to ignore it.
    prompt = session["prompt"]
    kvkk_url = config.get("kvkkUrl")
    if prompt["kind"] == "select_category" and kvkk_url:
        return {"state": session["state"], "prompt": {**prompt, "disclosure": kvkk_url}}
    return session


def _pick_category(
    config: IntakeConfig, state: IntakeState, message: str
) -> IntakeSession:
    option = _match_option(message, _category_options(config))
    if option is None:
        return _category_prompt(config, state, True)
    cat = _find_category(config, option["key"])
    if cat is None:
        return _category_prompt(config, state, True)
    status = (
        "selecting_subcategory"
        if len(cat["subcategories"]) > 0
        else "collecting_fields"
    )
    return _proceed(config, _with(state, categoryKey=cat["key"], status=status))


def _pick_subcategory(
    config: IntakeConfig, cat: CategoryDef, state: IntakeState, message: str
) -> IntakeSession:
    option = _match_option(message, cat["subcategories"])
    if option is None:
        return {
            "state": state,
            "prompt": {
                "kind": "select_subcategory",
                "category": cat["key"],
                "options": cat["subcategories"],
                "retry": True,
            },
        }
    return _proceed(
        config, _with(state, subcategoryKey=option["key"], status="collecting_fields")
    )


def _capture_field(
    config: IntakeConfig, cat: CategoryDef, state: IntakeState, message: str
) -> IntakeSession:
    pending_key = state.get("pendingFieldKey")
    field = next((f for f in cat["fields"] if f["key"] == pending_key), None)
    if field is None:
        return _proceed(config, state)
    captured = _normalize_field(field, message, config)
    updated = _with(state, fields={**state["fields"], field["key"]: captured})
    if not captured["valid"]:
        return {"state": updated, "prompt": _field_prompt(field, True)}
    return _proceed(config, updated)


def advance(config: IntakeConfig, state: IntakeState, message: str) -> IntakeSession:
    """Fold one inbound message into the session and return the next prompt."""
    if state["status"] == "selecting_category":
        return _pick_category(config, state, message)
    cat = _find_category(config, state.get("categoryKey"))
    # The selected category disappeared mid-conversation — ask again.
    if cat is None:
        return _category_prompt(config, state, True)
    status = state["status"]
    if status == "selecting_subcategory":
        return _pick_subcategory(config, cat, state, message)
    if status == "collecting_fields":
        return _capture_field(config, cat, state, message)
    if status == "complete":
        return {
            "state": state,
            "prompt": {"kind": "complete", "case": _assemble(cat, state)},
        }
    # TypeScript fell off its switch here and failed in the caller.
    raise ValueError(f"unknown intake status {status!r}")
