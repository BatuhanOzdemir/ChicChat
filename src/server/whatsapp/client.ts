/**
 * WhatsApp Cloud API transport (CLAUDE.md Step 8): send an outbound message via
 * the Graph API. Returns a `Sender` so the intake handler stays testable with an
 * in-memory stand-in.
 */
import type { OutboundMessage } from "@/lib/whatsapp";
import type { WhatsAppConfig } from "./config";

export type Sender = (message: OutboundMessage) => Promise<void>;

export function graphSender(config: WhatsAppConfig): Sender {
  return async (message) => {
    const url = `https://graph.facebook.com/${config.graphVersion}/${config.phoneNumberId}/messages`;
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
