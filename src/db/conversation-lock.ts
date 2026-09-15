import type { Queryable } from "./database";

/** Call inside a transaction, before any conversation reads (including no-session first contact). */
export async function lockConversation(
  db: Queryable,
  merchantId: string,
  phone: string,
): Promise<void> {
  await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `${merchantId}:${phone}`,
  ]);
}
