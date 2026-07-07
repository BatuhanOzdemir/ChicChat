/**
 * WhatsApp Cloud API message shapes (CLAUDE.md Step 8, SPEC §6). Only the
 * fields ChicChat uses — inbound parsing + outbound List Messages / text.
 */

/** A parsed inbound message, reduced to what the intake machine needs. */
export interface InboundMessage {
  phoneNumberId: string;
  from: string; // customer wa_id
  messageId: string;
  kind: "text" | "interactive" | "image" | "other";
  /** The value to feed intake `advance()`: list-reply id, text body, or media id. */
  reply: string;
  /** Present for image messages (a WhatsApp media id used as the photo ref). */
  mediaId?: string;
}

export interface ListRow {
  id: string;
  title: string;
  description?: string;
}

/** An outbound message body (without messaging_product, which the client adds). */
export type OutboundMessage =
  | { to: string; type: "text"; text: { body: string } }
  | {
      to: string;
      type: "interactive";
      interactive: {
        type: "list";
        header?: { type: "text"; text: string };
        body: { text: string };
        action: {
          button: string;
          sections: { title: string; rows: ListRow[] }[];
        };
      };
    };
