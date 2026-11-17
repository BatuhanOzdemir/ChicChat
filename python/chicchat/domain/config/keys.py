"""Machine keys for merchant-created taxonomy entries (SPEC §8) — port of
config/keys.ts.

Labels are free text in any language; the stable key that rules, sessions and
cases reference must be ASCII snake_case. Turkish characters are transliterated
rather than dropped, so "İade Talebi" becomes `iade_talebi`, not `ade_talebi`.
"""

from __future__ import annotations

import re

_TRANSLITERATIONS = {
    "ı": "i",
    "İ": "i",
    "i": "i",
    "ş": "s",
    "Ş": "s",
    "ğ": "g",
    "Ğ": "g",
    "ü": "u",
    "Ü": "u",
    "ö": "o",
    "Ö": "o",
    "ç": "c",
    "Ç": "c",
    "â": "a",
    "é": "e",
    "á": "a",
    "í": "i",
    "ó": "o",
    "ú": "u",
    "ñ": "n",
    "ã": "a",
    "õ": "o",
}
_NOT_KEY = re.compile(r"[^a-z0-9]+")
_EDGE_UNDERSCORES = re.compile(r"^_+|_+$")
_VALID_KEY = re.compile(r"[a-z][a-z0-9_]{0,59}")


def slugify_key(text: str) -> str:
    transliterated = "".join(_TRANSLITERATIONS.get(ch, ch) for ch in text)
    lowered = transliterated.lower()
    return _EDGE_UNDERSCORES.sub("", _NOT_KEY.sub("_", lowered))[:60]


def is_valid_key(key: str) -> bool:
    """True when a key is safe to store and reference."""
    return _VALID_KEY.fullmatch(key) is not None
