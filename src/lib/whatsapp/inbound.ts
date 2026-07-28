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
    nfm_reply?: { response_json?: string };
  };
  image?: { id?: string };
}

/**
 * Reduce a Flow submission to the value the intake machine consumes.
 *
 * Rule: a single-key payload with a scalar value (the common shape for a
 * one-input Flow screen) yields that scalar; anything richer — notably the
 * multi-item picker — is passed through as raw JSON, because interpreting
 * multi-select payloads into `case_items` is the item-picker step's job.
 */
export function flowReplyValue(responseJson: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseJson);
  } catch {
    return responseJson;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return responseJson;
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length !== 1) return responseJson;
  const [, only] = entries[0];
  if (typeof only === "string") return only;
  if (typeof only === "number" || typeof only === "boolean")
    return String(only);
  return responseJson;
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
          const responseJson = raw.interactive?.nfm_reply?.response_json;
          const id =
            raw.interactive?.list_reply?.id ??
            raw.interactive?.button_reply?.id;
          if (responseJson) {
            out.push({
              ...base,
              kind: "flow",
              reply: flowReplyValue(responseJson),
              flowResponse: responseJson,
            });
          } else if (id) {
            out.push({ ...base, kind: "interactive", reply: id });
          }
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
