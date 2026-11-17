"""Webhook verification — port of whatsapp/verify.ts.

- GET handshake: Meta calls with hub.mode / hub.verify_token / hub.challenge.
- POST authenticity: X-Hub-Signature-256 HMAC over the **raw body bytes**
  (docs/PORT.md P2) — never over re-serialized JSON.

`hmac` and `hashlib` are standard-library computation, not I/O, so the domain
stays pure (the TypeScript imported node:crypto here too).
"""

from __future__ import annotations

import hashlib
import hmac


def verify_webhook_challenge(
    mode: str | None, token: str | None, challenge: str | None, expected_token: str
) -> str | None:
    """The challenge to echo back when the handshake is valid, else None."""
    if (
        mode == "subscribe"
        and token is not None
        and token == expected_token
        and challenge is not None
    ):
        return challenge
    return None


def _hex_prefix(text: str) -> bytes:
    """`Buffer.from(text, "hex")`: decodes pairs until the first invalid one."""
    out = bytearray()
    for i in range(0, len(text) - 1, 2):
        pair = text[i : i + 2]
        try:
            out.append(int(pair, 16))
        except ValueError:
            break
        if not all(c in "0123456789abcdefABCDEF" for c in pair):
            out.pop()
            break
    return bytes(out)


def verify_signature(
    raw_body: bytes, signature_header: str | None, app_secret: str
) -> bool:
    """Verify the X-Hub-Signature-256 header against the raw request body.

    A malformed header (bad hex, wrong length) is simply a failed check, never
    an exception (P2).
    """
    if signature_header is None or not signature_header.startswith("sha256="):
        return False
    expected = hmac.new(app_secret.encode("utf-8"), raw_body, hashlib.sha256).digest()
    received = _hex_prefix(signature_header[len("sha256=") :])
    return len(expected) == len(received) and hmac.compare_digest(expected, received)
