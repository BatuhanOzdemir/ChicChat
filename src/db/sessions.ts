/**
 * Intake session persistence (CLAUDE.md Step 8). Stores the Step 5 IntakeState
 * between WhatsApp messages, keyed by (merchant, customer). Driver-decoupled
 * via `Queryable`.
 */
import type { IntakeState } from "../lib/intake";
import type { Queryable } from "./cases";

export async function loadSession(
  db: Queryable,
  merchantId: string,
  customerWaId: string,
): Promise<IntakeState | null> {
  const { rows } = await db.query(
    `select state from intake_sessions where merchant_id = $1 and customer_wa_id = $2`,
    [merchantId, customerWaId],
  );
  const row = rows[0] as { state: IntakeState } | undefined;
  return row?.state ?? null;
}

/**
 * Save progress. Any customer activity returns the session to `active` and
 * clears a previous error — progress is never discarded (SPEC §11).
 */
export async function saveSession(
  db: Queryable,
  merchantId: string,
  customerWaId: string,
  state: IntakeState,
): Promise<void> {
  await db.query(
    `insert into intake_sessions (merchant_id, customer_wa_id, state)
     values ($1, $2, $3)
     on conflict (merchant_id, customer_wa_id) do update
       set state = excluded.state, updated_at = now(),
           status = 'active', last_error = null`,
    [merchantId, customerWaId, JSON.stringify(state)],
  );
}

export type SessionStatus = "active" | "nudged" | "errored";

/**
 * Mark a session's lifecycle state without touching `updated_at`, so a nudge or
 * an error does not look like fresh customer activity to the maintenance job.
 */
export async function setSessionStatus(
  db: Queryable,
  merchantId: string,
  customerWaId: string,
  status: SessionStatus,
  lastError?: string,
): Promise<void> {
  await db.query(
    `update intake_sessions
        set status = $3,
            last_error = $4,
            nudged_at = case when $3 = 'nudged' then now() else nudged_at end
      where merchant_id = $1 and customer_wa_id = $2`,
    [merchantId, customerWaId, status, lastError ?? null],
  );
}

export async function deleteSession(
  db: Queryable,
  merchantId: string,
  customerWaId: string,
): Promise<void> {
  await db.query(
    `delete from intake_sessions where merchant_id = $1 and customer_wa_id = $2`,
    [merchantId, customerWaId],
  );
}

/**
 * Shift a session's timestamps into the past — the simulator's time-travel
 * control (SPEC §7), used to exercise inactivity behaviour without waiting.
 * Returns true when a session was aged.
 */
export async function ageSession(
  db: Queryable,
  merchantId: string,
  customerWaId: string,
  minutes: number,
): Promise<boolean> {
  const { rows } = await db.query(
    `update intake_sessions
        set created_at = created_at - ($3 * interval '1 minute'),
            updated_at = updated_at - ($3 * interval '1 minute')
      where merchant_id = $1 and customer_wa_id = $2
      returning id`,
    [merchantId, customerWaId, minutes],
  );
  return rows.length > 0;
}

/** Session row with its (possibly aged) timestamps, for the simulator inspector. */
export interface SessionMeta {
  state: IntakeState;
  created_at: string;
  updated_at: string;
}

export async function loadSessionMeta(
  db: Queryable,
  merchantId: string,
  customerWaId: string,
): Promise<SessionMeta | null> {
  const { rows } = await db.query(
    `select state, created_at, updated_at
       from intake_sessions where merchant_id = $1 and customer_wa_id = $2`,
    [merchantId, customerWaId],
  );
  return (rows[0] as SessionMeta | undefined) ?? null;
}
