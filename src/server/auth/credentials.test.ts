import { expect, it } from "vitest";
import { hashPassword, tokenHash, verifyPassword } from "./credentials";

it("salts passwords and verifies without storing the original secret", async () => {
  const first = await hashPassword("a-test-password");
  const second = await hashPassword("a-test-password");
  expect(first).not.toBe(second);
  expect(first).not.toContain("a-test-password");
  expect(await verifyPassword("a-test-password", first)).toBe(true);
  expect(await verifyPassword("wrong", first)).toBe(false);
  expect(await verifyPassword("a-test-password", "malformed")).toBe(false);
  expect(tokenHash("session-token")).toMatch(/^[a-f0-9]{64}$/);
  expect(tokenHash("session-token")).not.toBe(tokenHash("another-token"));
});
