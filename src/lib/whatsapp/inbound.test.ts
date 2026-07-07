import { describe, expect, it } from "vitest";
import { parseInbound } from "./inbound";

function envelope(message: unknown) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: "PNID1" },
              messages: [message],
            },
          },
        ],
      },
    ],
  };
}

describe("parseInbound", () => {
  it("parses a text message", () => {
    const [m] = parseInbound(
      envelope({
        from: "905551112233",
        id: "wamid.1",
        type: "text",
        text: { body: "hi" },
      }),
    );
    expect(m).toMatchObject({
      phoneNumberId: "PNID1",
      from: "905551112233",
      kind: "text",
      reply: "hi",
    });
  });

  it("parses an interactive list reply to its row id", () => {
    const [m] = parseInbound(
      envelope({
        from: "905551112233",
        id: "wamid.2",
        type: "interactive",
        interactive: { type: "list_reply", list_reply: { id: "return" } },
      }),
    );
    expect(m).toMatchObject({ kind: "interactive", reply: "return" });
  });

  it("parses an image to its media id", () => {
    const [m] = parseInbound(
      envelope({
        from: "9055",
        id: "wamid.3",
        type: "image",
        image: { id: "media_9" },
      }),
    );
    expect(m).toMatchObject({
      kind: "image",
      reply: "media_9",
      mediaId: "media_9",
    });
  });

  it("ignores status/delivery events", () => {
    const body = {
      entry: [
        { changes: [{ value: { statuses: [{ status: "delivered" }] } }] },
      ],
    };
    expect(parseInbound(body)).toEqual([]);
  });

  it("never throws on malformed input", () => {
    expect(parseInbound(null)).toEqual([]);
    expect(parseInbound({})).toEqual([]);
  });
});
