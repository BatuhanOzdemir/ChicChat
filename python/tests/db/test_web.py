"""End-to-end HTTP tests against the real database: sign-in, session cookie,
membership-scoped simulator access, sign-out revocation (PORT.md P4, P5)."""

from __future__ import annotations

import uuid
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from chicchat.db.config import DEMO_MERCHANT_ID
from chicchat.domain.auth.credentials import hash_password
from chicchat.web.app import create_app
from tests.db.conftest import connect, database_url, run_seed

SECOND_MERCHANT_ID = "00000000-0000-0000-0000-000000000003"
PASSWORD = "correct-test-password"


@pytest.fixture
def account(monkeypatch: pytest.MonkeyPatch) -> Iterator[str]:
    monkeypatch.setenv("DATABASE_URL", database_url())
    monkeypatch.delenv("CHICCHAT_ENV", raising=False)  # production behaviour
    monkeypatch.setenv("SIMULATOR_ENABLED", "true")
    run_seed()
    username = f"web-{uuid.uuid4().hex[:12]}"
    with connect() as conn:
        user_id = conn.execute(
            "insert into console_users(username,password_hash) values (%s,%s) returning id",
            [username, hash_password(PASSWORD)],
        ).fetchone()[0]  # type: ignore[index]
        conn.execute(
            "insert into console_memberships values (%s,%s)",
            [user_id, DEMO_MERCHANT_ID],
        )
    try:
        yield username
    finally:
        with connect() as conn:
            conn.execute("delete from console_users where username=%s", [username])
            conn.execute(
                "delete from console_login_attempts where username=%s", [username]
            )
            conn.execute(
                "delete from intake_sessions where customer_wa_id='905559990001'"
            )


def sign_in(client: TestClient, username: str, password: str) -> int:
    client.get("/login")
    response = client.post(
        "/login",
        data={
            "username": username,
            "passcode": password,
            "next": "/simulator",
            "csrf_token": client.cookies["chicchat_csrf"],
        },
        follow_redirects=False,
    )
    return response.status_code


def simulate(client: TestClient, merchant_id: str) -> int:
    response = client.post(
        "/api/simulator",
        json={
            "action": "message",
            "merchantId": merchant_id,
            "phone": "905559990001",
            "message": {"kind": "text", "value": "hi"},
        },
        headers={"x-csrf-token": client.cookies["chicchat_csrf"]},
    )
    return response.status_code


def test_signs_in_scopes_by_membership_and_revokes_on_sign_out(account: str) -> None:
    with TestClient(create_app(), base_url="https://testserver") as client:
        # Signed out: the console is behind the login page.
        assert client.get("/simulator", follow_redirects=False).status_code == 307
        assert sign_in(client, account, "wrong-password") == 303
        assert "chicchat_console" not in client.cookies
        assert sign_in(client, account, PASSWORD) == 303
        cookie = client.cookies["chicchat_console"]
        assert len(cookie) == 64
        # A member may drive their own merchant, never another one.
        assert simulate(client, DEMO_MERCHANT_ID) == 200
        assert simulate(client, SECOND_MERCHANT_ID) == 403
        client.post(
            "/logout",
            data={"csrf_token": client.cookies["chicchat_csrf"]},
            follow_redirects=False,
        )
    with TestClient(
        create_app(),
        base_url="https://testserver",
        cookies={"chicchat_console": cookie},
    ) as stale:
        # The old cookie no longer opens anything after sign-out.
        assert stale.get("/simulator", follow_redirects=False).status_code == 307


def test_the_session_cookie_is_http_only_lax_and_secure_in_production(
    account: str,
) -> None:
    with TestClient(create_app(), base_url="https://testserver") as client:
        client.get("/login")
        response = client.post(
            "/login",
            data={
                "username": account,
                "passcode": PASSWORD,
                "next": "/cases",
                "csrf_token": client.cookies["chicchat_csrf"],
            },
            follow_redirects=False,
        )
        header = response.headers["set-cookie"].lower()
        assert "chicchat_console=" in header
        assert (
            "httponly" in header
            and "samesite=lax" in header
            and "secure" in header
            and "max-age=43200" in header
        )
        assert response.headers["location"] == "/cases"
