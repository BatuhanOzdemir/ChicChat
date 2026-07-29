"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  constantTimeEqual,
  PASSCODE_COOKIE,
  safeNextPath,
} from "@/lib/auth/gate";
import { logger } from "@/server/logging/logger";

/**
 * Exchange the passcode for a session cookie (Step 7).
 *
 * The cookie holds the passcode itself, which is only sound because it is
 * `httpOnly` + `secure` and therefore never readable by page scripts; there is
 * no per-user identity to sign into a token yet. A failed attempt is logged so a
 * brute-force attempt against a deployed instance is visible — rate limiting
 * belongs to the platform in front of the app.
 */
export async function signIn(formData: FormData): Promise<void> {
  const submitted = String(formData.get("passcode") ?? "");
  const next = safeNextPath(String(formData.get("next") ?? ""));
  const expected = (process.env.CONSOLE_PASSCODE ?? "").trim();

  if (expected === "" || !constantTimeEqual(submitted, expected)) {
    logger.warn("webhook_rejected", { reason: "console_passcode_rejected" });
    redirect(`/login?error=1&next=${encodeURIComponent(next)}`);
  }

  (await cookies()).set(PASSCODE_COOKIE, expected, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 12,
  });

  redirect(next);
}
