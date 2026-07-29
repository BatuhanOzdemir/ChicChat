import { describe, expect, it } from "vitest";
import { parseCaseFilters } from "./filters";

describe("parseCaseFilters", () => {
  it("defaults to no filters on page 1", () => {
    expect(parseCaseFilters({})).toEqual({
      ok: true,
      value: {
        status: null,
        categoryKey: null,
        from: null,
        to: null,
        orderNumber: null,
        page: 1,
      },
    });
  });

  it("normalizes the order-number search so messy input still matches", () => {
    const r = parseCaseFilters({ order_number: "  #tr-100 432 " });
    expect(r.ok && r.value.orderNumber).toBe("TR100432");
  });

  it("accepts a status, category and date range", () => {
    const r = parseCaseFilters({
      status: "abandoned",
      category: "return",
      from: "2026-07-01",
      to: "2026-07-31",
      page: "3",
    });
    expect(r.ok && r.value).toMatchObject({
      status: "abandoned",
      categoryKey: "return",
      from: "2026-07-01",
      to: "2026-07-31",
      page: 3,
    });
  });

  it("rejects an unknown status", () => {
    expect(parseCaseFilters({ status: "exploded" })).toEqual({
      ok: false,
      error: 'unknown status "exploded"',
    });
  });

  it("rejects malformed dates and an inverted range", () => {
    expect(parseCaseFilters({ from: "01/07/2026" }).ok).toBe(false);
    expect(parseCaseFilters({ from: "2026-08-01", to: "2026-07-01" })).toEqual({
      ok: false,
      error: "from must not be after to",
    });
  });

  it("rejects a bad page", () => {
    expect(parseCaseFilters({ page: "0" }).ok).toBe(false);
    expect(parseCaseFilters({ page: "abc" }).ok).toBe(false);
  });
});
