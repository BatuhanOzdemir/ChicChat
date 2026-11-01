"""HTTP surface tests: ports of route.test.ts plus every row of docs/PORT.md §2."""

from __future__ import annotations

import hashlib
import hmac
import json
from typing import Any

import pytest
from fastapi.testclient import TestClient

from chicchat.domain.result import Ok
from chicchat.server.simulator import SimulatorResponse
from chicchat.web.routes import api
from tests.web.conftest import FakeDatabase, csrf

SECRET = "app-secret"


def signed(body: bytes) -> dict[str, str]:
    return {
        "x-hub-signature-256": "sha256="
        + hmac.new(SECRET.encode(), body, hashlib.sha256).hexdigest()
    }


# --- WhatsApp webhook ---------------------------------------------------------------


def test_echoes_the_handshake_challenge_and_refuses_a_wrong_token(
    client: TestClient, env: pytest.MonkeyPatch
) -> None:
    env.setenv("WHATSAPP_VERIFY_TOKEN", "verify-me")
    ok = client.get(
        "/api/whatsapp/webhook",
        params={
            "hub.mode": "subscribe",
            "hub.verify_token": "verify-me",
            "hub.challenge": "42",
        },
    )
    assert (ok.status_code, ok.text) == (200, "42")
    bad = client.get(
        "/api/whatsapp/webhook",
        params={
            "hub.mode": "subscribe",
            "hub.verify_token": "nope",
            "hub.challenge": "42",
        },
    )
    assert (bad.status_code, bad.text) == (403, "forbidden")


def test_does_not_acknowledge_before_durable_acceptance_completes(
    client: TestClient, env: pytest.MonkeyPatch
) -> None:
    env.setenv("WHATSAPP_APP_SECRET", SECRET)
    order: list[str] = []
    env.setattr(
        api,
        "parse_inbound",
        lambda _b: [
            {"phoneNumberId": "123", "from": "905550001234", "messageId": "m-1"}
        ],
    )
    env.setattr(
        api,
        "resolve_merchant_by_phone_number_id",
        lambda _db, _id: type("C", (), {"merchant_id": "merchant"})(),
    )
    env.setattr(api, "accept_messages", lambda _db, _m: order.append("accepted"))
    env.setattr(
        api,
        "process_inbox_after_response",
        lambda _db: order.append("processed after response"),
    )
    body = b"{}"
    response = client.post("/api/whatsapp/webhook", content=body, headers=signed(body))
    assert response.status_code == 200
    assert order == ["accepted", "processed after response"]


def test_requests_redelivery_when_the_durable_inbox_cannot_accept_work(
    client: TestClient, env: pytest.MonkeyPatch
) -> None:
    env.setenv("WHATSAPP_APP_SECRET", SECRET)
    processed: list[str] = []
    env.setattr(api, "parse_inbound", lambda _b: [])

    def offline(_db: Any, _m: Any) -> None:
        raise RuntimeError("database offline")

    env.setattr(api, "accept_messages", offline)
    env.setattr(api, "process_inbox_after_response", lambda _db: processed.append("x"))
    body = b"{}"
    response = client.post("/api/whatsapp/webhook", content=body, headers=signed(body))
    assert response.status_code == 503
    assert processed == []


@pytest.mark.parametrize("header", [None, "sha256=deadbeef", "sha256=zz", "sha1=abc"])
def test_rejects_a_missing_tampered_or_malformed_signature(
    client: TestClient, env: pytest.MonkeyPatch, header: str | None
) -> None:
    env.setenv("WHATSAPP_APP_SECRET", SECRET)
    headers = {"x-hub-signature-256": header} if header else {}
    response = client.post("/api/whatsapp/webhook", content=b"{}", headers=headers)
    assert (response.status_code, response.text) == (401, "invalid signature")


def test_verifies_the_signature_over_the_raw_bytes(
    client: TestClient, env: pytest.MonkeyPatch
) -> None:
    env.setenv("WHATSAPP_APP_SECRET", SECRET)
    env.setattr(api, "accept_messages", lambda _db, _m: None)
    env.setattr(api, "process_inbox_after_response", lambda _db: None)
    raw = '{"entry":  [], "x": "İ"}'.encode()
    assert (
        client.post(
            "/api/whatsapp/webhook", content=raw, headers=signed(raw)
        ).status_code
        == 200
    )
    reserialized = json.dumps(json.loads(raw)).encode()
    assert (
        client.post(
            "/api/whatsapp/webhook", content=reserialized, headers=signed(raw)
        ).status_code
        == 401
    )


