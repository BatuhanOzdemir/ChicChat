/**
 * Session inactivity decisions (SPEC §11) — pure, so the thresholds are
 * testable without a clock or a database.
 *
 * The product rule this encodes: WhatsApp is asynchronous, so partial progress
 * is NEVER discarded early. A quiet session gets exactly one gentle nudge, and
 * only after the (much longer) abandon horizon is it closed — and even then, a
 * session that captured anything becomes an `abandoned` case rather than
 * vanishing.
 */

export type SessionLifecycle = "active" | "nudged" | "errored";

export interface InactivityThresholds {
  nudgeAfterMinutes: number;
  abandonAfterHours: number;
}

export interface SessionTiming {
  status: SessionLifecycle;
  /** Last customer activity. */
  updatedAt: Date;
}

export type InactivityAction = "none" | "nudge" | "abandon";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function idleMs(timing: SessionTiming, now: Date): number {
  return now.getTime() - timing.updatedAt.getTime();
}

/**
 * What maintenance should do with this session right now. Abandonment is
 * checked first so a long-quiet session is closed rather than nudged again.
 */
export function inactivityAction(
  timing: SessionTiming,
  thresholds: InactivityThresholds,
  now: Date = new Date(),
): InactivityAction {
  const idle = idleMs(timing, now);

  if (idle >= thresholds.abandonAfterHours * HOUR) return "abandon";

  // One nudge per session: only sessions still in `active` qualify. An
  // `errored` session is a merchant-console concern, not a nudge target.
  if (
    timing.status === "active" &&
    idle >= thresholds.nudgeAfterMinutes * MINUTE
  ) {
    return "nudge";
  }

  return "none";
}
