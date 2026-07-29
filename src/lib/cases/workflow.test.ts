import { describe, expect, it } from "vitest";
import {
  ageLabel,
  canTransition,
  constrainPriority,
  isTerminal,
  nextStatuses,
  NOTE_MAX_LENGTH,
  parseNote,
  planTransition,
  PRIORITIES,
  priorityRank,
} from "./workflow";

describe("status transitions (SPEC §9)", () => {
  it("walks the main path open → in_progress → resolved → closed", () => {
    expect(canTransition("open", "in_progress")).toBe(true);
    expect(canTransition("in_progress", "resolved")).toBe(true);
    expect(canTransition("resolved", "closed")).toBe(true);
  });

  it("refuses to skip from open straight to closed", () => {
    const result = planTransition("open", "closed");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("cannot move");
  });

  it("names the allowed moves when it refuses one", () => {
    const result = planTransition("escalated", "needs_info");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("in_progress");
      expect(result.error).toContain("resolved");
    }
  });

  it("rejects a transition to the status it is already in", () => {
    const result = planTransition("resolved", "resolved");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("case is already resolved");
  });

  it("rejects statuses outside the vocabulary, from either side", () => {
    expect(planTransition("open", "done").ok).toBe(false);
    expect(planTransition("archived", "open").ok).toBe(false);
  });

  it("lets an agent reopen a closed case and pick up an abandoned intake", () => {
    expect(canTransition("closed", "in_progress")).toBe(true);
    expect(canTransition("abandoned", "in_progress")).toBe(true);
  });

  it("reports which transitions stop the clock", () => {
    const resolved = planTransition("in_progress", "resolved");
    expect(resolved.ok && resolved.value.terminal).toBe(true);
    const started = planTransition("open", "in_progress");
    expect(started.ok && started.value.terminal).toBe(false);
    expect(isTerminal("closed")).toBe(true);
    expect(isTerminal("needs_info")).toBe(false);
  });

  it("offers no moves out of nowhere — every status has a way forward", () => {
    for (const status of [
      "open",
      "in_progress",
      "needs_info",
      "handed_off",
      "escalated",
      "resolved",
      "closed",
      "abandoned",
    ] as const) {
      expect(nextStatuses(status).length).toBeGreaterThan(0);
    }
  });
});

describe("priority", () => {
  it("sorts high before normal before low", () => {
    expect(PRIORITIES.map(priorityRank)).toEqual([0, 1, 2]);
  });

  it("degrades an unknown priority to normal rather than failing", () => {
    expect(constrainPriority("urgent")).toBe("normal");
    expect(constrainPriority(null)).toBe("normal");
    expect(constrainPriority("  HIGH ")).toBe("high");
  });
});

describe("internal notes", () => {
  it("trims and accepts real text", () => {
    const result = parseNote("  called the carrier  ");
    expect(result).toEqual({ ok: true, value: "called the carrier" });
  });

  it("rejects an empty note", () => {
    expect(parseNote("   ").ok).toBe(false);
  });

  it("rejects a note past the length cap", () => {
    const result = parseNote("x".repeat(NOTE_MAX_LENGTH + 1));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("exceed");
  });
});

describe("queue age", () => {
  const now = new Date("2026-07-29T12:00:00Z");

  it("reads in the largest sensible unit", () => {
    expect(ageLabel("2026-07-29T11:59:30Z", now)).toBe("just now");
    expect(ageLabel("2026-07-29T11:20:00Z", now)).toBe("40m");
    expect(ageLabel("2026-07-29T02:00:00Z", now)).toBe("10h");
    expect(ageLabel("2026-07-25T12:00:00Z", now)).toBe("4d");
  });

  it("does not crash on a broken timestamp", () => {
    expect(ageLabel("not a date", now)).toBe("—");
  });
});
