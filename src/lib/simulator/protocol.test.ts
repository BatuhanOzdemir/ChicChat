import { describe, expect, it } from "vitest";
import { parseSimulatorRequest } from "./protocol";

const base = { merchantId: "m1", phone: "905551112233" };

describe("parseSimulatorRequest", () => {
  it("parses a text message request", () => {
    const r = parseSimulatorRequest({
      ...base,
      action: "message",
      message: { kind: "text", value: "hi" },
    });
    expect(r).toEqual({
      ok: true,
      value: {
        action: "message",
        merchantId: "m1",
        phone: "905551112233",
        message: { kind: "text", value: "hi" },
      },
    });
  });

  it("strips non-digits from the phone", () => {
    const r = parseSimulatorRequest({
      ...base,
      phone: "+90 555 111 22 33",
      action: "state",
    });
    expect(r.ok && r.value.phone).toBe("905551112233");
  });

  it("keeps an explicit messageId so duplicates can be replayed", () => {
    const r = parseSimulatorRequest({
      ...base,
      action: "message",
      message: { kind: "text", value: "hi", messageId: "wamid.dup" },
    });
    expect(r.ok && r.value.message?.messageId).toBe("wamid.dup");
  });

  it("accepts a valid error injection and rejects an unknown one", () => {
    expect(
      parseSimulatorRequest({
        ...base,
        action: "state",
        injectError: "handler_exception",
      }).ok,
    ).toBe(true);
    const bad = parseSimulatorRequest({
      ...base,
      action: "state",
      injectError: "explode",
    });
    expect(bad).toEqual({
      ok: false,
      error: "injectError must be one of handler_exception|integration_down",
    });
  });

  it("requires a positive ageMinutes for time travel", () => {
    expect(
      parseSimulatorRequest({ ...base, action: "time_travel", ageMinutes: 10 })
        .ok,
    ).toBe(true);
    expect(
      parseSimulatorRequest({ ...base, action: "time_travel", ageMinutes: 0 }),
    ).toEqual({ ok: false, error: "ageMinutes must be a positive number" });
  });

  it("rejects malformed bodies without throwing", () => {
    expect(parseSimulatorRequest(null).ok).toBe(false);
    expect(parseSimulatorRequest({ action: "message" }).ok).toBe(false);
    expect(parseSimulatorRequest({ ...base, action: "nope" }).ok).toBe(false);
    expect(
      parseSimulatorRequest({ ...base, action: "message", message: {} }).ok,
    ).toBe(false);
    expect(
      parseSimulatorRequest({
        ...base,
        action: "message",
        message: { kind: "text", value: "" },
      }).ok,
    ).toBe(false);
    expect(
      parseSimulatorRequest({ ...base, phone: "12", action: "state" }).ok,
    ).toBe(false);
  });
});