def test_logs_and_drops_malformed_json_with_200(
    client: TestClient, env: pytest.MonkeyPatch
) -> None:
    env.setenv("WHATSAPP_APP_SECRET", SECRET)
    body = b"{not json"
    response = client.post("/api/whatsapp/webhook", content=body, headers=signed(body))
    assert (response.status_code, response.text) == (200, "ok")


def test_production_rejects_webhooks_when_no_app_secret_is_configured(
    client: TestClient,
) -> None:
    # CHICCHAT_ENV is unset: production is the default (PORT.md P1).
    assert client.post("/api/whatsapp/webhook", content=b"{}").status_code == 401


def test_development_may_skip_signature_verification(
    client: TestClient, env: pytest.MonkeyPatch
) -> None:
    env.setenv("CHICCHAT_ENV", "development")
    env.setattr(api, "accept_messages", lambda _db, _m: None)
    env.setattr(api, "process_inbox_after_response", lambda _db: None)
    assert client.post("/api/whatsapp/webhook", content=b"{}").status_code == 200


# --- Maintenance ---------------------------------------------------------------------

SUMMARY = {
    "nudged": 0,
    "abandoned": 0,
    "deleted": 0,
    "failed": 0,
    "inbox": {"processed": 0, "failed": 0},
    "replies": {"sent": 0, "failed": 0},
    "deletedRecords": 0,
}


@pytest.mark.parametrize("method", ["GET", "POST"])
def test_maintenance_needs_the_bearer_secret(
    client: TestClient, env: pytest.MonkeyPatch, method: str
) -> None:
    env.setenv("MAINTENANCE_SECRET", "s3cret")
    env.setattr(api, "_run_maintenance", lambda: SUMMARY)
    assert client.request(method, "/api/maintenance/sessions").status_code == 401
    assert (
        client.request(
            method,
            "/api/maintenance/sessions",
            headers={"authorization": "Bearer wrong"},
        ).status_code
        == 401
    )
    ok = client.request(
        method, "/api/maintenance/sessions", headers={"authorization": "Bearer s3cret"}
    )
    assert ok.status_code == 200
    assert ok.json() == SUMMARY
    assert list(ok.json()) == list(SUMMARY)


def test_maintenance_accepts_cron_secret_too(
    client: TestClient, env: pytest.MonkeyPatch
) -> None:
    env.setenv("CRON_SECRET", "cron")
    env.setattr(api, "_run_maintenance", lambda: SUMMARY)
    assert (
        client.get(
            "/api/maintenance/sessions", headers={"authorization": "Bearer cron"}
        ).status_code
        == 200
    )


def test_maintenance_without_a_secret_is_refused_in_production_allowed_locally(
    client: TestClient, env: pytest.MonkeyPatch
) -> None:
    env.setattr(api, "_run_maintenance", lambda: SUMMARY)
    assert client.post("/api/maintenance/sessions").status_code == 401
    env.setenv("CHICCHAT_ENV", "development")
    assert client.post("/api/maintenance/sessions").status_code == 200


def test_maintenance_failure_is_a_500_with_no_detail(
    client: TestClient, env: pytest.MonkeyPatch
) -> None:
    env.setenv("MAINTENANCE_SECRET", "s3cret")

    def broken() -> dict[str, Any]:
        raise RuntimeError("password=hunter2 leaked?")

    env.setattr(api, "_run_maintenance", broken)
    response = client.post(
        "/api/maintenance/sessions", headers={"authorization": "Bearer s3cret"}
    )
    assert (response.status_code, response.json()) == (
        500,
        {"error": "maintenance failed"},
    )


# --- Health ---------------------------------------------------------------------------


