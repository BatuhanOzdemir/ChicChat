/**
 * Idempotency ledger (SPEC §11, Handbook §6): WhatsApp retries deliveries, so
 * every inbound message id is claimed exactly once per merchant. A duplicate
 * delivery loses the race and is skipped instead of advancing the conversation
 * a second time.
 */
import type { Queryable } from "./database";

/**
 * Try to claim a message id. Returns true when this call owns the message and
 * processing should continue, false when it was already processed.
 *
 * Claim inside the same transaction as the processing it guards, so a rollback
 * releases the claim and the retry can succeed.
 */
export async function claimMessage(
  db: Queryable,
  merchantId: string,
  messageId: string,
): Promise<boolean> {
  const { rows } = await db.query(
    `insert into processed_messages (merchant_id, message_id)
     values ($1, $2)
     on conflict (merchant_id, message_id) do nothing
     returning id`,
    [merchantId, messageId],
  );
  return rows.length > 0;
}
