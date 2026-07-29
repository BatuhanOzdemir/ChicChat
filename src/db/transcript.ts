/**
 * Conversation transcript (SPEC §9): what the customer sent and what the bot
 * composed, in order, so an agent reading a case can see the exchange behind
 * the captured fields.
 *
 * Rows are written while the conversation is still in progress — before any
 * case exists — and stamped with `case_id` when the intake completes, which is
 * why `case_id` is nullable. The transcript records what the bot *composed*;
 * WhatsApp delivery receipts are not tracked in v0.2.
 */
import type { Queryable } from "./database";

export type MessageDirection = "inbound" | "outbound";

export interface TranscriptEntry {
  direction: MessageDirection;
  kind: string;
  body: string | null;
  wa_message_id: string | null;
  created_at: string;
}

export interface RecordMessageInput {
  merchantId: string;
  customerWaId: string;
  direction: MessageDirection;
  kind: string;
  body: string | null;
  waMessageId?: string | null;
  /** Set only when the case already exists (e.g. the completion reply). */
  caseId?: string | null;
}

export async function recordMessage(
  db: Queryable,
  input: RecordMessageInput,
): Promise<void> {
  await db.query(
    `insert into conversation_messages
       (merchant_id, customer_wa_id, case_id, direction, kind, body, wa_message_id)
     values ($1, $2, $3, $4, $5, $6, $7)
     -- One entry per inbound WhatsApp message: the error path re-records the
     -- customer's message because its transaction may have rolled back, and
     -- this makes that a no-op when it did not. Outbound rows carry no id and
     -- never conflict.
     on conflict (merchant_id, wa_message_id)
       where direction = 'inbound' and wa_message_id is not null
       do nothing`,
    [
      input.merchantId,
      input.customerWaId,
      input.caseId ?? null,
      input.direction,
      input.kind,
      input.body,
      input.waMessageId ?? null,
    ],
  );
}

/**
 * Attach this conversation's so-far-unattached messages to the case it produced.
 * Called inside the case-creation transaction, so a case always ships with its
 * transcript or neither is written.
 */
export async function linkMessagesToCase(
  db: Queryable,
  merchantId: string,
  customerWaId: string,
  caseId: string,
): Promise<number> {
  const { rows } = await db.query(
    `update conversation_messages
        set case_id = $3
      where merchant_id = $1 and customer_wa_id = $2 and case_id is null
      returning id`,
    [merchantId, customerWaId, caseId],
  );
  return rows.length;
}

/** The read-only transcript for one case. Merchant-scoped through `cases`. */
export async function listTranscript(
  db: Queryable,
  merchantId: string,
  caseId: string,
): Promise<TranscriptEntry[]> {
  const { rows } = await db.query(
    `select m.direction, m.kind, m.body, m.wa_message_id, m.created_at
       from conversation_messages m
       join cases c on c.id = m.case_id
      where m.case_id = $2 and c.merchant_id = $1
      order by m.created_at, m.id`,
    [merchantId, caseId],
  );
  return rows as TranscriptEntry[];
}
