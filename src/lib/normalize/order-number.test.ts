import { describe, expect, it } from "vitest";
import { normalizeOrderNumber } from "./order-number";

describe("normalizeOrderNumber", () => {
  it("strips spaces and separators from a messy id", () => {
    // gate case
    const r = normalizeOrderNumber("  12/3 4-5 ");
    expect(r.normalized).toBe("12345");
    expect(r.valid).toBe(true);
  });

  it("strips '#' and leading zeros", () => {
    // gate case
    const r = normalizeOrderNumber("#00420");
    expect(r.normalized).toBe("420");
    expect(r.valid).toBe(true);
  });

  it("uppercases and strips '#' and '-' (spec demo)", () => {
    const r = normalizeOrderNumber("#tr-100 432");
    expect(r.normalized).toBe("TR100432");
  });

  it("keeps a single 0 for an all-zero id", () => {
    expect(normalizeOrderNumber("#0000").normalized).toBe("0");
  });

  it("can keep leading zeros when configured", () => {
    expect(
      normalizeOrderNumber("#00420", { stripLeadingZeros: false }).normalized,
    ).toBe("00420");
  });

  it("validates the normalized value against a merchant regex", () => {
    const pattern = "^[A-Z0-9]{4,}$";
    expect(normalizeOrderNumber("tr-100 432", { pattern }).valid).toBe(true);
    // too short after normalization -> invalid id
    expect(normalizeOrderNumber("#00420", { pattern }).valid).toBe(false);
  });

  it("treats empty / noise-only input as invalid", () => {
    const r = normalizeOrderNumber("  ## // ");
    expect(r.normalized).toBe("");
    expect(r.valid).toBe(false);
  });

  it("accepts a RegExp pattern", () => {
    expect(
      normalizeOrderNumber("AB12", { pattern: /^[A-Z]{2}\d{2}$/ }).valid,
    ).toBe(true);
    expect(
      normalizeOrderNumber("ABC", { pattern: /^[A-Z]{2}\d{2}$/ }).valid,
    ).toBe(false);
  });
});
