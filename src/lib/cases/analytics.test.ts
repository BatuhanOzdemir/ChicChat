import { describe, expect, it } from "vitest";
import {
  abandonmentRate,
  formatDuration,
  formatPercent,
  median,
} from "./analytics";

describe("median", () => {
  it("takes the middle value of an odd sample", () => {
    expect(median([30, 10, 20])).toBe(20);
  });

  it("averages the two middle values of an even sample", () => {
    expect(median([10, 20, 30, 40])).toBe(25);
  });

  it("is null for an empty sample rather than 0", () => {
    expect(median([])).toBeNull();
  });

  it("does not mutate the input", () => {
    const input = [3, 1, 2];
    median(input);
    expect(input).toEqual([3, 1, 2]);
  });
});

describe("abandonmentRate", () => {
  it("is the abandoned share of all finished-or-abandoned intakes", () => {
    expect(abandonmentRate(3, 1)).toBe(0.25);
    expect(abandonmentRate(0, 2)).toBe(1);
  });

  it("is null when there is nothing to measure", () => {
    expect(abandonmentRate(0, 0)).toBeNull();
  });
});

describe("formatting", () => {
  it("renders durations compactly", () => {
    expect(formatDuration(42)).toBe("42s");
    expect(formatDuration(252)).toBe("4m 12s");
    expect(formatDuration(3900)).toBe("1h 5m");
    expect(formatDuration(null)).toBe("—");
  });

  it("renders percentages, and an em dash when unknown", () => {
    expect(formatPercent(0.25)).toBe("25%");
    expect(formatPercent(null)).toBe("—");
  });
});
