"""Port of config/forms.test.ts and config/keys.test.ts."""

from __future__ import annotations

from chicchat.domain.config.forms import (
    FieldInput,
    NamedInput,
    PolicyInput,
    parse_field,
    parse_named,
    parse_policy,
    parse_rule,
)
from chicchat.domain.config.keys import is_valid_key, slugify_key
from chicchat.domain.result import Err, Ok


def test_accepts_a_complete_policy() -> None:
    result = parse_policy(
        {
            "return_window_days": "45",
            "refund_sla_days": "21",
            "nudge_after_minutes": "10",
            "abandon_after_hours": "48",
            "retention_months": "6",
            "kvkk_url": "https://example.com/kvkk",
            "order_id_regex": "^[A-Z0-9]{4,}$",
        }
    )
    assert result == Ok(
        PolicyInput(
            return_window_days=45,
            refund_sla_days=21,
            nudge_after_minutes=10,
            abandon_after_hours=48,
            retention_months=6,
            kvkk_url="https://example.com/kvkk",
            order_id_regex="^[A-Z0-9]{4,}$",
        )
    )


def test_falls_back_to_defaults_for_blank_numbers() -> None:
    result = parse_policy({})
    assert isinstance(result, Ok)
    assert result.value.return_window_days == 30
    assert result.value.nudge_after_minutes == 5
    assert result.value.kvkk_url is None


def test_rejects_nonsense_values() -> None:
    assert not parse_policy({"return_window_days": "-3"}).ok
    assert not parse_policy({"nudge_after_minutes": "0"}).ok
    assert not parse_policy({"kvkk_url": "not-a-url"}).ok
    assert not parse_policy({"order_id_regex": "[unclosed"}).ok


def test_derives_a_key_from_the_label() -> None:
    assert parse_named({"label": "Kargo Hasarlı"}, "category") == Ok(
        NamedInput(key="kargo_hasarli", label="Kargo Hasarlı", sort_order=0)
    )


def test_prefers_an_explicit_key_but_still_normalizes_it() -> None:
    result = parse_named({"label": "Damaged", "key": "My Key"}, "category")
    assert isinstance(result, Ok) and result.value.key == "my_key"


def test_requires_a_label_and_a_derivable_key() -> None:
    assert parse_named({}, "category") == Err("category label is required")
    assert not parse_named({"label": "!!!"}, "subcategory").ok


def test_parses_an_enum_field_with_values_given_one_per_line() -> None:
    result = parse_field(
        {
            "label": "Damage type",
            "type": "enum",
            "required": "on",
            "enum_values": "Torn seam\nStain\nBroken zip",
            "sort_order": "20",
        }
    )
    assert result == Ok(
        FieldInput(
            key="damage_type",
            label="Damage type",
            type="enum",
            required=True,
            enum_values=["torn_seam", "stain", "broken_zip"],
            normalize_rule=None,
            sort_order=20,
        )
    )


def test_also_accepts_comma_separated_enum_values() -> None:
    result = parse_field({"label": "Size", "type": "enum", "enum_values": "S, M, L"})
    assert isinstance(result, Ok)
    assert result.value.enum_values == ["s", "m", "l"]
    assert result.value.required is False


def test_rejects_more_than_ten_enum_values() -> None:
    many = ",".join(f"v{i}" for i in range(11))
    assert parse_field({"label": "x", "type": "enum", "enum_values": many}) == Err(
        "an enum field can offer at most 10 values"
    )


def test_rejects_an_unknown_type_or_an_unusable_key() -> None:
    assert not parse_field({"label": "x", "type": "wizard"}).ok
    assert not parse_field({"label": "???", "type": "string"}).ok


def test_parses_a_routing_rule_with_a_json_condition() -> None:
    result = parse_rule(
        {
            "label": "Damaged goes to priority",
            "action_type": "route",
            "target_queue": "priority_replacements",
            "priority": "high",
            "condition": '{"all":[{"field":"subcategory","op":"eq","value":"damaged"}]}',
        }
    )
    assert isinstance(result, Ok)
    assert result.value.action_type == "route"
    assert result.value.condition == {
        "all": [{"field": "subcategory", "op": "eq", "value": "damaged"}]
    }


def test_defaults_to_an_always_match_condition() -> None:
    result = parse_rule({"action_type": "auto_reply"})
    assert isinstance(result, Ok) and result.value.condition == {"all": []}


def test_carries_the_evaluation_order_since_first_match_wins() -> None:
    result = parse_rule({"action_type": "auto_reply", "sort_order": "3"})
    assert isinstance(result, Ok) and result.value.sort_order == 3
    assert parse_rule({"action_type": "auto_reply", "sort_order": "-1"}) == Err(
        "sort_order must be a non-negative number"
    )


def test_rejects_a_priority_outside_high_normal_low() -> None:
    assert parse_rule({"action_type": "auto_reply", "priority": "urgent"}) == Err(
        "priority must be one of high|normal|low"
    )


def test_requires_a_queue_for_route_escalate_and_valid_json() -> None:
    assert parse_rule({"action_type": "route"}) == Err("route needs a target queue")
    assert not parse_rule({"action_type": "auto_reply", "condition": "{oops"}).ok
    assert not parse_rule({"action_type": "teleport"}).ok


def test_rejects_deeply_nested_json_without_crashing() -> None:
    deep = "[" * 100_000 + "]" * 100_000
    assert not parse_rule({"action_type": "auto_reply", "condition": deep}).ok


def test_rejects_nan_and_infinity_like_json_parse() -> None:
    result = parse_rule(
        {
            "action_type": "auto_reply",
            "condition": '{"field":"x","op":"eq","value":NaN}',
        }
    )
    assert result == Err("condition must be valid JSON")


# --- keys ---------------------------------------------------------------------------


def test_turns_a_label_into_snake_case() -> None:
    assert slugify_key("Return request") == "return_request"
    assert slugify_key("Wrong / damaged / missing item") == "wrong_damaged_missing_item"


def test_transliterates_turkish_characters_instead_of_dropping_them() -> None:
    assert slugify_key("İade Talebi") == "iade_talebi"
    assert slugify_key("Kargo Şikâyeti") == "kargo_sikayeti"
    assert slugify_key("Ödeme sorunu") == "odeme_sorunu"


def test_trims_separators_and_caps_length() -> None:
    assert slugify_key("  --hello--  ") == "hello"
    assert len(slugify_key("a" * 80)) == 60


def test_returns_an_empty_string_when_there_is_nothing_usable() -> None:
    assert slugify_key("!!!") == ""
    assert slugify_key("") == ""


def test_accepts_snake_case_keys_starting_with_a_letter() -> None:
    assert is_valid_key("return_request")
    assert is_valid_key("a1")


def test_rejects_empty_leading_digit_or_punctuated_keys() -> None:
    assert not is_valid_key("")
    assert not is_valid_key("1abc")
    assert not is_valid_key("has space")
    assert not is_valid_key("Has_Upper")


# --- golden -------------------------------------------------------------------------

from tests.golden import assert_golden, ts_json  # noqa: E402


def test_matches_the_typescript_implementation() -> None:
    assert (
        assert_golden(
            "config",
            {
                "slugifyKey": slugify_key,
                "isValidKey": is_valid_key,
                "parseNamed": lambda v, what: ts_json(parse_named(v, what)),
                "parseField": lambda v: ts_json(parse_field(v)),
                "parsePolicy": lambda v: ts_json(parse_policy(v)),
                "parseRule": lambda v: ts_json(parse_rule(v)),
            },
        )
        > 300
    )
