"""Test-only isolation support (retrofit finding R6b; DEVELOPMENT-LOG §18) —
port of db/test-isolation.ts.

Integration tests wrap each case in a transaction that rolls back, which makes
them independent of each other — but not of whatever is already committed in
the database they point at. A leftover `intake_sessions` row on one of the
fixed fake phone numbers means the first message *resumes* that session, so
every scripted answer lands one step early. This runs inside the test
transaction, so it rolls back with everything else.
"""

from __future__ import annotations

from chicchat.db.database import Queryable

FAKE_CUSTOMER_PREFIX = "90555%"
"""The synthetic customer range the tests use. Scoped deliberately: a blanket
delete would lock conversations of a real deployment sharing the database."""


def forget_fake_conversations(db: Queryable) -> None:
    """Start this test as if none of its fake customers had ever written in."""
    db.query(
        "delete from intake_sessions where customer_wa_id like $1",
        [FAKE_CUSTOMER_PREFIX],
    )
