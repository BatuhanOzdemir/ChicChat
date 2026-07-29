/**
 * Session maintenance endpoint (SPEC §11) — the cleanup job's trigger, meant to
 * be called on a schedule (cron / platform scheduler).
 *
 * Protected by a shared secret when `MAINTENANCE_SECRET` or `CRON_SECRET` is
 * set; in production a secret is required. Accepts GET as well as POST, because
 * platform schedulers (Vercel Cron among them) invoke with GET and supply the
 * bearer token themselves.
 */
import { getDatabase } from "@/db/client";
import { primaryChannel } from "@/db/merchants";
import { getWhatsAppConfig } from "@/server/whatsapp/config";
import { graphSender } from "@/server/whatsapp/client";
import { runSessionMaintenance } from "@/server/maintenance/sessions";
import { logger } from "@/server/logging/logger";

export const dynamic = "force-dynamic";

function authorized(req: Request): boolean {
  // CRON_SECRET is the name the platform scheduler sets; MAINTENANCE_SECRET is
  // for calling the job by hand. Either is sufficient.
  const secrets = [
    process.env.MAINTENANCE_SECRET,
    process.env.CRON_SECRET,
  ].filter((s): s is string => typeof s === "string" && s.trim() !== "");

  if (secrets.length > 0) {
    const header = req.headers.get("authorization") ?? "";
    return secrets.some((secret) => header === `Bearer ${secret}`);
  }
  // No secret configured: allowed locally, refused in production.
  return process.env.NODE_ENV !== "production";
}

async function runMaintenance(req: Request): Promise<Response> {
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

export const POST = runMaintenance;
/** Scheduled invocations arrive as GET. */
export const GET = runMaintenance;
