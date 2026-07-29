/**
 * WhatsApp webhook (SPEC §§10, 12, 13).
 *
 *  GET  — Meta verification handshake.
 *  POST — verify the signature, acknowledge with 200 **immediately**, then
 *         process after the response (SPEC §10) so a slow conversation never
 *         makes Meta retry or throttle us.
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
import { handleInbound } from "@/server/whatsapp/handler";
import { logger } from "@/server/logging/logger";

export const dynamic = "force-dynamic";

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

  // Acknowledge first, work afterwards (SPEC §10).
  after(async () => {
    const db = getDatabase();
    for (const inbound of messages) {
      try {
        // The number the message was sent to decides the tenant. An unknown
        // number is dropped: replying from someone else's number, or filing the
        // case against a guessed merchant, is worse than losing the message.
        const channel = await resolveMerchantByPhoneNumberId(
          db,
          inbound.phoneNumberId,
        );
        if (!channel) {
          logger.warn("webhook_rejected", {
            reason: "unknown_phone_number_id",
            correlationId: inbound.messageId,
            phone_number_id: inbound.phoneNumberId,
          });
          continue;
        }

        // Reply from the merchant's own number, not the environment default.
        const send = graphSender(cfg, channel.phoneNumberId);
        await handleInbound({ db, send }, channel.merchantId, inbound);
      } catch (err) {
        // handleInbound already handles its own failures; this is belt-and-braces.
        logger.error("unexpected_exception", err, {
          correlationId: inbound.messageId,
          phone: inbound.from,
        });
      }
    }
  });

  return new Response("ok", { status: 200 });
}
