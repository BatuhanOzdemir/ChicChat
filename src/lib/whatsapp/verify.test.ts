import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySignature, verifyWebhookChallenge } from "./verify";

describe("verifyWebhookChallenge", () => {
  it("echoes the challenge on a valid handshake", () => {
    expect(
      verifyWebhookChallenge(
        { mode: "subscribe", token: "secret", challenge: "12345" },
        "secret",
      ),
    ).toBe("12345");
  });

  it("returns null on a token mismatch or wrong mode", () => {
    expect(
      verifyWebhookChallenge(
        { mode: "subscribe", token: "wrong", challenge: "12345" },
        "secret",
      ),
    ).toBeNull();
    expect(
      verifyWebhookChallenge(
        { mode: "unsubscribe", token: "secret", challenge: "12345" },
        "secret",
      ),
    ).toBeNull();
  });
});

describe("verifySignature", () => {
  const secret = "app-secret";
  const body = '{"hello":"world"}';
  const good =
    "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

  it("accepts a correct signature", () => {
    expect(verifySignature(body, good, secret)).toBe(true);
  });

  it("rejects a tampered body or missing header", () => {
    expect(verifySignature('{"hello":"tampered"}', good, secret)).toBe(false);
    expect(verifySignature(body, null, secret)).toBe(false);
    expect(verifySignature(body, "sha256=deadbeef", secret)).toBe(false);
  });
});
