"""Console accounts and sessions — port of db/auth.ts."""

from __future__ import annotations

import re
from dataclasses import dataclass

from chicchat.db.database import Database, Queryable
from chicchat.domain.auth.credentials import (
    new_session_token,
    token_hash,
    verify_password,
)
from chicchat.domain.jscompat import js_length, js_trim

_TOKEN = re.compile(r"[a-f0-9]{64}")
_USERNAME = re.compile(r"[a-z0-9_.@-]{1,100}")
# Verifying against a fixed dummy hash makes an unknown username take as long
# as a wrong password, so login timing does not reveal which accounts exist.
_DUMMY_HASH = f"scrypt:{'0' * 32}:{'0' * 128}"


@dataclass(frozen=True)
class Principal:
    id: str
    username: str
    merchant_ids: list[str]


def session_principal(db: Queryable, token: str | None) -> Principal | None:
    if not token or not _TOKEN.fullmatch(token):
        return None
    rows = db.query(
        """select u.id, u.username,
    coalesce(array_agg(m.merchant_id) filter (where m.merchant_id is not null), '{}') as "merchantIds"
    from console_sessions s join console_users u on u.id=s.user_id
    left join console_memberships m on m.user_id=u.id
    where s.token_hash=$1 and s.expires_at>now() and u.enabled group by u.id""",
        [token_hash(token)],
    )
    if not rows:
        return None
    row = rows[0]
    return Principal(
        id=row["id"],
        username=row["username"],
        merchant_ids=[str(m) for m in row["merchantIds"]],
    )


def login(db: Database, username: str, password: str) -> str | None:
    """A new session token, or None. The per-account throttle is transactional
    across instances, including for nonexistent accounts."""
    username = js_trim(username).lower()
    if not _USERNAME.fullmatch(username) or js_length(password) > 1024:
        return None
    with db.transaction() as tx:
        rows = tx.query(
            """insert into console_login_attempts (username, attempts) values ($1,1)
      on conflict (username) do update set
      attempts=case when console_login_attempts.window_started_at < now()-interval '15 minutes' then 1 else console_login_attempts.attempts+1 end,
      window_started_at=case when console_login_attempts.window_started_at < now()-interval '15 minutes' then now() else console_login_attempts.window_started_at end
      returning attempts""",
            [username],
        )
        allowed = rows[0]["attempts"] <= 10
    if not allowed:
        return None
    users = db.query(
        "select id, password_hash from console_users where username=$1 and enabled",
        [username],
    )
    user = users[0] if users else None
    stored = user["password_hash"] if user else _DUMMY_HASH
    if not verify_password(password, stored) or user is None:
        return None
    token = new_session_token()
    db.query(
        "insert into console_sessions (token_hash,user_id,expires_at) values ($1,$2,now()+interval '12 hours')",
        [token_hash(token), user["id"]],
    )
    return token


def sign_out(db: Queryable, token: str) -> None:
    db.query("delete from console_sessions where token_hash=$1", [token_hash(token)])
