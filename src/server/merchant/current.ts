/**
 * Which merchant do the console pages act as? (Step 6 multi-tenancy seam.)
 *
 * There is no auth yet — that arrives with deployment (Step 7) — so the choice
 * lives in a cookie set by the switcher. The cookie is untrusted input like any
 * other: its value is only ever used after matching it against the merchants
 * that actually exist, never passed into a query directly. When it is missing or
 * stale, the first merchant by name is used, so a fresh browser still works.
 */
import { cookies } from "next/headers";
import { listMerchants } from "@/db/config";
import type { Queryable } from "@/db/database";

export const MERCHANT_COOKIE = "chicchat_merchant";

export interface MerchantOption {
  id: string;
  name: string;
  locale: string;
  rtl: boolean;
}

export interface MerchantContext {
  /** The merchant every query on this page is scoped to. */
  current: MerchantOption;
  /** Everything available to switch to. */
  options: MerchantOption[];
}

/** Null only when the database has no merchants at all (unseeded). */
export async function merchantContext(
  db: Queryable,
): Promise<MerchantContext | null> {
  const options = await listMerchants(db);
  if (options.length === 0) return null;

  const selected = (await cookies()).get(MERCHANT_COOKIE)?.value;
  const current = options.find((m) => m.id === selected) ?? options[0];
  return { current, options };
}

/** The merchant id for a server action, resolved the same way as the page. */
export async function currentMerchantId(db: Queryable): Promise<string | null> {
  return (await merchantContext(db))?.current.id ?? null;
}
