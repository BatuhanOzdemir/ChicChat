/**
 * Read models for the merchant case views (SPEC §8): the filtered list, one
 * case in full, the analytics counters, and the errored sessions the console
 * must surface (SPEC §13).
 *
 * Every query is merchant-scoped. Filters arrive already validated from
 * `lib/cases/filters`, and are always passed as bound parameters.
 */
import type { CaseFilters } from "@/lib/cases/filters";
import { median } from "@/lib/cases/analytics";
import type { Queryable } from "./database";

export const PAGE_SIZE = 25;

export interface CaseListRow {
  id: string;
  status: string;
  category_key: string;
  category_label: string;
  subcategory_key: string | null;
  customer_wa_id: string;
  order_number: string | null;
  created_at: string;
  field_count: number;
}

export interface CaseListPage {
  rows: CaseListRow[];
  total: number;
  page: number;
  pageSize: number;
}

/** Build the shared WHERE clause for list and count, so they never diverge. */
function whereClause(filters: CaseFilters): {
  sql: string;
  params: unknown[];
} {
  const params: unknown[] = [];
  const parts: string[] = ["c.merchant_id = $1"];

  const add = (value: unknown): string => {
    params.push(value);
    return `$${params.length + 1}`;
  };

  if (filters.status) parts.push(`c.status = ${add(filters.status)}`);
  if (filters.categoryKey) parts.push(`cat.key = ${add(filters.categoryKey)}`);
  if (filters.from) parts.push(`c.created_at >= ${add(filters.from)}::date`);
  if (filters.to) {
    parts.push(`c.created_at < (${add(filters.to)}::date + interval '1 day')`);
  }
  if (filters.orderNumber) {
    parts.push(
      `exists (select 1 from case_fields f
                where f.case_id = c.id and f.field_key = 'order_number'
                  and f.normalized_value = ${add(filters.orderNumber)})`,
    );
  }

  return { sql: parts.join(" and "), params };
}

export async function listCases(
  db: Queryable,
  merchantId: string,
  filters: CaseFilters,
): Promise<CaseListPage> {
  const { sql, params } = whereClause(filters);
  const offset = (filters.page - 1) * PAGE_SIZE;

  const { rows } = await db.query(
    `select c.id, c.status, cat.key as category_key, cat.label as category_label,
            sub.key as subcategory_key, c.customer_wa_id, c.created_at,
            (select f.normalized_value from case_fields f
              where f.case_id = c.id and f.field_key = 'order_number') as order_number,
            (select count(*)::int from case_fields f where f.case_id = c.id) as field_count
       from cases c
       join categories cat on cat.id = c.category_id
       left join subcategories sub on sub.id = c.subcategory_id
      where ${sql}
      order by c.created_at desc
      limit ${PAGE_SIZE} offset ${offset}`,
    [merchantId, ...params],
  );

  const { rows: countRows } = await db.query(
    `select count(*)::int as n
       from cases c
       join categories cat on cat.id = c.category_id
      where ${sql}`,
    [merchantId, ...params],
  );

  return {
    rows: rows as CaseListRow[],
    total: (countRows[0] as { n: number }).n,
    page: filters.page,
    pageSize: PAGE_SIZE,
  };
}

export interface CaseDetail {
  id: string;
  status: string;
  integration_tier: number;
  customer_wa_id: string;
  category_key: string;
  category_label: string;
  subcategory_key: string | null;
  created_at: string;
  intake_started_at: string | null;
  fields: {
    field_key: string;
    raw_value: string | null;
    normalized_value: string | null;
    type: string | null;
    created_at: string;
  }[];
  items: {
    line_item_id: string;
    title: string | null;
    variant: string | null;
    qty: number;
  }[];
}

