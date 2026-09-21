import { expect, it } from "vitest";
import { formatDateTime } from "./date";

it("shows day/month/year in Istanbul time even across a UTC day boundary", () => {
  expect(formatDateTime("2026-09-14T22:05:00Z")).toBe("15/09/2026, 01:05");
});
it("handles unavailable dates", () => {
  expect(formatDateTime("invalid")).toBe("—");
});
