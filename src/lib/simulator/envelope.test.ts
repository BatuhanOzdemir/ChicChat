import { describe, expect, it } from "vitest";
import { buildInboundEnvelope } from "./envelope";
import { parseInbound } from "../whatsapp";

const ctx = {
  phoneNumberId: "PNID",
  from: "905551112233",
  messageId: "wamid.sim1",
};

/**
 * The envelope must be shaped exactly like a Meta delivery: the proof is that
 * the production parser reads it back correctly (SPEC §7 — only the signature
 * is bypassed, everything downstream is identical).
 */
describe("buildInboundEnvelope round-trips through the production parser", () => {
  it("text", () => {
    const env = buildInboundEnvelope({ kind: "text", value: "hi" }, ctx);
    expect(parseInbound(env)).toEqual([
      {
        phoneNumberId: "PNID",
        from: "905551112233",
        messageId: "wamid.sim1",
        kind: "text",
        reply: "hi",
      },
    ]);
  });

  it("list tap becomes an interactive reply carrying the row id", () => {
    const env = buildInboundEnvelope({ kind: "list", value: "return" }, ctx);
    expect(parseInbound(env)[0]).toMatchObject({
      kind: "interactive",
      reply: "return",
    });
  });

  it("photo becomes an image with a media id", () => {
    const env = buildInboundEnvelope({ kind: "photo", value: "media_1" }, ctx);
    expect(parseInbound(env)[0]).toMatchObject({
      kind: "image",
      reply: "media_1",
      mediaId: "media_1",
    });
  });

  it("flow submission becomes a flow message with the raw response kept", () => {
    const responseJson = JSON.stringify({ item_ref: "Navy jacket" });
    const env = buildInboundEnvelope(
      { kind: "flow", value: responseJson },
      ctx,
    );
    expect(parseInbound(env)[0]).toMatchObject({
      kind: "flow",
      reply: "Navy jacket",
      flowResponse: responseJson,
    });
  });
});
