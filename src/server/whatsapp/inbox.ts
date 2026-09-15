import type { InboundMessage, OutboundMessage } from "@/lib/whatsapp";
import { clientDatabase, type Database } from "@/db/database";
import { lockConversation } from "@/db/conversation-lock";
import { handleInbound } from "./handler";
import { deliverReplies } from "./outbox";
import { downloadPhoto } from "./media";
import { getWhatsAppConfig } from "./config";

export async function acceptMessages(
  db: Database,
  messages: { merchantId: string; inbound: InboundMessage }[],
): Promise<void> {
  await db.transaction(async (tx) => {
    // Stable lock order when a single envelope contains multiple conversations.
    for (const key of [
      ...new Set(
        messages.map(
          ({ merchantId, inbound }) => `${merchantId}:${inbound.from}`,
        ),
      ),
    ].sort()) {
      const split = key.indexOf(":");
      await lockConversation(tx, key.slice(0, split), key.slice(split + 1));
    }
    for (const { merchantId, inbound } of messages) {
      await tx.query(
        `insert into message_inbox (merchant_id, customer_wa_id, message_id, payload)
        values ($1,$2,$3,$4) on conflict (merchant_id, message_id) do nothing`,
        [merchantId, inbound.from, inbound.messageId, JSON.stringify(inbound)],
      );
    }
  });
}

/** Oldest accepted message first per conversation, even with concurrent workers. */
export async function processInbox(
  db: Database,
  send: (merchantId: string, message: OutboundMessage) => Promise<void>,
) {
  const deadline = Date.now() + 40_000;
  const { rows } =
    await db.query(`select merchant_id, customer_wa_id from message_inbox
    where processed_at is null group by merchant_id, customer_wa_id
    having (array_agg(next_attempt_at order by id))[1]<=now()
    order by min(id) limit 100`);
  const summary = { processed: 0, failed: 0 };
  for (const row of rows as { merchant_id: string; customer_wa_id: string }[]) {
    if (Date.now() >= deadline) break;
    for (let n = 0; n < 20; n++) {
      if (Date.now() >= deadline) break;
      const result = await db.transaction(async (tx) => {
        await lockConversation(tx, row.merchant_id, row.customer_wa_id);
        const { rows: pending } = await tx.query(
          `select id, payload, next_attempt_at from message_inbox
          where merchant_id=$1 and customer_wa_id=$2 and processed_at is null order by id limit 1 for update`,
          [row.merchant_id, row.customer_wa_id],
        );
        const item = pending[0] as
          | { id: string; payload: InboundMessage; next_attempt_at: Date }
          | undefined;
        if (!item || new Date(item.next_attempt_at).getTime() > Date.now())
          return null;
        const outcome = await handleInbound(
          {
            db: clientDatabase(tx),
            send: (m) => send(row.merchant_id, m),
            channel: "whatsapp",
            deferDelivery: true,
            loadPhoto: (id) => downloadPhoto(getWhatsAppConfig(), id),
          },
          row.merchant_id,
          item.payload,
        );
        await tx.query(
          `update message_inbox set attempts=attempts+1,
          processed_at=case when $2 then null else clock_timestamp() end,
          next_attempt_at=now()+least(3600,30*power(2,least(attempts,7))) * interval '1 second' where id=$1`,
          [item.id, outcome.failed],
        );
        return outcome;
      });
      if (!result) break;
      if (result.failed) {
        summary.failed++;
        break;
      }
      summary.processed++;
    }
    await deliverReplies(
      db,
      row.merchant_id,
      row.customer_wa_id,
      (m) => send(row.merchant_id, m),
      "whatsapp",
      false,
      deadline,
    );
  }
  return summary;
}
