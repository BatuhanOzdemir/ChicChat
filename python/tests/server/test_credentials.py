"""Port of server/auth/credentials.test.ts, plus compatibility with hashes the
TypeScript version wrote (docs/PORT.md P5)."""

from __future__ import annotations

import re

from chicchat.domain.auth.credentials import hash_password, token_hash, verify_password

# Produced by Node's scrypt exactly as scripts/console-user.mjs does, for the
# password "İade-şifre 👗 test" (non-ASCII on purpose).
NODE_HASH = (
    "scrypt:a3ecc4b3996e2dd8dba3127e4f04b2e0:005d1ef10323eaf69cae719d57ef382ad53bb57d8fe7bc6e9881c5e1b66981c3"
    "0b2012fb00f9298bdf9393d28663f6c92931d7cb56c14fac8f79fbec80db8769"
)


def test_salts_passwords_and_verifies_without_storing_the_original_secret() -> None:
    first = hash_password("a-test-password")
    second = hash_password("a-test-password")
    assert first != second
    assert "a-test-password" not in first
    assert verify_password("a-test-password", first) is True
    assert verify_password("wrong", first) is False
    assert verify_password("a-test-password", "malformed") is False
    assert re.fullmatch(r"[a-f0-9]{64}", token_hash("session-token"))
    assert token_hash("session-token") != token_hash("another-token")


def test_verifies_a_password_hash_written_by_the_typescript_version() -> None:
    assert verify_password("İade-şifre 👗 test", NODE_HASH) is True
    assert verify_password("Iade-sifre 👗 test", NODE_HASH) is False


def test_hashes_session_tokens_exactly_as_the_typescript_version() -> None:
    # createHash("sha256").update("tok-İ").digest("hex") in Node.
    assert (
        token_hash("tok-İ")
        == "c386eb487ab840345b2e389bc102f0f0fa6cbf934e88e5ff29c3ab1480a099b4"
    )


def test_rejects_malformed_stored_hashes_without_raising() -> None:
    for stored in (
        "",
        "scrypt",
        "scrypt::",
        "bcrypt:" + "0" * 32 + ":" + "0" * 128,
        "scrypt:" + "g" * 32 + ":" + "0" * 128,
    ):
        assert verify_password("x", stored) is False
