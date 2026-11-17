"""What deployment on Vercel relies on (docs/DEPLOYMENT.md).

Vercel's Python runtime imports `app` from `index.py`, runs it under uvicorn
and ends the invocation only when the ASGI call returns. The webhook must
therefore send its 200 first and finish the inbox processing *inside* the same
ASGI call — never in a thread or task that outlives it.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
from collections.abc import MutableMapping
from typing import Any

import pytest

from chicchat.web.app import app as package_app
from chicchat.web.app import create_app
from chicchat.web.routes import api
from tests.web.conftest import FakeDatabase

SECRET = "vercel-test-secret"


def test_the_vercel_entrypoint_exposes_the_application() -> None:
    import index  # the module Vercel imports

    assert index.app is package_app


def test_processing_finishes_after_the_response_and_inside_the_asgi_call(
    fake_db: FakeDatabase, env: pytest.MonkeyPatch
) -> None:
    env.setenv("WHATSAPP_APP_SECRET", SECRET)
    events: list[str] = []
    env.setattr(api, "parse_inbound", lambda _b: [])
    env.setattr(api, "accept_messages", lambda _db, _m: events.append("accepted"))
    env.setattr(
        api, "process_inbox_after_response", lambda _db: events.append("processed")
    )
    body = b"{}"
    signature = hmac.new(SECRET.encode(), body, hashlib.sha256).hexdigest()
    scope: dict[str, Any] = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "https",
        "path": "/api/whatsapp/webhook",
        "raw_path": b"/api/whatsapp/webhook",
        "query_string": b"",
        "root_path": "",
        "headers": [
            (b"host", b"chicchat.example"),
            (b"content-type", b"application/json"),
            (b"x-hub-signature-256", f"sha256={signature}".encode()),
        ],
        "client": ("127.0.0.1", 1),
        "server": ("127.0.0.1", 443),
    }
    received = False

    async def receive() -> dict[str, Any]:
        nonlocal received
        if received:
            await asyncio.sleep(3600)
        received = True
        return {"type": "http.request", "body": body, "more_body": False}

    async def send(message: MutableMapping[str, Any]) -> None:
        if message["type"] == "http.response.start":
            events.append(f"status {message['status']}")
        elif message["type"] == "http.response.body" and not message.get("more_body"):
            events.append("response complete")

    asyncio.run(create_app()(scope, receive, send))
    # When the call returns, Vercel ends the invocation: processing is done.
    assert events == ["accepted", "status 200", "response complete", "processed"]
