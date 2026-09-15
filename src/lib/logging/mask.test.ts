import { describe, expect, it } from "vitest";
import { maskPhone, redactLog, redactText } from "./mask";

it("preserves identifiers and timestamps while sanitizing diagnostic values", () => {
  const id = "00000000-0000-0000-0000-000000000001";
  const ts = "2026-09-09T12:00:00.000Z";
  expect(redactText(`${id} ${ts} 905550001234`)).toBe(`${id} ${ts} ****1234`);
  expect(
    redactLog({ nested: { password: "secret", phone: "905550001234" } }),
  ).toEqual({ nested: { password: "[redacted]", phone: "****1234" } });
});

describe("maskPhone", () => {
  it("keeps only the last four digits", () => {
    expect(maskPhone("905352680403")).toBe("****0403");
    expect(maskPhone("+90 535 268 04 03")).toBe("****0403");
  });

  it("never leaks a short value in full", () => {
    expect(maskPhone("12")).toBe("****12");
    expect(maskPhone("")).toBe("****");
    expect(maskPhone("no digits here")).toBe("****");
  });
});
