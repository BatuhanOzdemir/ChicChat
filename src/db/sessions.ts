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
       set state = excluded.state, updated_at = now()`,
    [merchantId, customerWaId, JSON.stringify(state)],
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
