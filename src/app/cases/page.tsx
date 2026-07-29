import Link from "next/link";
import { parseCaseFilters, CASE_STATUSES } from "@/lib/cases/filters";
import {
  abandonmentRate,
  formatDuration,
  formatPercent,
} from "@/lib/cases/analytics";
import { getDatabase } from "@/db/client";
import { DEMO_MERCHANT_ID, loadMerchantConfig } from "@/db/config";
import {
  caseCounters,
  listCases,
  listErroredSessions,
  PAGE_SIZE,
} from "@/db/case-queries";
import {
  formatWhen,
  maskedPhone,
  Panel,
  PriorityBadge,
  queueName,
  Stat,
  StatusBadge,
} from "./ui";

export const dynamic = "force-dynamic";

const field =
  "rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900";

export default async function CasesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const parsed = parseCaseFilters(params);
  const db = getDatabase();
  const config = await loadMerchantConfig(db, DEMO_MERCHANT_ID);

  if (!parsed.ok) {
    return (
      <main className="mx-auto max-w-5xl p-6">
        <h1 className="text-2xl font-semibold">Cases</h1>
        <p className="mt-4 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
          {parsed.error}
        </p>
        <Link className="mt-4 inline-block text-sm underline" href="/cases">
          Clear filters
        </Link>
      </main>
    );
  }

  const filters = parsed.value;
  const [page, counters, errored] = await Promise.all([
    listCases(db, DEMO_MERCHANT_ID, filters),
    caseCounters(db, DEMO_MERCHANT_ID),
    listErroredSessions(db, DEMO_MERCHANT_ID),
  ]);

  const pages = Math.max(1, Math.ceil(page.total / PAGE_SIZE));

  return (
    <main className="mx-auto max-w-6xl p-6 text-zinc-900 dark:text-zinc-100">
      <header className="mb-4">
        <h1 className="text-2xl font-semibold">Cases</h1>
        <p className="text-sm text-zinc-500">
          {page.total} case(s) matching · last 30 days of counters ·{" "}
          <Link className="underline" href="/console">
            agent console
          </Link>{" "}
          ·{" "}
          <Link className="underline" href="/config">
            configuration
          </Link>{" "}
          ·{" "}
          <Link className="underline" href="/simulator">
            simulator
          </Link>
        </p>
      </header>

      <div className="space-y-4">
        <Panel title="Last 30 days">
          <div className="flex flex-wrap gap-3">
            <Stat
              label="Cases"
              value={String(counters.completed + counters.abandoned)}
            />
            <Stat
              label="Median intake"
              value={formatDuration(counters.medianIntakeSeconds)}
            />
            <Stat
              label="Abandonment"
              value={formatPercent(
                abandonmentRate(counters.completed, counters.abandoned),
              )}
            />
            {counters.byStatus.map((s) => (
              <Stat key={s.status} label={s.status} value={String(s.n)} />
            ))}
          </div>
          {counters.byCategory.length > 0 && (
            <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500">
              {counters.byCategory.map((c) => (
                <li key={c.category_key}>
                  {c.category_label}: <strong>{c.n}</strong>
                </li>
              ))}
            </ul>
          )}
          {counters.byDay.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-x-3 text-xs text-zinc-500">
              {counters.byDay.slice(0, 10).map((d) => (
                <li key={d.day}>
                  {d.day}: <strong>{d.n}</strong>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Filters">
          <form className="flex flex-wrap items-end gap-3" method="get">
            <label className="flex flex-col gap-1 text-xs text-zinc-500">
              Status
              <select
                className={field}
                name="status"
                defaultValue={filters.status ?? ""}
              >
                <option value="">any</option>
                {CASE_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-zinc-500">
              Category
              <select
                className={field}
                name="category"
                defaultValue={filters.categoryKey ?? ""}
              >
                <option value="">any</option>
                {(config?.categories ?? []).map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-zinc-500">
              From
              <input
                className={field}
                type="date"
                name="from"
                defaultValue={filters.from ?? ""}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-zinc-500">
              To
              <input
                className={field}
                type="date"
                name="to"
                defaultValue={filters.to ?? ""}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-zinc-500">
              Queue
              <input
                className={field}
                name="queue"
                defaultValue={filters.queue ?? ""}
                placeholder="returns_queue"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-zinc-500">
              Order number
              <input
                className={field}
                name="order_number"
                defaultValue={filters.orderNumber ?? ""}
                placeholder="#tr-100 432"
              />
            </label>
            <button
              type="submit"
              className="rounded bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900"
            >
              Apply
            </button>
            <Link className="pb-1.5 text-xs underline" href="/cases">
              Clear
            </Link>
          </form>
        </Panel>

        {errored.length > 0 && (
          <Panel
            title="Errored sessions"
            aside={
              <span className="text-xs text-zinc-500">
                needs attention (SPEC §13)
              </span>
            }
          >
            <ul className="space-y-1 text-sm">
              {errored.map((session) => (
                <li key={session.customer_wa_id} className="flex gap-3">
                  <span className="font-mono text-xs">
                    {maskedPhone(session.customer_wa_id)}
                  </span>
                  <span className="text-zinc-500">
                    {session.category_key ?? "no category yet"}
                  </span>
                  <span className="truncate text-xs text-red-700 dark:text-red-300">
                    {session.last_error ?? "unknown error"}
                  </span>
                  <span className="ms-auto text-xs text-zinc-500">
                    {formatWhen(session.updated_at)}
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
        )}

        <Panel title="Case list">
          {page.rows.length === 0 ? (
            <p className="text-sm text-zinc-500">
              No cases match. Generate some in the{" "}
              <Link className="underline" href="/simulator">
                simulator
              </Link>
              .
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase text-zinc-500">
                    <th className="py-1 pe-3">When</th>
                    <th className="py-1 pe-3">Status</th>
                    <th className="py-1 pe-3">Queue</th>
                    <th className="py-1 pe-3">Category</th>
                    <th className="py-1 pe-3">Order</th>
                    <th className="py-1 pe-3">Customer</th>
                    <th className="py-1 pe-3">Fields</th>
                    <th className="py-1"></th>
                  </tr>
                </thead>
                <tbody>
                  {page.rows.map((row) => (
                    <tr
                      key={row.id}
                      className="border-t border-zinc-100 dark:border-zinc-800"
                    >
                      <td className="py-1.5 pe-3 whitespace-nowrap text-xs">
                        {formatWhen(row.created_at)}
                      </td>
                      <td className="py-1.5 pe-3">
                        <StatusBadge status={row.status} />
                      </td>
                      <td className="py-1.5 pe-3 whitespace-nowrap">
                        <span className="font-mono text-xs">
                          {queueName(row.queue)}
                        </span>{" "}
                        <PriorityBadge priority={row.priority} />
                      </td>
                      <td className="py-1.5 pe-3">
                        {row.category_label}
                        {row.subcategory_key && (
                          <span className="text-xs text-zinc-500">
                            {" "}
                            / {row.subcategory_key}
                          </span>
                        )}
                      </td>
                      <td className="py-1.5 pe-3 font-mono text-xs">
                        {row.order_number ?? "—"}
                      </td>
                      <td className="py-1.5 pe-3 font-mono text-xs">
                        {maskedPhone(row.customer_wa_id)}
                      </td>
                      <td className="py-1.5 pe-3 text-xs">{row.field_count}</td>
                      <td className="py-1.5">
                        <Link
                          className="text-xs underline"
                          href={`/cases/${row.id}`}
                        >
                          open
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {pages > 1 && (
            <p className="mt-3 text-xs text-zinc-500">
              Page {page.page} of {pages}
            </p>
          )}
        </Panel>
      </div>
    </main>
  );
}
