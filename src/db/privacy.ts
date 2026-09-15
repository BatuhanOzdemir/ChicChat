import type { Database } from "./database";
import { lockConversation } from "./conversation-lock";

/** Erasure is tenant/phone scoped. A cutoff implements record-age retention without deleting newer work. */
export async function eraseCustomer(
  db: Database,
  merchantId: string,
  phone: string,
  before: Date | null = null,
): Promise<number> {
  return db.transaction(async (tx) => {
    await lockConversation(tx, merchantId, phone);
    let deleted = 0;
    for (const table of [
      "message_outbox",
      "message_inbox",
      "conversation_messages",
      "conversation_media",
      "processed_messages",
      "intake_sessions",
      "cases",
    ] as const) {
      const clock =
        table === "processed_messages"
          ? "processed_at"
          : table === "intake_sessions"
            ? "updated_at"
            : "created_at";
      // Delete transcript/evidence/pending replies before their parent case can SET NULL.
      const parent = [
        "message_outbox",
        "conversation_messages",
        "conversation_media",
      ].includes(table)
        ? "or case_id in (select id from cases where merchant_id=$1 and customer_wa_id=$2 and created_at<$3)"
        : "";
      const { rows } = await tx.query(
        `delete from ${table} where merchant_id=$1 and customer_wa_id=$2
        and ($3::timestamptz is null or ${clock}<$3 ${parent}) returning 1`,
        [merchantId, phone, before],
      );
      deleted += rows.length;
    }
    return deleted;
  });
}

/** One bounded batch; repeated scheduled runs continue through all expired records. */
export async function enforceRetention(db: Database): Promise<number> {
  const { rows } = await db.query(`with records as (
    select merchant_id, customer_wa_id, created_at as at from cases union all
    select merchant_id, customer_wa_id, created_at from conversation_messages union all
    select merchant_id, customer_wa_id, created_at from conversation_media union all
    select merchant_id, customer_wa_id, updated_at from intake_sessions union all
    select merchant_id, customer_wa_id, created_at from message_inbox union all
    select merchant_id, customer_wa_id, created_at from message_outbox union all
    select merchant_id, customer_wa_id, processed_at from processed_messages
  ) select r.merchant_id, r.customer_wa_id,
      now()-make_interval(months=>coalesce(c.retention_months,12)) as cutoff
    from records r left join merchant_config c on c.merchant_id=r.merchant_id
    where r.customer_wa_id is not null and r.at < now()-make_interval(months=>coalesce(c.retention_months,12))
    group by r.merchant_id,r.customer_wa_id,c.retention_months order by min(r.at) limit 200`);
  let deleted = 0;
  for (const row of rows as {
    merchant_id: string;
    customer_wa_id: string;
    cutoff: Date;
  }[]) {
    deleted += await eraseCustomer(
      db,
      row.merchant_id,
      row.customer_wa_id,
      row.cutoff,
    );
  }
  await db.transaction(async (tx) => {
    await tx.query("delete from console_sessions where expires_at<now()");
    await tx.query(
      "delete from console_login_attempts where window_started_at<now()-interval '1 day'",
    );
    // Legacy ledger rows without a phone cannot be matched to erasure; expire them by age.
    await tx.query(`delete from processed_messages p using merchant_config c where p.merchant_id=c.merchant_id
      and p.customer_wa_id is null and p.processed_at < now()-make_interval(months=>c.retention_months)`);
  });
  return deleted;
}
