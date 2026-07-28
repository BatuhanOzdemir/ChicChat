/**
 * Build a real WhatsApp webhook envelope from simulator input (SPEC §7).
 *
 * The simulator injects synthetic messages into the *production* pipeline: the
 * envelope produced here is the same shape Meta POSTs, so it goes through the
 * same `parseInbound` and the same handler. Only the signature check is
 * bypassed — everything downstream is identical.
 */
import type { SimulatorMessageInput } from "./protocol";

export interface EnvelopeContext {
  phoneNumberId: string;
  displayPhoneNumber?: string;
  businessAccountId?: string;
  from: string;
  messageId: string;
}

function messageFor(
  input: SimulatorMessageInput,
  ctx: EnvelopeContext,
): Record<string, unknown> {
  const base = {
    from: ctx.from,
    id: ctx.messageId,
    timestamp: "0",
  };

  switch (input.kind) {
    case "text":
      return { ...base, type: "text", text: { body: input.value } };

    case "list":
      // A tapped List Message row (the "Listeyi Gör" pattern, SPEC §6).
      return {
        ...base,
        type: "interactive",
        interactive: {
          type: "list_reply",
          list_reply: { id: input.value, title: input.value },
        },
      };

    case "photo":
      return {
        ...base,
        type: "image",
        image: { id: input.value, mime_type: "image/jpeg" },
      };

    case "flow":
      // Flow submission: Meta delivers the payload as an nfm_reply.
      return {
        ...base,
        type: "interactive",
        interactive: {
          type: "nfm_reply",
          nfm_reply: {
            name: "flow",
            body: "Sent",
            response_json: input.value,
          },
        },
      };
  }
}

export function buildInboundEnvelope(
  input: SimulatorMessageInput,
  ctx: EnvelopeContext,
): unknown {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: ctx.businessAccountId ?? "SIMULATOR_WABA",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number:
                  ctx.displayPhoneNumber ?? ctx.phoneNumberId,
                phone_number_id: ctx.phoneNumberId,
              },
              contacts: [{ profile: { name: "Simulator" }, wa_id: ctx.from }],
              messages: [messageFor(input, ctx)],
            },
          },
        ],
      },
    ],
  };
}
