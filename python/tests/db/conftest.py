"""Fixtures for the database integration tests (port of the *.integration.test.ts setup).

Every test here talks to a real PostgreSQL. `DATABASE_URL` must point at a
*local* database whose name ends in `_test` (the same guard as the preparation
script): some repair tests deliberately commit, and must never touch customer
data. Run with `uv run pytest -m db`.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from typing import Any

import psycopg
import pytest

from chicchat.db.database import ConnectionDatabase, configure_connection
from chicchat.db.test_isolation import forget_fake_conversations
from chicchat.scripts.prepare_test_db import require_local_test_database


def pytest_collection_modifyitems(items: list[pytest.Item]) -> None:
    for item in items:
        if "/tests/db/" in str(item.fspath):
            item.add_marker(pytest.mark.db)


def database_url() -> str:
    return require_local_test_database(os.environ.get("DATABASE_URL"))


def connect() -> psycopg.Connection[Any]:
    """A fresh autocommit connection that returns UUIDs as strings, like the app's."""
    conn = psycopg.connect(database_url(), autocommit=True, prepare_threshold=None)
    configure_connection(conn)
    return conn


def run_seed() -> None:
    """Seed (idempotently) and commit, as `node scripts/seed.mjs` did."""
    from chicchat.scripts.seed import seed

    with connect() as conn:
        database = ConnectionDatabase(conn)
        with database.transaction():
            seed(database)


@pytest.fixture(scope="module")
def conn() -> Iterator[psycopg.Connection[Any]]:
    """One connection per test module (the TypeScript files shared one client)."""
    connection = connect()
    yield connection
    connection.close()


@pytest.fixture(scope="module")
def seeded() -> None:
    run_seed()


@pytest.fixture
def db(conn: psycopg.Connection[Any], seeded: None) -> Iterator[ConnectionDatabase]:
    """A transaction that rolls back after the test, with the fake customers forgotten."""
    conn.execute("begin")
    database = ConnectionDatabase(conn)
    forget_fake_conversations(database)
    try:
        yield database
    finally:
        conn.execute("rollback")


@pytest.fixture(scope="module")
def pool_db() -> Iterator[Any]:
    """Independent pooled connections, for the tests that commit and race."""
    from psycopg_pool import ConnectionPool

    from chicchat.db.client import PoolDatabase

    pool: ConnectionPool[Any] = ConnectionPool(
        database_url(),
        kwargs={"autocommit": True, "prepare_threshold": None},
        configure=configure_connection,
        min_size=1,
        max_size=8,
        open=True,
    )
    yield PoolDatabase(pool)
    pool.close()
