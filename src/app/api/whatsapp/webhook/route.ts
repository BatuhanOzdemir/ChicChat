/**
 * WhatsApp webhook (SPEC §§10, 12, 13).
 *
 *  GET  — Meta verification handshake.
 *  POST — verify the signature, commit accepted messages to the inbox, then
 *         acknowledge with 200 and process after the response. Failed storage
 *         returns 503 so Meta can retry.
 */
import { after } from "next/server";
import {
  parseInbound,
  verifySignature,
  verifyWebhookChallenge,
} from "@/lib/whatsapp";
import { getDatabase } from "@/db/client";
import { resolveMerchantByPhoneNumberId } from "@/db/merchants";
import { getWhatsAppConfig } from "@/server/whatsapp/config";
import { graphSender } from "@/server/whatsapp/client";
import { acceptMessages, processInbox } from "@/server/whatsapp/inbox";
import { primaryChannel } from "@/db/merchants";
import { logger } from "@/server/logging/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export function GET(req: Request): Response {
  const cfg = getWhatsAppConfig();
  const params = new URL(req.url).searchParams;
  const challenge = verifyWebhookChallenge(
    {
      mode: params.get("hub.mode"),
      token: params.get("hub.verify_token"),
      challenge: params.get("hub.challenge"),
    },
    cfg.verifyToken,
  );
  if (!challenge) {
    logger.warn("webhook_rejected", { reason: "verification_failed" });
    return new Response("forbidden", { status: 403 });
  }
  return new Response(challenge, { status: 200 });
}

/** Signature verification is mandatory; only local development may opt out. */
function signatureOk(raw: string, req: Request, appSecret?: string): boolean {
  if (appSecret) {
    return verifySignature(
      raw,
      req.headers.get("x-hub-signature-256"),
      appSecret,
    );
  }
  if (process.env.NODE_ENV === "production") {
    logger.error("webhook_rejected", new Error("WHATSAPP_APP_SECRET not set"), {
      reason: "missing_app_secret",
    });
    return false;
  }
  logger.warn("webhook_rejected", {
    reason: "signature_unverified_dev_only",
    detail:
      "set WHATSAPP_APP_SECRET to enable X-Hub-Signature-256 verification",
  });
  return true;
}

export async function POST(req: Request): Promise<Response> {
  const cfg = getWhatsAppConfig();
  const raw = await req.text();

  if (!signatureOk(raw, req, cfg.appSecret)) {
    return new Response("invalid signature", { status: 401 });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    logger.warn("validation_failed", { reason: "malformed_json" });
    return new Response("ok", { status: 200 }); // SPEC §13: log, drop, 200.
  }

  const messages = parseInbound(body);
  logger.info("webhook_received", { messages: messages.length });

  const db = getDatabase();
  try {
    const accepted = [];
    for (const inbound of messages) {
      const channel = await resolveMerchantByPhoneNumberId(
        db,
        inbound.phoneNumberId,
      );
      if (channel) accepted.push({ merchantId: channel.merchantId, inbound });
      else
        logger.warn("webhook_rejected", {
          reason: "unknown_phone_number_id",
          correlationId: inbound.messageId,
        });
    }
    await acceptMessages(db, accepted);
  } catch (err) {
    logger.error("unexpected_exception", err, { during: "inbox_accept" });
    // No durable copy exists: a 503 deliberately requests redelivery from Meta.
    return new Response("temporarily unavailable", { status: 503 });
  }
  after(async () => {
    try {
      await processInbox(db, async (merchantId, message) => {
        const channel = await primaryChannel(db, merchantId);
        if (!channel) throw new Error("merchant channel unavailable");
        await graphSender(cfg, channel.phoneNumberId)(message);
      });
    } catch (err) {
      logger.error("unexpected_exception", err, { during: "inbox_worker" });
    }
  });
  return new Response("ok", { status: 200 });
}
