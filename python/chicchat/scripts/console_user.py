"""Provision explicitly named console accounts — port of scripts/console-user.mjs.

No .env file is implicitly loaded. Usage:

    DATABASE_URL=... CHICCHAT_USER_PASSWORD=... \\
      uv run python -m chicchat.scripts.console_user username merchant-uuid [...]

Re-running replaces that account's password and memberships and revokes its
sessions.
"""

from __future__ import annotations

import os
import re
import sys

import psycopg

from chicchat.domain.auth.credentials import hash_password

_USERNAME = re.compile(r"[a-z0-9_.@-]{1,100}")
USAGE = (
    "Usage: set DATABASE_URL and CHICCHAT_USER_PASSWORD (12+ chars); "
    "python -m chicchat.scripts.console_user username merchant-uuid [...]"
)


def main(argv: list[str]) -> None:
    username, *merchant_ids = argv or [""]
    password = os.environ.get("CHICCHAT_USER_PASSWORD") or ""
    database_url = os.environ.get("DATABASE_URL")
    if (
        not database_url
        or not _USERNAME.fullmatch(username)
        or not 12 <= len(password) <= 1024
        or not merchant_ids
    ):
        raise SystemExit(USAGE)
    with psycopg.connect(database_url, autocommit=True) as db, db.transaction():
        row = db.execute(
            """insert into console_users(username,password_hash) values (%s,%s)
    on conflict (username) do update set password_hash=excluded.password_hash, enabled=true returning id""",
            [username, hash_password(password)],
        ).fetchone()
        assert row is not None
        user_id = row[0]
        db.execute("delete from console_memberships where user_id=%s", [user_id])
        for merchant_id in dict.fromkeys(merchant_ids):
            db.execute(
                "insert into console_memberships values (%s,%s)", [user_id, merchant_id]
            )
        db.execute("delete from console_sessions where user_id=%s", [user_id])
        db.execute("delete from console_login_attempts where username=%s", [username])
    sys.stdout.write("Account provisioned; previous sessions revoked.\n")


if __name__ == "__main__":
    main(sys.argv[1:])
