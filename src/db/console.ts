/**
 * Agent case console (SPEC §9): the work queue, the audit trail of a case, and
 * the two things an agent can do to it — move its status and leave an internal
 * note.
 *
 * Reads are merchant-scoped. Writes validate the requested transition against
 * the pure lifecycle rules (`lib/cases/workflow`) inside the same transaction
 * that applies it, so two agents clicking at once cannot produce an impossible
 * history.
 */
import {
  isTerminal,
  planTransition,
  PRIORITIES,
  priorityRank,
  UNRESOLVED_STATUSES,
  type CaseStatus,
  type Priority,
} from "@/lib/cases/workflow";
import { UNROUTED_QUEUE } from "@/lib/cases/filters";
import type { Database, Queryable } from "./database";

export const QUEUE_PAGE_SIZE = 50;

export interface QueueFilters {
  /** Queue name, `UNROUTED_QUEUE` for unrouted, or null for all queues. */
  queue: string | null;
  categoryKey: string | null;
  /** A single status, or null for "everything still needing work". */
  status: CaseStatus | null;
}

export interface QueueRow {
  id: string;
  status: string;
  priority: string;
  queue: string | null;
  category_key: string;
  category_label: string;
  subcategory_key: string | null;
  customer_wa_id: string;
  order_number: string | null;
  created_at: string;
  note_count: number;
}

function queueConditions(filters: QueueFilters): {
  sql: string;
  params: unknown[];
} {
  const params: unknown[] = [];
  const parts: string[] = ["c.merchant_id = $1"];

  const add = (value: unknown): string => {
    params.push(value);
    return `$${params.length + 1}`;
  };

  if (filters.queue === UNROUTED_QUEUE) parts.push("c.queue is null");
  else if (filters.queue) parts.push(`c.queue = ${add(filters.queue)}`);

  if (filters.categoryKey) parts.push(`cat.key = ${add(filters.categoryKey)}`);

  if (filters.status) parts.push(`c.status = ${add(filters.status)}`);
  else parts.push(`c.status = any(${add([...UNRESOLVED_STATUSES])})`);

  return { sql: parts.join(" and "), params };
}

/**
 * The queue: highest priority first, then oldest first — a high-priority case
 * that has been waiting an hour outranks a normal one from a minute ago.
 *
 * Generated from the same `PRIORITIES` list the pure `priorityRank` uses, so
 * the SQL ordering cannot drift from the TypeScript one. The interpolated
 * values are compile-time constants, never input.
 */
const PRIORITY_ORDER = `case c.priority ${PRIORITIES.map(
  (p) => `when '${p}' then ${priorityRank(p)}`,
).join(" ")} else ${PRIORITIES.length} end`;

export async function listQueue(
  db: Queryable,
  merchantId: string,
  filters: QueueFilters,
): Promise<QueueRow[]> {
  const { sql, params } = queueConditions(filters);

  const { rows } = await db.query(
    `select c.id, c.status, c.priority, c.queue,
            cat.key as category_key, cat.label as category_label,
            sub.key as subcategory_key, c.customer_wa_id, c.created_at,
            (select f.normalized_value from case_fields f
              where f.case_id = c.id and f.field_key = 'order_number') as order_number,
            (select count(*)::int from case_events e
              where e.case_id = c.id and e.kind = 'note') as note_count
       from cases c
       join categories cat on cat.id = c.category_id
       left join subcategories sub on sub.id = c.subcategory_id
      where ${sql}
      order by ${PRIORITY_ORDER}, c.created_at asc
      limit ${QUEUE_PAGE_SIZE}`,
    [merchantId, ...params],
  );

  return rows as QueueRow[];
}

export interface QueueSummary {
  queue: string | null;
  n: number;
  high: number;
}

/** Queues with work outstanding, busiest first — the console's landing strip. */
export async function listQueues(
  db: Queryable,
  merchantId: string,
): Promise<QueueSummary[]> {
  const { rows } = await db.query(
    `select c.queue, count(*)::int as n,
            count(*) filter (where c.priority = 'high')::int as high
       from cases c
      where c.merchant_id = $1 and c.status = any($2)
      group by c.queue
      order by n desc, c.queue nulls last`,
    [merchantId, [...UNRESOLVED_STATUSES]],
  );
  return rows as QueueSummary[];
}

export interface CaseEvent {
  id: string;
  kind: "status_change" | "note" | "routing";
  from_status: string | null;
  to_status: string | null;
  body: string | null;
  actor: string;
  created_at: string;
}

export async function listCaseEvents(
  db: Queryable,
  merchantId: string,
  caseId: string,
): Promise<CaseEvent[]> {
  const { rows } = await db.query(
    `select e.id, e.kind, e.from_status, e.to_status, e.body, e.actor, e.created_at
       from case_events e
       join cases c on c.id = e.case_id
      where e.case_id = $2 and c.merchant_id = $1
      order by e.created_at, e.id`,
    [merchantId, caseId],
  );
  return rows as CaseEvent[];
}

export type ConsoleWriteResult =
  | { ok: true; value: { from: CaseStatus; to: CaseStatus } }
  | { ok: false; error: string };

export type NoteWriteResult = { ok: true } | { ok: false; error: string };

/**
 * Move a case to a new status, optionally with a note explaining why.
 *
 * The row is locked for the duration, so the transition is validated against
 * the status that is actually current rather than the one the page rendered.
 */
export async function transitionCase(
  db: Database,
  merchantId: string,
  caseId: string,
  to: string,
  note?: string | null,
): Promise<ConsoleWriteResult> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.query(
      `select status from cases where id = $2 and merchant_id = $1 for update`,
      [merchantId, caseId],
    );
    const current = rows[0] as { status: string } | undefined;
    if (!current) return { ok: false, error: "case not found" };

    const plan = planTransition(current.status, to);
    if (!plan.ok) return plan;

    await tx.query(
      `update cases
          set status = $3,
              resolved_at = case when $4 then now() else null end
        where id = $2 and merchant_id = $1`,
      [merchantId, caseId, plan.value.to, isTerminal(plan.value.to)],
    );

    await tx.query(
      `insert into case_events (case_id, kind, from_status, to_status, body)
       values ($1, 'status_change', $2, $3, $4)`,
      [caseId, plan.value.from, plan.value.to, note?.trim() || null],
    );

    return { ok: true, value: { from: plan.value.from, to: plan.value.to } };
  });
}

/** Add an internal note. Never visible to the customer (SPEC §9). */
export async function addCaseNote(
  db: Queryable,
  merchantId: string,
  caseId: string,
  body: string,
): Promise<NoteWriteResult> {
  const { rows } = await db.query(
    `insert into case_events (case_id, kind, body)
     select c.id, 'note', $3 from cases c
      where c.id = $2 and c.merchant_id = $1
     returning id`,
    [merchantId, caseId, body],
  );
  return rows.length === 0
    ? { ok: false, error: "case not found" }
    : { ok: true };
}

export interface CaseWorkflowRow {
  status: CaseStatus;
  priority: Priority;
  queue: string | null;
  resolved_at: string | null;
}

/** The workflow header the detail page needs to render its action buttons. */
export async function getCaseWorkflow(
  db: Queryable,
  merchantId: string,
  caseId: string,
): Promise<CaseWorkflowRow | null> {
  const { rows } = await db.query(
    `select status, priority, queue, resolved_at from cases
      where id = $2 and merchant_id = $1`,
    [merchantId, caseId],
  );
  return (rows[0] as CaseWorkflowRow | undefined) ?? null;
}
