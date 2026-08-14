"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDatabase } from "@/db/client";
import { listMerchants } from "@/db/config";
import { MERCHANT_COOKIE } from "@/server/merchant/current";
import { logger } from "@/server/logging/logger";

/**
 * Switch which merchant the console pages act as (Step 6). Replaced by real
 * authentication in Step 7 — until then this is the tenancy seam's front door,
 * so it validates both of its inputs.
 */

/** Only same-site paths, so a crafted form cannot bounce the user off-site. */
function safeReturnPath(raw: string): string {
  return /^\/(?!\/)[\w\-/[\]?=&%.]*$/.test(raw) ? raw : "/cases";
}

export async function selectMerchant(formData: FormData): Promise<void> {
  const requested = String(formData.get("merchant_id") ?? "");
  const back = safeReturnPath(String(formData.get("back") ?? "/cases"));

  // The id comes from a form, so it is checked against the real list rather
  // than trusted — an unknown id leaves the current selection alone.
  const merchants = await listMerchants(getDatabase());
  if (!merchants.some((m) => m.id === requested)) {
    logger.warn("validation_failed", {
      error: "unknown merchant in switcher",
      requested,
    });
    redirect(back);
  }

  (await cookies()).set(MERCHANT_COOKIE, requested, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });

  // Every console page is scoped to this choice, so refresh all of them.
  revalidatePath("/", "layout");
  redirect(back);
}
