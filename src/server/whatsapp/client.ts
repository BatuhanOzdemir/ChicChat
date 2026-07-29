/**
 * WhatsApp Cloud API transport (CLAUDE.md Step 8): send an outbound message via
 * the Graph API. Returns a `Sender` so the intake handler stays testable with an
 * in-memory stand-in.
 */
import type { OutboundMessage } from "@/lib/whatsapp";
import type { WhatsAppConfig } from "./config";

export type Sender = (message: OutboundMessage) => Promise<void>;

/**
 * `phoneNumberId` overrides the environment's number, so a reply goes out from
 * the number the customer actually messaged (SPEC §10 multi-tenancy). The access
 * token is still environment-level — per-merchant credentials arrive with
 * deployment secrets (Step 7).
 */
export function graphSender(
  config: WhatsAppConfig,
  phoneNumberId?: string | null,
): Sender {
  const from = phoneNumberId ?? config.phoneNumberId;
  return async (message) => {
    const url = `https://graph.facebook.com/${config.graphVersion}/${from}/messages`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        ...message,
      }),
    });
    if (!res.ok) {
      throw new Error(
        `WhatsApp send failed (${res.status}): ${await res.text()}`,
      );
    }
  };
}
