/**
 * Case-list filter parsing (SPEC §8) — pure, so the query layer receives values
 * it can trust and the rules are unit-testable.
 *
 * Filters come from a URL query string, i.e. entirely user-controlled input
 * (Handbook §5). Anything unrecognised is rejected rather than silently ignored,
 * so a typo shows up as a message instead of a surprising result set.
 */
import { normalizeOrderNumber } from "../normalize";
import { CASE_STATUSES, isCaseStatus, type CaseStatus } from "./workflow";

// The lifecycle vocabulary lives in ./workflow; re-exported here because the
// views import their filter types from one place.
export { CASE_STATUSES };
export type { CaseStatus };

/** `?queue=unrouted` selects the cases no rule routed (SPEC §9). */
export const UNROUTED_QUEUE = "unrouted";

export interface CaseFilters {
  status: CaseStatus | null;
  categoryKey: string | null;
  /** Queue name, or `UNROUTED_QUEUE` for "no queue". */
  queue: string | null;
  /** Inclusive date bounds (YYYY-MM-DD), interpreted by the query as UTC days. */
  from: string | null;
  to: string | null;
  /** Normalized, so searching "#tr-100 432" finds the stored TR100432. */
  orderNumber: string | null;
  page: number;
}

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function pick(
  params: Record<string, string | string[] | undefined>,
  name: string,
): string {
  const raw = params[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (value ?? "").trim();
}

export function parseCaseFilters(
  params: Record<string, string | string[] | undefined>,
): ParseResult<CaseFilters> {
  const status = pick(params, "status");
  if (status !== "" && !isCaseStatus(status)) {
    return { ok: false, error: `unknown status "${status}"` };
  }

  for (const name of ["from", "to"]) {
    const value = pick(params, name);
    if (value !== "" && !DATE.test(value)) {
      return { ok: false, error: `${name} must be a date (YYYY-MM-DD)` };
    }
  }
  const from = pick(params, "from");
  const to = pick(params, "to");
  if (from !== "" && to !== "" && from > to) {
    return { ok: false, error: "from must not be after to" };
  }

  const rawOrder = pick(params, "order_number");
  // Search by the normalized form, since that is what was stored.
  const orderNumber =
    rawOrder === "" ? null : normalizeOrderNumber(rawOrder).normalized;

  const rawPage = pick(params, "page");
  const page = rawPage === "" ? 1 : Number(rawPage);
  if (!Number.isInteger(page) || page < 1) {
    return { ok: false, error: "page must be a positive whole number" };
  }

  const categoryKey = pick(params, "category");
  const queue = pick(params, "queue");

  return {
    ok: true,
    value: {
      status: status === "" ? null : (status as CaseStatus),
      categoryKey: categoryKey === "" ? null : categoryKey,
      queue: queue === "" ? null : queue,
      from: from === "" ? null : from,
      to: to === "" ? null : to,
      orderNumber: orderNumber === "" ? null : orderNumber,
      page,
    },
  };
}
