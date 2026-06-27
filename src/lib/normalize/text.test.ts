import { describe, expect, it } from "vitest";
import { normalizeText } from "./text";

describe("normalizeText", () => {
  it("trims and collapses internal whitespace", () => {
    expect(normalizeText("  it   arrived\tbroken \n")).toBe(
      "it arrived broken",
    );
  });

  it("leaves clean text unchanged", () => {
    expect(normalizeText("size 32 too tight")).toBe("size 32 too tight");
  });
});
