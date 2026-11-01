"""PII masking for logs (Handbook §5, SPEC §12) — port of logging/mask.ts.

Phone numbers are never logged in full — only the last 4 digits survive.
"""

from __future__ import annotations

import re
from typing import Any

from chicchat.domain.jscompat import js_regex

_NON_DIGITS = re.compile(r"[^0-9]")


def mask_phone(phone: str) -> str:
    digits = _NON_DIGITS.sub("", phone)
    if len(digits) == 0:
        return "****"
    if len(digits) <= 4:
        return f"****{digits}"
    return f"****{digits[-4:]}"


# The TypeScript expressions, compiled with JavaScript semantics (ASCII \d,
# JavaScript \s) so redaction matches exactly.
_BEARER = js_regex(r"Bearer\s+[^\s\"',}]+", "gi")
_SECRET_ASSIGNMENT = js_regex(
    r"((?:password|passcode|secret|access_token|refresh_token|authorization)[\"']?\s*[:=]\s*[\"']?)[^\s\"',}&]+",
    "gi",
)
_URL_CREDENTIALS = js_regex(r":\/\/[^\s/@]+:[^\s/@]+@", "g")
_NUMBERS = js_regex(
    r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|\d{4}-\d{2}-\d{2}T[\d:.]+Z|\+?\d(?:[\s().-]?\d){6,14}",
    "gi",
)
_UUID_START = js_regex(r"^[a-f0-9]{8}-", "i")
_ISO_START = js_regex(r"^\d{4}-\d{2}-\d{2}T")
_SECRET_KEY = js_regex(r"password|passcode|secret|token|authorization|cookie", "i")


def _mask_number(match: re.Match[str]) -> str:
    value = match.group(0)
    if _UUID_START.search(value) or _ISO_START.search(value):
        return value
    return mask_phone(value)


def redact_text(text: str) -> str:
    """Sanitize diagnostic text, including formatted numbers and transport secrets."""
    text = _BEARER.sub("Bearer [redacted]", text)
    text = _SECRET_ASSIGNMENT.sub(lambda m: m.group(1) + "[redacted]", text)
    text = _URL_CREDENTIALS.sub("://[redacted]@", text)
    return _NUMBERS.sub(_mask_number, text)


def redact_log(value: Any, depth: int = 0) -> Any:
    """Redact nested log metadata too; never serialize arbitrary objects unbounded."""
    if depth > 8:
        return "[truncated]"
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, list | tuple):
        return [redact_log(item, depth + 1) for item in value[:100]]
    if isinstance(value, dict):
        return {
            key: "[redacted]"
            if _SECRET_KEY.search(str(key))
            else redact_log(item, depth + 1)
            for key, item in value.items()
        }
    return value
