import { describe, expect, it } from "vitest";
import { isWithinReturnWindow } from "./window";

describe("isWithinReturnWindow", () => {
  const now = new Date("2026-06-22T12:00:00Z");

  it("is within the window before the deadline", () => {
    // ordered 10 days ago, 30-day window
    expect(isWithinReturnWindow("2026-06-12T12:00:00Z", 30, now)).toBe(true);
  });

  it("is outside the window after the deadline", () => {
    // ordered 40 days ago, 30-day window
    expect(isWithinReturnWindow("2026-05-13T12:00:00Z", 30, now)).toBe(false);
  });

  it("includes the deadline day itself", () => {
    expect(isWithinReturnWindow("2026-05-23T12:00:00Z", 30, now)).toBe(true);
  });

  it("returns false for an unparseable date", () => {
    expect(isWithinReturnWindow("not-a-date", 30, now)).toBe(false);
  });
});
