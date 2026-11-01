"""Password and session-token hashing — port of server/auth/credentials.ts.

Moved into the domain because it is pure computation and the database layer
needs it (the Python layer rule forbids db → server imports).

Compatibility is the whole point (docs/PORT.md P5): hashes written by the
TypeScript version must verify here and vice versa. Node's `scrypt` defaults
are N=16384, r=8, p=1 with a 64-byte key, and the salt is the 32-character hex
*text* used as bytes — not the 16 bytes it encodes.
"""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets

_N, _R, _P, _KEY_LENGTH = 16384, 8, 1, 64
_SALT = re.compile(r"[a-f0-9]{32}")
_HASH = re.compile(r"[a-f0-9]{128}")


def _derive(password: str, salt_hex: str) -> bytes:
    return hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt_hex.encode("ascii"),
        n=_N,
        r=_R,
        p=_P,
        dklen=_KEY_LENGTH,
    )


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    return f"scrypt:{salt}:{_derive(password, salt).hex()}"


def verify_password(password: str, stored: str) -> bool:
    version, salt, digest = ([*stored.split(":"), "", ""])[:3]
    if version != "scrypt" or not _SALT.fullmatch(salt) or not _HASH.fullmatch(digest):
        return False
    return hmac.compare_digest(_derive(password, salt), bytes.fromhex(digest))


def token_hash(token: str) -> str:
    """The stored form of a session token: SHA-256 hex of the token text."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def new_session_token() -> str:
    """32 random bytes as hex (64 characters), like `randomBytes(32).toString("hex")`."""
    return secrets.token_hex(32)