def test_health_reports_only_whether_the_database_answers(
    client: TestClient, fake_db: FakeDatabase
) -> None:
    assert client.get("/api/health").json() == {
        "ok": True,
        "database": "up",
        "warnings": 1,
    }
    fake_db.healthy = False
    response = client.get("/api/health")
    assert (response.status_code, response.json()) == (
        503,
        {"ok": False, "database": "unreachable", "warnings": 1},
    )


# --- Login gate (middleware.ts) -------------------------------------------------------


@pytest.mark.parametrize(
    "path", ["/", "/cases", "/console/abc", "/config", "/simulator"]
)
def test_production_sends_a_signed_out_visitor_to_login(
    client: TestClient, path: str
) -> None:
    response = client.get(path, follow_redirects=False)
    assert response.status_code == 307
    assert response.headers["location"].startswith("/login?next=")


def test_open_paths_are_never_gated(client: TestClient) -> None:
    for path in ("/api/health", "/login"):
        assert client.get(path, follow_redirects=False).status_code == 200


def test_the_gate_answers_503_when_it_cannot_check_sessions(
    client: TestClient, env: pytest.MonkeyPatch
) -> None:
    def broken(_request: Any) -> bool:
        raise RuntimeError("db down")

    env.setattr("chicchat.web.app._authenticated", broken)
    response = client.get("/cases", follow_redirects=False)
    assert (response.status_code, response.text) == (
        503,
        "Authentication temporarily unavailable",
    )


# --- Simulator API (route.test.ts) ----------------------------------------------------


def simulator_post(client: TestClient, body: dict[str, Any]) -> Any:
    return client.post(
        "/api/simulator", json=body, headers={"x-csrf-token": csrf(client)}
    )


BODY = {"action": "state", "merchantId": "other", "phone": "905550001234"}


def as_principal(env: pytest.MonkeyPatch, merchant_ids: list[str] | None) -> None:
    from chicchat.db.auth import Principal
    from chicchat.web import deps

    principal = None if merchant_ids is None else Principal("u", "user", merchant_ids)
    env.setattr(deps, "current_principal", lambda _r: principal)
    env.setattr("chicchat.web.app._authenticated", lambda _r: principal is not None)


def test_checks_merchant_membership_and_rejects_forged_tenant_selection(
    client: TestClient, env: pytest.MonkeyPatch
) -> None:
    env.setenv("SIMULATOR_ENABLED", "true")
    as_principal(env, ["own"])
    ran: list[Any] = []
    env.setattr(api, "run_simulator_action", lambda *a: ran.append(a))
    assert simulator_post(client, BODY).status_code == 403
    assert ran == []


def test_rejects_an_unauthenticated_request_even_if_the_gate_is_bypassed(
    client: TestClient, env: pytest.MonkeyPatch
) -> None:
    env.setenv("SIMULATOR_ENABLED", "true")
    env.setattr("chicchat.web.app.is_open_path", lambda _p: True)
    ran: list[Any] = []
    env.setattr(api, "run_simulator_action", lambda *a: ran.append(a))
    assert simulator_post(client, BODY).status_code == 403
    assert ran == []


def test_keeps_the_console_selection_aligned_with_an_authorized_simulator_merchant(
    client: TestClient, env: pytest.MonkeyPatch
) -> None:
    env.setenv("SIMULATOR_ENABLED", "true")
    as_principal(env, ["other"])
    env.setattr(api, "run_simulator_action", lambda *_a: SimulatorResponse())
    response = simulator_post(client, BODY)
    assert response.status_code == 200
    cookie = response.headers["set-cookie"].lower()
    assert (
        "chicchat_merchant=other" in cookie
        and "httponly" in cookie
        and "samesite=lax" in cookie
    )


def test_the_simulator_is_absent_in_production_unless_enabled(
    client: TestClient, env: pytest.MonkeyPatch
) -> None:
    as_principal(env, ["other"])
    assert simulator_post(client, BODY).status_code == 404


def test_rejects_invalid_simulator_bodies_with_400(
    client: TestClient, env: pytest.MonkeyPatch
) -> None:
    env.setenv("SIMULATOR_ENABLED", "true")
    as_principal(env, ["other"])
    token = csrf(client)
    bad_json = client.post(
        "/api/simulator",
        content=b"{oops",
        headers={"x-csrf-token": token, "content-type": "application/json"},
    )
    assert (bad_json.status_code, bad_json.json()) == (
        400,
        {"error": "invalid JSON body"},
    )
    assert simulator_post(client, {"action": "nope"}).status_code == 400


