"""Server-side PostgreSQL pool for the app — port of db/client.ts.

A lazily created singleton, so every request shares one pool. Reads
DATABASE_URL; falls back to the local Supabase URL.

`prepare_threshold=None` keeps psycopg from switching to server-side prepared
statements, which break under Supabase's transaction-mode pooler (P13).
"""

from __future__ import annotations

import os
import threading
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from typing import Any

import psycopg
from psycopg_pool import ConnectionPool

from chicchat.db.database import ConnectionDatabase, Row, configure_connection, run

LOCAL_DEFAULT = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"


class PoolDatabase:
    """The transactional database handle the server layers depend on."""

    def __init__(self, pool: ConnectionPool[Any]) -> None:
        self.pool = pool

    def query(self, sql: str, params: Sequence[object] = ()) -> list[Row]:
        with self.pool.connection() as conn:
            return run(conn, sql, params)

    @contextmanager
    def transaction(self) -> Iterator[ConnectionDatabase]:
        with self.pool.connection() as conn, conn.transaction():
            yield ConnectionDatabase(conn)


def _configure(conn: psycopg.Connection[Any]) -> None:
    configure_connection(conn)


_lock = threading.Lock()
_database: PoolDatabase | None = None


def get_database() -> PoolDatabase:
    global _database
    with _lock:
        if _database is None:
            pool: ConnectionPool[Any] = ConnectionPool(
                os.environ.get("DATABASE_URL") or LOCAL_DEFAULT,
                kwargs={"autocommit": True, "prepare_threshold": None},
                configure=_configure,
                min_size=1,
                max_size=int(os.environ.get("DATABASE_POOL_SIZE", "10")),
                open=True,
            )
            _database = PoolDatabase(pool)
        return _database
