"""Browser walkthrough fixtures (docs/PORT.md Step 5 gate).

Runs only with `pytest -m browser`: starts the app in development mode against
the local `_test` database and drives it with a real Chromium. Set
CHICCHAT_CHROMIUM to a Chromium binary when Playwright's own is not installed
(cloud sessions: /opt/pw-browsers/chromium).
"""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import time
from collections.abc import Iterator
from pathlib import Path

import pytest
from playwright.sync_api import Browser, Page, sync_playwright

from tests.db.conftest import database_url, run_seed


def pytest_collection_modifyitems(items: list[pytest.Item]) -> None:
    for item in items:
        if "/tests/browser/" in str(item.fspath):
            item.add_marker(pytest.mark.browser)


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port: int = s.getsockname()[1]
        return port


@pytest.fixture(scope="session")
def base_url() -> Iterator[str]:
    run_seed()
    port = _free_port()
    env = {**os.environ, "DATABASE_URL": database_url(), "CHICCHAT_ENV": "development"}
    server = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "chicchat.web.app:app",
            "--port",
            str(port),
            "--no-access-log",
        ],
        cwd=Path(__file__).resolve().parents[2],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    url = f"http://127.0.0.1:{port}"
    for _ in range(100):
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                break
        except OSError:
            time.sleep(0.1)
    try:
        yield url
    finally:
        server.terminate()
        server.wait(timeout=10)


@pytest.fixture(scope="session")
def browser() -> Iterator[Browser]:
    executable = os.environ.get("CHICCHAT_CHROMIUM") or (
        "/opt/pw-browsers/chromium"
        if Path("/opt/pw-browsers/chromium").exists()
        else None
    )
    with sync_playwright() as playwright:
        launched = (
            playwright.chromium.launch(executable_path=executable)
            if executable
            else playwright.chromium.launch()
        )
        yield launched
        launched.close()


@pytest.fixture
def page(browser: Browser, base_url: str) -> Iterator[Page]:
    context = browser.new_context(
        base_url=base_url, viewport={"width": 1400, "height": 1000}
    )
    tab = context.new_page()
    errors: list[str] = []
    tab.on("pageerror", lambda error: errors.append(str(error)))
    tab.on(
        "console",
        lambda message: errors.append(message.text)
        if message.type == "error"
        else None,
    )
    # Act as the demo merchant.
    tab.goto("/cases")
    tab.select_option('form[action="/merchant"] select', label="Demo Apparel Co.")
    tab.click('form[action="/merchant"] button')
    tab.wait_for_load_state()
    yield tab
    assert errors == [], f"browser errors: {errors}"
    context.close()
