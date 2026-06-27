import { describe, expect, it } from "vitest";
import { constrainEnum } from "./enums";

const REASONS = ["damaged", "defective", "wrong_item"] as const;

describe("constrainEnum", () => {
  it("matches case-insensitively and returns the canonical value", () => {
    const r = constrainEnum("Damaged", REASONS);
    expect(r.normalized).toBe("damaged");
    expect(r.valid).toBe(true);
  });

  it("trims surrounding whitespace", () => {
    expect(constrainEnum("  defective  ", REASONS).normalized).toBe(
      "defective",
    );
  });

  it("rejects a value outside the allowed set", () => {
    const r = constrainEnum("blue", REASONS);
    expect(r.normalized).toBeNull();
    expect(r.valid).toBe(false);
  });

  it("can require an exact (case-sensitive) match", () => {
    const r = constrainEnum("Damaged", REASONS, { caseInsensitive: false });
    expect(r.valid).toBe(false);
  });
});
