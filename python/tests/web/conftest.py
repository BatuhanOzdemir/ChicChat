"""Fixtures for HTTP tests that run without a database (dependencies faked)."""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from chicchat.web import deps
from chicchat.web.app import create_app


class FakeDatabase:
    """Answers the health check; anything else fails loudly."""

    def __init__(self) -> None:
        self.healthy = True

    def query(self, sql: str, params: Any = ()) -> list[dict[str, Any]]:
        if sql == "select 1":
            if not self.healthy:
                raise RuntimeError("database offline")
            return [{"?column?": 1}]
        raise AssertionError(f"unexpected query in a no-database test: {sql[:60]}")


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> pytest.MonkeyPatch:
    """A clean, production-like environment unless a test says otherwise."""
    for name in (
        "CHICCHAT_ENV",
        "CONSOLE_AUTH_REQUIRED",
        "SIMULATOR_ENABLED",
        "MAINTENANCE_SECRET",
        "CRON_SECRET",
        "WHATSAPP_APP_SECRET",
        "WHATSAPP_VERIFY_TOKEN",
        "WHATSAPP_ACCESS_TOKEN",
        "WHATSAPP_PHONE_NUMBER_ID",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("DATABASE_URL", "postgresql://unused@127.0.0.1/unused_test")
    return monkeypatch


@pytest.fixture
def fake_db(env: pytest.MonkeyPatch) -> FakeDatabase:
    database = FakeDatabase()
    env.setattr(deps, "database", lambda: database)
    env.setattr(deps, "current_principal", lambda _request: None)
    env.setattr("chicchat.web.app._authenticated", lambda _request: False)
    return database


@pytest.fixture
def client(fake_db: FakeDatabase) -> Iterator[TestClient]:
    with TestClient(create_app(), base_url="https://testserver") as test_client:
        yield test_client


def csrf(client: TestClient) -> str:
    """Obtain this client's form token the way a browser does: load a page."""
    client.get("/login")
    token = client.cookies.get("chicchat_csrf")
    assert token
    return token
