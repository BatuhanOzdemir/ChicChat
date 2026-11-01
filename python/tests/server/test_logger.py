"""Port of server/logging/logger.test.ts."""

from __future__ import annotations

import json
from typing import Any

import pytest

from chicchat.server.logger import logger


def last_line(text: str) -> dict[str, Any]:
    lines = [line for line in text.splitlines() if line.strip()]
    parsed: dict[str, Any] = json.loads(lines[-1])
    return parsed


def test_redacts_phones_and_secrets_in_correlation_ids_nested_context_and_error_stacks(
    capsys: pytest.CaptureFixture[str],
) -> None:
    logger.error(
        "unexpected_exception",
        RuntimeError("recipient +90 555 000 1234; Bearer fake-secret-token"),
        {
            "phone": "905550001234",
            "correlationId": "maintenance:905550001234",
            "nested": {"access_token": "do-not-log", "recipient": "905550001234"},
        },
    )
    output = capsys.readouterr().err
    for secret in (
        "905550001234",
        "+90 555 000 1234",
        "fake-secret-token",
        "do-not-log",
    ):
        assert secret not in output
    assert "1234" in output


def test_emits_one_json_line_carrying_merchant_id_and_correlation_id(
    capsys: pytest.CaptureFixture[str],
) -> None:
    logger.info(
        "case_persisted",
        {"merchantId": "m-1", "correlationId": "wamid.9", "case_id": "c-1"},
    )
    out = capsys.readouterr().out
    assert len(out.strip().splitlines()) == 1
    line = last_line(out)
    assert {
        k: line[k]
        for k in ("level", "event", "merchant_id", "correlation_id", "case_id")
    } == {
        "level": "info",
        "event": "case_persisted",
        "merchant_id": "m-1",
        "correlation_id": "wamid.9",
        "case_id": "c-1",
    }
    assert isinstance(line["ts"], str)


def test_never_logs_a_phone_number_in_full(capsys: pytest.CaptureFixture[str]) -> None:
    logger.info("webhook_received", {"phone": "905352680403"})
    out = capsys.readouterr().out
    assert "905352680403" not in out
    assert last_line(out)["phone"] == "****0403"


def test_sends_errors_to_stderr_with_message_and_stack(
    capsys: pytest.CaptureFixture[str],
) -> None:
    try:
        raise RuntimeError("boom")
    except RuntimeError as err:
        logger.error(
            "unexpected_exception",
            err,
            {"merchantId": "m-1", "correlationId": "wamid.9"},
        )
    captured = capsys.readouterr()
    assert captured.out == ""
    line = last_line(captured.err)
    assert (line["level"], line["event"], line["error_message"]) == (
        "error",
        "unexpected_exception",
        "boom",
    )
    assert "RuntimeError: boom" in line["stack"]
