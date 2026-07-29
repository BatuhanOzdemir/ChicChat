/**
 * Case lifecycle rules for the agent console (SPEC §9) — pure.
 *
 * The allowed status transitions live here rather than in the UI or the query
 * layer, so "can this case be resolved?" has exactly one answer that a unit
 * test can pin down. Nothing throws: an illegal transition comes back as a
 * result the caller can show to the agent (Handbook §3).
 */

export const CASE_STATUSES = [
  "open",
  "in_progress",
  "needs_info",
  "handed_off",
  "escalated",
  "resolved",
  "closed",
  "abandoned",
] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

/** Statuses that still need someone to act — the default queue view. */
export const UNRESOLVED_STATUSES: readonly CaseStatus[] = [
  "open",
  "in_progress",
  "needs_info",
  "handed_off",
  "escalated",
];

/** Reaching one of these stops the clock (`cases.resolved_at`). */
export const TERMINAL_STATUSES: readonly CaseStatus[] = ["resolved", "closed"];

export const PRIORITIES = ["high", "normal", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];

/**
 * Who may go where. The spine is open → in_progress → resolved → closed
 * (SPEC §9); the rest are the real detours: an agent needs more information,
 * hands off, escalates, or reopens something that was closed too eagerly.
 * An abandoned intake can be picked up, because the captured fields survive
 * (SPEC §11).
 */
const TRANSITIONS: Record<CaseStatus, readonly CaseStatus[]> = {
  open: ["in_progress", "needs_info", "handed_off", "escalated", "resolved"],
  in_progress: ["needs_info", "handed_off", "escalated", "resolved", "open"],
  needs_info: ["in_progress", "escalated", "resolved", "open"],
  handed_off: ["in_progress", "escalated", "resolved"],
  escalated: ["in_progress", "resolved"],
  resolved: ["closed", "in_progress"],
  closed: ["in_progress"],
  abandoned: ["in_progress", "closed"],
};

export function isCaseStatus(value: string): value is CaseStatus {
  return (CASE_STATUSES as readonly string[]).includes(value);
}

export function isPriority(value: string): value is Priority {
  return (PRIORITIES as readonly string[]).includes(value);
}

/** Unknown priorities degrade to `normal` rather than failing a case (SPEC §2). */
export function constrainPriority(value: string | null | undefined): Priority {
  const trimmed = (value ?? "").trim().toLowerCase();
  return isPriority(trimmed) ? trimmed : "normal";
}

/** High first, then normal, then low — the queue's sort key. */
export function priorityRank(priority: Priority): number {
  return PRIORITIES.indexOf(priority);
}

/** The statuses an agent may move this case to right now. */
export function nextStatuses(from: CaseStatus): readonly CaseStatus[] {
  return TRANSITIONS[from] ?? [];
}

export function canTransition(from: CaseStatus, to: CaseStatus): boolean {
  return nextStatuses(from).includes(to);
}

export function isTerminal(status: CaseStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export type TransitionResult =
  | { ok: true; value: { from: CaseStatus; to: CaseStatus; terminal: boolean } }
  | { ok: false; error: string };

/** Validate a requested transition, including the raw (untrusted) target. */
export function planTransition(from: string, to: string): TransitionResult {
  if (!isCaseStatus(from)) {
    return { ok: false, error: `case has an unknown status "${from}"` };
  }
  if (!isCaseStatus(to)) {
    return { ok: false, error: `unknown status "${to}"` };
  }
  if (from === to) {
    return { ok: false, error: `case is already ${to}` };
  }
  if (!canTransition(from, to)) {
    return {
      ok: false,
      error: `cannot move a ${from} case to ${to} (allowed: ${
        nextStatuses(from).join(", ") || "none"
      })`,
    };
  }
  return { ok: true, value: { from, to, terminal: isTerminal(to) } };
}

export const NOTE_MAX_LENGTH = 2000;

export type NoteResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

/** Internal notes are agent-authored text: trimmed, non-empty, bounded. */
export function parseNote(raw: string): NoteResult {
  const body = raw.trim();
  if (body === "") return { ok: false, error: "a note cannot be empty" };
  if (body.length > NOTE_MAX_LENGTH) {
    return {
      ok: false,
      error: `a note cannot exceed ${NOTE_MAX_LENGTH} characters`,
    };
  }
  return { ok: true, value: body };
}

/** How long a case has been waiting, for the queue's age column. */
export function ageLabel(
  createdAt: Date | string,
  now: Date = new Date(),
): string {
  const created =
    typeof createdAt === "string" ? new Date(createdAt) : createdAt;
  if (Number.isNaN(created.getTime())) return "—";

  const minutes = Math.floor((now.getTime() - created.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
