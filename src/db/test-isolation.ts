/**
 * Test-only isolation support (docs/RETROFIT.md R6b, third occurrence).
 *
 * The integration tests wrap each case in `begin`/`rollback`, which makes them
 * independent of **each other** — but not of whatever is already committed in
 * the database they are pointed at. That distinction never mattered against a
 * disposable local container. It matters against a hosted database, which
 * keeps whatever a previous (or interrupted) run left behind.
 *
 * The failure is quiet rather than loud. A leftover `intake_sessions` row on
 * one of the fixed fake phone numbers means the first message *resumes* that
 * session instead of starting a new one, so every scripted answer afterwards
 * lands one step early and no field is ever captured. The sweep then correctly
 * deletes an empty session instead of filing an abandoned case — the
 * application is right and the test is wrong, which is the worst way round.
 *
 * This runs **inside** the test transaction, so it rolls back with everything
 * else: it changes what this test sees, and deletes nothing from the database
 * it runs against.
 */

/** Just enough of a client to issue the statement; `pg`'s Client satisfies it. */
interface Queryable {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

/**
 * The synthetic customer range the tests use. Scoped deliberately: a blanket
 * `delete from intake_sessions` would take row locks across conversations
 * belonging to a real deployment sharing this database.
 */
const FAKE_CUSTOMER_PREFIX = "90555%";

/**
 * Start this test as if none of its fake customers had ever written in.
 * Call after `begin`, before the first message.
 */
export async function forgetFakeConversations(db: Queryable): Promise<void> {
  await db.query(`delete from intake_sessions where customer_wa_id like $1`, [
    FAKE_CUSTOMER_PREFIX,
  ]);
}
