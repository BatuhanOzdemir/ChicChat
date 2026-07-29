/**
 * Session maintenance endpoint (SPEC §11) — the cleanup job's trigger, meant to
 * be called on a schedule (cron / platform scheduler).
 *
 * Protected by a shared secret when `MAINTENANCE_SECRET` is set; in production
 * the secret is required.
 */
import { getDatabase } from "@/db/client";
import { primaryChannel } from "@/db/merchants";
import { getWhatsAppConfig } from "@/server/whatsapp/config";
import { graphSender } from "@/server/whatsapp/client";
import { runSessionMaintenance } from "@/server/maintenance/sessions";
import { logger } from "@/server/logging/logger";

export const dynamic = "force-dynamic";

function authorized(req: Request): boolean {
  const secret = process.env.MAINTENANCE_SECRET;
  if (secret) {
    return req.headers.get("authorization") === `Bearer ${secret}`;
  }
  return process.env.NODE_ENV !== "production";
}

export async function POST(req: Request): Promise<Response> {
  if (!authorized(req)) {
    logger.warn("webhook_rejected", { reason: "maintenance_unauthorized" });
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const db = getDatabase();
    const cfg = getWhatsAppConfig();
    // The job spans tenants, so each nudge goes out from its own merchant's
    // number (SPEC §10). Senders are cached per run, not per session.
    const senders = new Map<string, ReturnType<typeof graphSender>>();

    const summary = await runSessionMaintenance({
      db,
      send: async (merchantId, message) => {
        let send = senders.get(merchantId);
        if (!send) {
          const channel = await primaryChannel(db, merchantId);
          send = graphSender(cfg, channel?.phoneNumberId);
          senders.set(merchantId, send);
        }
        await send(message);
      },
    });
    return Response.json(summary, { status: 200 });
  } catch (err) {
    logger.error("unexpected_exception", err, {
      during: "session_maintenance",
    });
    return Response.json({ error: "maintenance failed" }, { status: 500 });
  }
}
