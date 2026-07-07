/**
 * Parse a WhatsApp webhook POST body into the inbound messages we act on
 * (CLAUDE.md Step 8). Ignores status/delivery events and anything without a
 * usable payload. Never throws on malformed input — returns what it can.
 */
import type { InboundMessage } from "./types";

interface RawMessage {
  from?: string;
  id?: string;
  type?: string;
  text?: { body?: string };
  interactive?: {
    type?: string;
    list_reply?: { id?: string };
    button_reply?: { id?: string };
  };
  image?: { id?: string };
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function parseInbound(body: unknown): InboundMessage[] {
  const out: InboundMessage[] = [];
  const root = body as { entry?: unknown };

  for (const entry of asArray(root?.entry)) {
    for (const change of asArray((entry as { changes?: unknown }).changes)) {
      const value = (change as { value?: unknown }).value as
        | {
            metadata?: { phone_number_id?: string };
            messages?: unknown;
          }
        | undefined;
      const phoneNumberId = value?.metadata?.phone_number_id ?? "";

      for (const raw of asArray(value?.messages) as RawMessage[]) {
        if (!raw.from || !raw.id) continue;
        const base = {
          phoneNumberId,
          from: raw.from,
          messageId: raw.id,
        };

        if (raw.type === "interactive") {
          const id =
            raw.interactive?.list_reply?.id ??
            raw.interactive?.button_reply?.id;
          if (id) out.push({ ...base, kind: "interactive", reply: id });
        } else if (raw.type === "text" && raw.text?.body) {
          out.push({ ...base, kind: "text", reply: raw.text.body });
        } else if (raw.type === "image" && raw.image?.id) {
          out.push({
            ...base,
            kind: "image",
            reply: raw.image.id,
            mediaId: raw.image.id,
          });
        } else {
          out.push({ ...base, kind: "other", reply: "" });
        }
      }
    }
  }

  return out;
}
