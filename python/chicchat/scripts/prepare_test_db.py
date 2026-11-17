"""Apply supabase/migrations to an explicitly isolated local test database —
port of scripts/prepare-test-db.mjs.

Never reads .env files, and refuses anything that is not a local database
whose name ends in `_test`: the concurrency tests commit transactions and must
never touch customer data. Run: `uv run python -m chicchat.scripts.prepare_test_db`
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from urllib.parse import urlsplit

import psycopg

MIGRATIONS = Path(__file__).resolve().parents[3] / "supabase" / "migrations"


def require_local_test_database(uri: str | None) -> str:
    if not uri:
        raise SystemExit("Set DATABASE_URL explicitly to a local *_test database")
    url = urlsplit(uri)
    if url.hostname not in ("127.0.0.1", "localhost", "::1") or not url.path.endswith(
        "_test"
    ):
        raise SystemExit("Refusing to prepare a non-local or non-test database")
    return uri


def main() -> None:
    uri = require_local_test_database(os.environ.get("DATABASE_URL"))
    with psycopg.connect(uri, autocommit=True) as db:
        db.execute(
            "create table if not exists _test_migrations (name text primary key)"
        )
        for path in sorted(MIGRATIONS.glob("*.sql")):
            if db.execute(
                "select 1 from _test_migrations where name=%s", [path.name]
            ).fetchone():
                continue
            with db.transaction():
                db.execute(path.read_text(encoding="utf-8").encode("utf-8"))
                db.execute("insert into _test_migrations values (%s)", [path.name])
            sys.stdout.write(f"Applied {path.name}\n")


if __name__ == "__main__":
    main()
