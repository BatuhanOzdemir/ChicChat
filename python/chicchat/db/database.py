"""Database access contracts (Handbook §2/§6) — port of db/database.ts.

`Queryable` is the minimal query surface every data function takes, so the
code under test never depends on a driver. `Database` adds real transactions,
because multi-record writes must be atomic (Handbook §6).

SQL is written exactly as in the TypeScript (`$1`, `$2`, …): `query` rewrites
the placeholders for psycopg, so every statement stays character-for-character
identical to the original (docs/PORT.md §5).

Connections are in autocommit mode: a plain `query` commits on its own, and
`transaction()` opens an explicit transaction — or, when one is already open
on that connection, a savepoint (psycopg's nested `transaction()`), which is
what `clientDatabase` did with SAVEPOINTs in TypeScript (P14).
"""

from __future__ import annotations

import re
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from functools import lru_cache
from typing import Any, Protocol

import psycopg
from psycopg.rows import dict_row
from psycopg.types.string import TextLoader

Row = dict[str, Any]


class Queryable(Protocol):
    """Minimal query surface: run SQL, get rows as dicts."""

    def query(self, sql: str, params: Sequence[object] = ()) -> list[Row]: ...


class Database(Queryable, Protocol):
    """A Queryable that can also run work atomically.

    `with db.transaction() as tx:` commits on success, rolls back on any
    exception, and always releases the connection.
    """

    def transaction(self) -> Any: ...


_PLACEHOLDER = re.compile(r"\$(\d+)")


@lru_cache(maxsize=1024)
def to_psycopg(sql: str) -> str:
    """`$1` → `%(p1)s`; literal `%` doubled so psycopg leaves it alone."""
    return _PLACEHOLDER.sub(r"%(p\1)s", sql.replace("%", "%%"))


def _params(params: Sequence[object]) -> dict[str, object]:
    return {f"p{i}": value for i, value in enumerate(params, start=1)}


def configure_connection(conn: psycopg.Connection[Any]) -> None:
    """Return UUIDs as strings, as node-pg did (P12)."""
    conn.adapters.register_loader("uuid", TextLoader)


def run(
    conn: psycopg.Connection[Any], sql: str, params: Sequence[object] = ()
) -> list[Row]:
    with conn.cursor(row_factory=dict_row) as cur:
        # Without parameters psycopg performs no `%` substitution at all, so the
        # SQL goes through untouched (doubling `%` would corrupt LIKE patterns).
        if params:
            cur.execute(to_psycopg(sql), _params(params))
        else:
            cur.execute(sql)
        return list(cur.fetchall()) if cur.description else []


class ConnectionDatabase:
    """A Database bound to one connection.

    `transaction()` begins a transaction, or a savepoint inside one already
    open — the Python form of TypeScript's `clientDatabase(tx)`.
    """

    def __init__(self, conn: psycopg.Connection[Any]) -> None:
        self.conn = conn

    def query(self, sql: str, params: Sequence[object] = ()) -> list[Row]:
        return run(self.conn, sql, params)

    @contextmanager
    def transaction(self) -> Iterator[ConnectionDatabase]:
        with self.conn.transaction():
            yield self


def client_database(tx: Queryable) -> ConnectionDatabase:
    """The Database view of a transaction handle (TypeScript `clientDatabase`)."""
    if isinstance(tx, ConnectionDatabase):
        return tx
    raise TypeError("client_database needs a ConnectionDatabase")
