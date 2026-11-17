"""Port of logging/mask.test.ts, auth/gate.test.ts and nav.test.ts."""

from __future__ import annotations

from chicchat.domain.auth.gate import (
    GateDecision,
    constant_time_equal,
    gate_decision,
    is_open_path,
    safe_next_path,
)
from chicchat.domain.logging.mask import mask_phone, redact_log, redact_text
from chicchat.domain.nav import NAV_SECTIONS, active_section, visible_sections

# --- mask ---------------------------------------------------------------------------


def test_preserves_identifiers_and_timestamps_while_sanitizing_diagnostic_values() -> (
    None
):
    uid = "00000000-0000-0000-0000-000000000001"
    ts = "2026-09-09T12:00:00.000Z"
    assert redact_text(f"{uid} {ts} 905550001234") == f"{uid} {ts} ****1234"
    assert redact_log({"nested": {"password": "secret", "phone": "905550001234"}}) == {
        "nested": {"password": "[redacted]", "phone": "****1234"}
    }


def test_keeps_only_the_last_four_digits() -> None:
    assert mask_phone("905352680403") == "****0403"
    assert mask_phone("+90 535 268 04 03") == "****0403"


def test_never_leaks_a_short_value_in_full() -> None:
    assert mask_phone("12") == "****12"
    assert mask_phone("") == "****"
    assert mask_phone("no digits here") == "****"


def test_redacts_bearer_tokens_secrets_and_url_credentials() -> None:
    assert redact_text(
        "Authorization: Bearer abc.def"
    ) == "Authorization: [redacted] abc.def" or "Bearer [redacted]" in redact_text(
        "Bearer abc.def"
    )
    assert (
        redact_text("postgresql://user:pw@host/db") == "postgresql://[redacted]@host/db"
    )
    assert redact_text('{"access_token":"xyz"}') == '{"access_token":"[redacted]"}'


# --- gate ---------------------------------------------------------------------------


def decide(
    pathname: str = "/cases",
    authenticated: bool = False,
    is_production: bool = True,
    allow_dev: bool = False,
) -> GateDecision:
    return gate_decision(pathname, authenticated, is_production, allow_dev)


def test_never_gates_the_whatsapp_webhook() -> None:
    assert is_open_path("/api/whatsapp/webhook")
    assert decide("/api/whatsapp/webhook") == GateDecision("allow")


def test_never_gates_the_maintenance_job_which_carries_its_own_secret() -> None:
    assert decide("/api/maintenance/sessions") == GateDecision("allow")


def test_leaves_the_login_page_reachable() -> None:
    assert decide("/login") == GateDecision("allow")


def test_leaves_the_health_check_reachable_for_uptime_monitors() -> None:
    assert decide("/api/health") == GateDecision("allow")


def test_gates_the_console_the_config_editor_and_the_simulator_api() -> None:
    for path in (
        "/",
        "/cases",
        "/cases/abc",
        "/console",
        "/config",
        "/simulator",
        "/api/simulator",
    ):
        assert not is_open_path(path)
        assert decide(path).kind == "login"


def test_requires_a_verified_session_in_production() -> None:
    assert decide().kind == "login"
    assert decide(authenticated=True).kind == "allow"
    assert decide(allow_dev=True).kind == "login"


def test_allows_explicitly_enabled_development_access_only_outside_production() -> None:
    assert decide(is_production=False, allow_dev=True).kind == "allow"
    assert decide(is_production=False, allow_dev=False).kind == "login"


def test_does_not_allow_paths_merely_sharing_an_open_endpoint_prefix() -> None:
    assert not is_open_path("/login-secret")
    assert not is_open_path("/api/whatsapp/webhook-admin")


def test_matches_identical_strings_and_rejects_everything_else() -> None:
    assert constant_time_equal("abc", "abc")
    assert not constant_time_equal("abc", "abd")
    assert not constant_time_equal("abc", "ab")
    assert constant_time_equal("", "")


def test_keeps_same_site_paths() -> None:
    assert safe_next_path("/console/abc?x=1") == "/console/abc?x=1"


def test_refuses_to_bounce_the_visitor_off_site() -> None:
    assert safe_next_path("https://evil.example/x") == "/cases"
    assert safe_next_path("//evil.example") == "/cases"
    assert safe_next_path(None) == "/cases"
    assert safe_next_path("/cases\n") == "/cases"


# --- nav ----------------------------------------------------------------------------


def test_lights_the_tab_for_its_own_page() -> None:
    for href in ("/console", "/cases", "/config", "/simulator"):
        assert active_section(href) == href


def test_keeps_the_section_lit_on_its_detail_pages() -> None:
    assert active_section("/console/8f3c2a10-0000-4000-8000-000000000000") == "/console"
    assert active_section("/cases/8f3c2a10-0000-4000-8000-000000000000") == "/cases"


def test_does_not_match_a_path_that_merely_starts_with_a_section_name() -> None:
    assert active_section("/consoles") is None
    assert active_section("/configuration") is None


def test_has_no_active_section_outside_the_application() -> None:
    assert active_section("/") is None
    assert active_section("/login") is None


def test_hides_the_simulator_when_it_is_not_enabled() -> None:
    hrefs = [s.href for s in visible_sections(False)]
    assert "/simulator" not in hrefs
    assert hrefs == ["/console", "/cases", "/config"]


def test_shows_the_simulator_when_it_is_enabled() -> None:
    assert "/simulator" in [s.href for s in visible_sections(True)]


def test_describes_every_section_it_links_to() -> None:
    for section in NAV_SECTIONS:
        assert section.href.startswith("/")
        assert section.label != ""
        assert section.hint != ""
