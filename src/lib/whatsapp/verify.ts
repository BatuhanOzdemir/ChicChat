/**
 * Webhook verification (CLAUDE.md Step 8).
 *  - GET handshake: Meta calls with hub.mode/hub.verify_token/hub.challenge.
 *  - POST authenticity: optional X-Hub-Signature-256 HMAC over the raw body.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Return the challenge to echo back when the handshake is valid, else null. */
export function verifyWebhookChallenge(
  params: {
    mode: string | null;
    token: string | null;
    challenge: string | null;
  },
  expectedToken: string,
): string | null {
  if (
    params.mode === "subscribe" &&
    params.token != null &&
    params.token === expectedToken &&
    params.challenge != null
  ) {
    return params.challenge;
  }
  return null;
}

/** Verify the X-Hub-Signature-256 header against the raw request body. */
export function verifySignature(
  rawBody: string,
  signatureHeader: string | null,
  appSecret: string,
): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret)
    .update(rawBody)
    .digest("hex");
  const received = signatureHeader.slice("sha256=".length);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(received, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
