"""Apply supabase/migrations to a local development database.

Usage:  DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/chicchat \\
          uv run python -m chicchat.scripts.migrate

Local hosts only. Hosted databases are migrated deliberately with the Supabase
CLI (`supabase db push`), never by the app or this script (docs/DEPLOYMENT.md).
Applied files are recorded in `_local_migrations`, so re-running is safe.
"""

from __future__ import annotations

import os
import sys
from urllib.parse import urlsplit

import psycopg

from chicchat.scripts.prepare_test_db import MIGRATIONS


def main() -> None:
    uri = os.environ.get("DATABASE_URL")
    if not uri:
        raise SystemExit("Set DATABASE_URL to your local development database")
    if urlsplit(uri).hostname not in ("127.0.0.1", "localhost", "::1"):
        raise SystemExit(
            "Refusing to migrate a non-local database; use the Supabase CLI for hosted ones"
        )
    with psycopg.connect(uri, autocommit=True) as db:
        db.execute(
            "create table if not exists _local_migrations (name text primary key)"
        )
        applied = 0
        for path in sorted(MIGRATIONS.glob("*.sql")):
            if db.execute(
                "select 1 from _local_migrations where name=%s", [path.name]
            ).fetchone():
                continue
            with db.transaction():
                db.execute(path.read_text(encoding="utf-8").encode("utf-8"))
                db.execute("insert into _local_migrations values (%s)", [path.name])
            sys.stdout.write(f"Applied {path.name}\n")
            applied += 1
        sys.stdout.write(f"{applied} migration(s) applied; the schema is up to date.\n")


if __name__ == "__main__":
    main()
