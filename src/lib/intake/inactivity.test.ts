import { describe, expect, it } from "vitest";
import { inactivityAction } from "./inactivity";

const thresholds = { nudgeAfterMinutes: 5, abandonAfterHours: 24 };
const now = new Date("2026-07-28T12:00:00Z");

function minutesAgo(minutes: number): Date {
  return new Date(now.getTime() - minutes * 60_000);
}

describe("inactivityAction", () => {
  it("leaves a freshly active session alone", () => {
    const timing = { status: "active" as const, updatedAt: minutesAgo(2) };
    expect(inactivityAction(timing, thresholds, now)).toBe("none");
  });

  it("nudges once the nudge threshold is reached", () => {
    const timing = { status: "active" as const, updatedAt: minutesAgo(5) };
    expect(inactivityAction(timing, thresholds, now)).toBe("nudge");
  });

  it("does not nudge a session that was already nudged", () => {
    const timing = { status: "nudged" as const, updatedAt: minutesAgo(30) };
    expect(inactivityAction(timing, thresholds, now)).toBe("none");
  });

  it("abandons once the abandon horizon is reached, even if already nudged", () => {
    expect(
      inactivityAction(
        { status: "nudged", updatedAt: minutesAgo(24 * 60) },
        thresholds,
        now,
      ),
    ).toBe("abandon");
    expect(
      inactivityAction(
        { status: "active", updatedAt: minutesAgo(48 * 60) },
        thresholds,
        now,
      ),
    ).toBe("abandon");
  });

  it("abandons rather than nudging a long-quiet session", () => {
    const timing = {
      status: "active" as const,
      updatedAt: minutesAgo(25 * 60),
    };
    expect(inactivityAction(timing, thresholds, now)).toBe("abandon");
  });

  it("never nudges an errored session, but still abandons it", () => {
    expect(
      inactivityAction(
        { status: "errored", updatedAt: minutesAgo(10) },
        thresholds,
        now,
      ),
    ).toBe("none");
    expect(
      inactivityAction(
        { status: "errored", updatedAt: minutesAgo(30 * 60) },
        thresholds,
        now,
      ),
    ).toBe("abandon");
  });

  it("honours merchant-configured thresholds", () => {
    const custom = { nudgeAfterMinutes: 60, abandonAfterHours: 72 };
    const timing = { status: "active" as const, updatedAt: minutesAgo(30) };
    expect(inactivityAction(timing, custom, now)).toBe("none");
    expect(
      inactivityAction(
        { status: "active", updatedAt: minutesAgo(61) },
        custom,
        now,
      ),
    ).toBe("nudge");
  });
});
