import type { OutboundMessage } from "@/lib/whatsapp";
import type { Queryable } from "./database";

export type DeliveryChannel = "whatsapp" | "simulator";

export async function enqueueReply(
  db: Queryable,
  input: {
    merchantId: string;
    phone: string;
    key: string;
    message: OutboundMessage;
    channel: DeliveryChannel;
    caseId?: string | null;
  },
): Promise<void> {
  await db.query(
    `insert into message_outbox
    (merchant_id, customer_wa_id, delivery_key, delivery_channel, payload, case_id)
    values ($1,$2,$3,$4,$5,$6) on conflict (merchant_id, delivery_key) do nothing`,
    [
      input.merchantId,
      input.phone,
      input.key,
      input.channel,
      JSON.stringify(input.message),
      input.caseId ?? null,
    ],
  );
}