# --- Form protection (PORT.md P4) -------------------------------------------------------


def test_state_changing_requests_need_the_form_token(
    client: TestClient, env: pytest.MonkeyPatch
) -> None:
    env.setenv("SIMULATOR_ENABLED", "true")
    as_principal(env, ["other"])
    assert client.post("/api/simulator", json=BODY).status_code == 403
    assert (
        client.post(
            "/api/simulator", json=BODY, headers={"x-csrf-token": "f" * 64}
        ).status_code
        == 403
    )
    assert (
        client.post(
            "/login", data={"username": "a", "passcode": "b"}, follow_redirects=False
        ).status_code
        == 403
    )


def test_cross_site_posts_are_refused_even_with_a_token(
    client: TestClient, env: pytest.MonkeyPatch
) -> None:
    env.setenv("SIMULATOR_ENABLED", "true")
    as_principal(env, ["other"])
    response = client.post(
        "/api/simulator",
        json=BODY,
        headers={"x-csrf-token": csrf(client), "origin": "https://evil.example"},
    )
    assert response.status_code == 403


def test_every_state_changing_route_is_protected() -> None:
    from fastapi.routing import APIRoute

    from chicchat.web.app import create_app
    from chicchat.web.security import CSRF_EXEMPT, verify_csrf

    for route in create_app().routes:
        if not isinstance(route, APIRoute) or not (
            {"POST", "PUT", "PATCH", "DELETE"} & route.methods
        ):
            continue
        if route.path in CSRF_EXEMPT:
            continue
        calls = {d.call for d in route.dependant.dependencies}
        assert verify_csrf in calls, f"{route.path} lacks CSRF protection"


# --- Media ---------------------------------------------------------------------------------


def test_media_route_validates_ids_and_sends_private_headers(
    client: TestClient, env: pytest.MonkeyPatch
) -> None:
    from chicchat.server.merchant import MerchantContext, MerchantOption
    from chicchat.web import deps

    as_principal(env, ["m"])
    merchant = MerchantOption("m", "M", "en", False)
    env.setattr(
        deps, "current_merchant", lambda _r: MerchantContext(merchant, [merchant])
    )
    env.setattr(
        api,
        "case_photo",
        lambda _db, _m, _c, media: {"content": b"png", "mime_type": "image/png"}
        if media == "p1"
        else None,
    )
    case_id = "00000000-0000-0000-0000-000000000002"
    assert client.get("/api/cases/not-a-uuid/media/p1").status_code == 404
    assert client.get(f"/api/cases/{case_id}/media/{'x' * 101}").text == "Not found"
    assert client.get(f"/api/cases/{case_id}/media/missing").text == "Photo unavailable"
    ok = client.get(f"/api/cases/{case_id}/media/p1")
    assert ok.content == b"png"
    assert ok.headers["content-type"] == "image/png"
    assert ok.headers["cache-control"] == "private, no-store"
    assert ok.headers["x-content-type-options"] == "nosniff"
    assert ok.headers["content-security-policy"] == "default-src 'none'; sandbox"


# --- Boot check -------------------------------------------------------------------------------


def test_refuses_to_start_without_a_database_url(env: pytest.MonkeyPatch) -> None:
    from chicchat.web.app import create_app

    env.delenv("DATABASE_URL")
    with pytest.raises(RuntimeError, match="DATABASE_URL"), TestClient(create_app()):
        pass


def test_simulator_preset_step_returns_the_next_scripted_answer(
    client: TestClient, env: pytest.MonkeyPatch
) -> None:
    env.setenv("SIMULATOR_ENABLED", "true")
    as_principal(env, ["other"])
    response = client.post(
        "/api/simulator/preset-step",
        json={
            "presetId": "messy_order_number",
            "session": {"status": "selecting_category"},
            "visited": [],
        },
        headers={"x-csrf-token": csrf(client)},
    )
    assert response.json() == {
        "message": {"kind": "list", "value": "return"},
        "visitedKey": "selecting_category:",
        "notice": None,
    }
    assert isinstance(Ok(1), Ok)
