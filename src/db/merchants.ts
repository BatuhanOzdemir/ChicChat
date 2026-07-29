/**
 * Merchant resolution (SPEC §10) — which tenant does this message belong to?
 *
 * Everything downstream of the webhook is merchant-scoped, so this is the one
 * place that turns Meta's `phone_number_id` into a merchant id. An unknown
 * number resolves to `null` rather than throwing or falling back to a default:
 * guessing the tenant is worse than dropping the message.
 */
import type { Queryable } from "./database";

export interface ResolvedChannel {
  merchantId: string;
  merchantName: string;
  channelId: string;
  phoneNumberId: string;
  wabaId: string | null;
}

export async function resolveMerchantByPhoneNumberId(
  db: Queryable,
  phoneNumberId: string,
): Promise<ResolvedChannel | null> {
  const { rows } = await db.query(
    `select ch.id as channel_id, ch.phone_number_id, ch.waba_id,
            m.id as merchant_id, m.name as merchant_name
       from whatsapp_channels ch
       join merchants m on m.id = ch.merchant_id
      where ch.phone_number_id = $1`,
    [phoneNumberId],
  );
  const row = rows[0] as
    | {
        channel_id: string;
        phone_number_id: string;
        waba_id: string | null;
        merchant_id: string;
        merchant_name: string;
      }
    | undefined;
  if (!row) return null;

  return {
    merchantId: row.merchant_id,
    merchantName: row.merchant_name,
    channelId: row.channel_id,
    phoneNumberId: row.phone_number_id,
    wabaId: row.waba_id,
  };
}

/**
 * The number a merchant sends from — needed by anything that starts a
 * conversation rather than replying to one (the inactivity nudge, SPEC §11).
 * Null when the merchant has no channel yet, in which case the caller falls
 * back to the environment's number.
 */
export async function primaryChannel(
  db: Queryable,
  merchantId: string,
): Promise<{ phoneNumberId: string; wabaId: string | null } | null> {
  const { rows } = await db.query(
    `select phone_number_id, waba_id from whatsapp_channels
      where merchant_id = $1
      order by is_primary desc, created_at
      limit 1`,
    [merchantId],
  );
  const row = rows[0] as
    | { phone_number_id: string; waba_id: string | null }
    | undefined;
  return row
    ? { phoneNumberId: row.phone_number_id, wabaId: row.waba_id }
    : null;
}

export interface MerchantChannel {
  id: string;
  phone_number_id: string;
  waba_id: string | null;
  display_number: string | null;
  is_primary: boolean;
}

/** A merchant's channels, for the config page. */
export async function listChannels(
  db: Queryable,
  merchantId: string,
): Promise<MerchantChannel[]> {
  const { rows } = await db.query(
    `select id, phone_number_id, waba_id, display_number, is_primary
       from whatsapp_channels
      where merchant_id = $1
      order by is_primary desc, created_at`,
    [merchantId],
  );
  return rows as MerchantChannel[];
}
