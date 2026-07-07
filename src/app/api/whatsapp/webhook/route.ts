/**
 * WhatsApp webhook (CLAUDE.md Step 8).
 *  GET  — Meta verification handshake.
 *  POST — inbound messages: verify signature (if configured), parse, and drive
 *         each through the intake handler. Always answers 200 fast so Meta
 *         doesn't retry/throttle.
 */
import {
  parseInbound,
  verifySignature,
  verifyWebhookChallenge,
} from "@/lib/whatsapp";
import { getPool } from "@/db/client";
import { DEMO_MERCHANT_ID } from "@/db/config";
import { getWhatsAppConfig } from "@/server/whatsapp/config";
import { graphSender } from "@/server/whatsapp/client";
import { handleInbound } from "@/server/whatsapp/handler";

export const dynamic = "force-dynamic";

// Single-tenant for now: every inbound routes to the demo merchant. Later,
// resolve the merchant from the inbound phone_number_id.
function resolveMerchantId(): string {
  return DEMO_MERCHANT_ID;
}

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
  return challenge
    ? new Response(challenge, { status: 200 })
    : new Response("forbidden", { status: 403 });
}

export async function POST(req: Request): Promise<Response> {
  const cfg = getWhatsAppConfig();
  const raw = await req.text();

  if (cfg.appSecret) {
    const signature = req.headers.get("x-hub-signature-256");
    if (!verifySignature(raw, signature, cfg.appSecret)) {
      return new Response("invalid signature", { status: 401 });
    }
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response("ok", { status: 200 });
  }

  const pool = getPool();
  const send = graphSender(cfg);

  for (const inbound of parseInbound(body)) {
    try {
      await handleInbound({ db: pool, send }, resolveMerchantId(), inbound);
    } catch (err) {
      console.error("[whatsapp] handleInbound failed:", err);
    }
  }

  return new Response("ok", { status: 200 });
}
