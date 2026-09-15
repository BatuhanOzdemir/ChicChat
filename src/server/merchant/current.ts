/**
 * Which merchant do the console pages act as? (Step 6 multi-tenancy seam.)
 *
 * The selection cookie is only a preference. Every request resolves current
 * account membership before selecting a tenant; a stale preference falls back
 * to the first authorized merchant. Local development can explicitly bypass login.
 */
import { cookies } from "next/headers";
import { requirePrincipal } from "@/server/auth/current";
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

/** Null when the current account has no available merchants. */
export async function merchantContext(
  db: Queryable,
): Promise<MerchantContext | null> {
  const principal = await requirePrincipal(db);
  const options = (await listMerchants(db)).filter(
    (m) => !principal || principal.merchantIds.includes(m.id),
  );
  if (options.length === 0) return null;

  const selected = (await cookies()).get(MERCHANT_COOKIE)?.value;
  const current = options.find((m) => m.id === selected) ?? options[0];
  return { current, options };
}

/** The merchant id for a server action, resolved the same way as the page. */
export async function currentMerchantId(db: Queryable): Promise<string | null> {
  return (await merchantContext(db))?.current.id ?? null;
}
