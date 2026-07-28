import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "./logger";

function captured(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  const call = spy.mock.calls.at(-1);
  return JSON.parse(String(call?.[0])) as Record<string, unknown>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("structured logger (Handbook §8)", () => {
  it("emits one JSON line carrying merchant id and correlation id", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logger.info("case_persisted", {
      merchantId: "m-1",
      correlationId: "wamid.9",
      case_id: "c-1",
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const line = captured(spy);
    expect(line).toMatchObject({
      level: "info",
      event: "case_persisted",
      merchant_id: "m-1",
      correlation_id: "wamid.9",
      case_id: "c-1",
    });
    expect(typeof line.ts).toBe("string");
  });

  it("never logs a phone number in full (SPEC §12)", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logger.info("webhook_received", { phone: "905352680403" });

    const serialized = String(spy.mock.calls.at(-1)?.[0]);
    expect(serialized).not.toContain("905352680403");
    expect(captured(spy).phone).toBe("****0403");
  });

  it("sends errors to stderr with message and stack", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logger.error("unexpected_exception", new Error("boom"), {
      merchantId: "m-1",
      correlationId: "wamid.9",
    });

    const line = captured(spy);
    expect(line).toMatchObject({
      level: "error",
      event: "unexpected_exception",
      error_message: "boom",
    });
    expect(String(line.stack)).toContain("Error: boom");
  });
});