export async function getCaseDetail(
  db: Queryable,
  merchantId: string,
  caseId: string,
): Promise<CaseDetail | null> {
  const { rows } = await db.query(
    `select c.id, c.status, c.integration_tier, c.customer_wa_id,
            cat.key as category_key, cat.label as category_label,
            sub.key as subcategory_key, c.created_at, c.intake_started_at
       from cases c
       join categories cat on cat.id = c.category_id
       left join subcategories sub on sub.id = c.subcategory_id
      where c.id = $2 and c.merchant_id = $1`,
    [merchantId, caseId],
  );
  const header = rows[0] as Omit<CaseDetail, "fields" | "items"> | undefined;
  if (!header) return null;

  const { rows: fields } = await db.query(
    `select cf.field_key, cf.raw_value, cf.normalized_value, fd.type, cf.created_at
       from case_fields cf
       join cases c on c.id = cf.case_id
       left join field_defs fd
         on fd.category_id = c.category_id and fd.key = cf.field_key
      where cf.case_id = $1
      order by coalesce(fd.sort_order, 0), cf.field_key`,
    [caseId],
  );

  const { rows: items } = await db.query(
    `select line_item_id, title, variant, qty from case_items
      where case_id = $1 order by line_item_id`,
    [caseId],
  );

  return {
    ...header,
    fields: fields as CaseDetail["fields"],
    items: items as CaseDetail["items"],
  };
}

export interface CaseCounters {
  byStatus: { status: string; n: number }[];
  byCategory: { category_key: string; category_label: string; n: number }[];
  byDay: { day: string; n: number }[];
  medianIntakeSeconds: number | null;
  completed: number;
  abandoned: number;
}

/** Counters for the last `days` days (SPEC §8: counts, median, abandonment). */
export async function caseCounters(
  db: Queryable,
  merchantId: string,
  days = 30,
): Promise<CaseCounters> {
  const since = `${days} days`;

  const { rows: byStatus } = await db.query(
    `select status, count(*)::int as n from cases
      where merchant_id = $1 and created_at > now() - $2::interval
      group by status order by n desc`,
    [merchantId, since],
  );

  const { rows: byCategory } = await db.query(
    `select cat.key as category_key, cat.label as category_label, count(*)::int as n
       from cases c join categories cat on cat.id = c.category_id
      where c.merchant_id = $1 and c.created_at > now() - $2::interval
      group by cat.key, cat.label order by n desc`,
    [merchantId, since],
  );

  const { rows: byDay } = await db.query(
    `select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') as day,
            count(*)::int as n
       from cases
      where merchant_id = $1 and created_at > now() - $2::interval
      group by day order by day desc`,
    [merchantId, since],
  );

  // Median is computed in TypeScript so its definition lives in one tested place.
  const { rows: durations } = await db.query(
    `select extract(epoch from (created_at - intake_started_at)) as seconds
       from cases
      where merchant_id = $1 and created_at > now() - $2::interval
        and intake_started_at is not null and status <> 'abandoned'`,
    [merchantId, since],
  );
  const seconds = (durations as { seconds: string | number }[])
    .map((r) => Number(r.seconds))
    .filter((n) => Number.isFinite(n) && n >= 0);

  const counts = byStatus as { status: string; n: number }[];
  const abandoned = counts.find((s) => s.status === "abandoned")?.n ?? 0;
  const completed = counts
    .filter((s) => s.status !== "abandoned")
    .reduce((sum, s) => sum + s.n, 0);

  return {
    byStatus: counts,
    byCategory: byCategory as CaseCounters["byCategory"],
    byDay: byDay as CaseCounters["byDay"],
    medianIntakeSeconds: median(seconds),
    completed,
    abandoned,
  };
}

export interface ErroredSessionRow {
  customer_wa_id: string;
  last_error: string | null;
  updated_at: string;
  category_key: string | null;
}

/** Sessions that hit an unexpected error, for the console (SPEC §13). */
export async function listErroredSessions(
  db: Queryable,
  merchantId: string,
): Promise<ErroredSessionRow[]> {
  const { rows } = await db.query(
    `select s.customer_wa_id, s.last_error, s.updated_at,
            s.state->>'categoryKey' as category_key
       from intake_sessions s
      where s.merchant_id = $1 and s.status = 'errored'
      order by s.updated_at desc
      limit 50`,
    [merchantId],
  );
  return rows as ErroredSessionRow[];
}
