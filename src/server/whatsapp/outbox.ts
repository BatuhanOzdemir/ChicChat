import { outboundSummary, type OutboundMessage } from "@/lib/whatsapp";
import { redactText } from "@/lib/logging/mask";
import { type Database } from "@/db/database";
import { lockConversation } from "@/db/conversation-lock";
import { recordMessage } from "@/db/transcript";
import type { DeliveryChannel } from "@/db/outbox";

/** Serialize delivery with intake/erasure. Network ambiguity permits duplicate external sends. */
export async function deliverReplies(
  db: Database,
  merchantId: string,
  phone: string,
  send: (message: OutboundMessage) => Promise<void>,
  channel: DeliveryChannel,
  force = false,
  deadline = Date.now() + 30_000,
): Promise<{ sent: number; failed: boolean }> {
  return db.transaction(async (tx) => {
    await lockConversation(tx, merchantId, phone);
    const { rows } = await tx.query(
      `select id, payload, case_id, next_attempt_at
      from message_outbox where merchant_id=$1 and customer_wa_id=$2
      and delivery_channel=$3 and delivered_at is null order by id limit 50 for update`,
      [merchantId, phone, channel],
    );
    let sent = 0;
    for (const row of rows as {
      id: string;
      payload: OutboundMessage;
      case_id: string | null;
      next_attempt_at: Date;
    }[]) {
      if (Date.now() >= deadline) break;
      if (!force && new Date(row.next_attempt_at).getTime() > Date.now()) break;
      try {
        await send(row.payload);
      } catch (err) {
        await tx.query(
          `update message_outbox set attempts=attempts+1, last_error=$2,
          next_attempt_at=now()+least(3600, 30*power(2,least(attempts,7))) * interval '1 second' where id=$1`,
          [
            row.id,
            redactText(err instanceof Error ? err.message : "delivery failed"),
          ],
        );
        return { sent, failed: true };
      }
      await recordMessage(tx, {
        merchantId,
        customerWaId: phone,
        caseId: row.case_id,
        direction: "outbound",
        kind: row.payload.type,
        body: outboundSummary(row.payload),
      });
      await tx.query(
        "update message_outbox set delivered_at=clock_timestamp(), attempts=attempts+1, last_error=null where id=$1",
        [row.id],
      );
      sent++;
    }
    return { sent, failed: false };
  });
}

export async function retryReplies(
  db: Database,
  send: (merchantId: string, message: OutboundMessage) => Promise<void>,
) {
  const deadline = Date.now() + 40_000;
  const { rows } =
    await db.query(`select merchant_id, customer_wa_id from message_outbox
    where delivery_channel='whatsapp' and delivered_at is null
    group by merchant_id, customer_wa_id
    having (array_agg(next_attempt_at order by id))[1]<=now()
    order by min(id) limit 100`);
  const summary = { sent: 0, failed: 0 };
  for (const row of rows as { merchant_id: string; customer_wa_id: string }[]) {
    if (Date.now() >= deadline) break;
    const result = await deliverReplies(
      db,
      row.merchant_id,
      row.customer_wa_id,
      (message) => send(row.merchant_id, message),
      "whatsapp",
      false,
      deadline,
    );
    summary.sent += result.sent;
    summary.failed += Number(result.failed);
  }
  return summary;
}
