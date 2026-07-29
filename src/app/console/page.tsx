import Link from "next/link";
import { ageLabel, CASE_STATUSES } from "@/lib/cases/workflow";
import { UNROUTED_QUEUE } from "@/lib/cases/filters";
import { getDatabase } from "@/db/client";
import { loadMerchantConfig } from "@/db/config";
import { listQueue, listQueues, type QueueFilters } from "@/db/console";
import { merchantContext } from "@/server/merchant/current";
import { MerchantSwitcher } from "../merchant-switcher";
import {
  maskedPhone,
  Panel,
  PriorityBadge,
  queueName,
  StatusBadge,
} from "../cases/ui";

/**
 * Agent case queue (SPEC §9): what needs working on, most urgent and longest
 * waiting first. Deliberately minimal — no assignment, no notifications, and no
 * replying to customers from here.
 */
export const dynamic = "force-dynamic";

const field =
  "rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900";

function pick(
  params: Record<string, string | string[] | undefined>,
  name: string,
): string {
  const raw = params[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (value ?? "").trim();
}

export default async function ConsolePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const status = pick(params, "status");
  const filters: QueueFilters = {
    queue: pick(params, "queue") || null,
    categoryKey: pick(params, "category") || null,
    // An unknown status simply falls back to "everything outstanding" — this is
    // a work queue, so it should always show work rather than an error page.
    status: CASE_STATUSES.find((s) => s === status) ?? null,
  };

  const db = getDatabase();
  const merchant = await merchantContext(db);
  if (!merchant) {
    return (
      <main className="mx-auto max-w-5xl p-6">
        <h1 className="text-2xl font-semibold">Agent console</h1>
        <p className="mt-4 text-sm text-zinc-500">
          No merchants yet. Run <code>npm run db:seed</code>.
        </p>
      </main>
    );
  }
  const merchantId = merchant.current.id;

  const [rows, queues, config] = await Promise.all([
    listQueue(db, merchantId, filters),
    listQueues(db, merchantId),
    loadMerchantConfig(db, merchantId),
  ]);

  const outstanding = queues.reduce((sum, q) => sum + q.n, 0);
  const now = new Date();

  const queueHref = (queue: string | null): string => {
    const next = new URLSearchParams();
    next.set("queue", queue ?? UNROUTED_QUEUE);
    if (filters.categoryKey) next.set("category", filters.categoryKey);
    if (filters.status) next.set("status", filters.status);
    return `/console?${next.toString()}`;
  };

  return (
    <main className="mx-auto max-w-6xl p-6 text-zinc-900 dark:text-zinc-100">
      <header className="mb-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-2xl font-semibold">Agent console</h1>
          <MerchantSwitcher context={merchant} back="/console" />
        </div>
        <p className="text-sm text-zinc-500">
          {outstanding} case(s) outstanding ·{" "}
          <Link className="underline" href="/cases">
            merchant case views
          </Link>{" "}
          ·{" "}
          <Link className="underline" href="/simulator">
            simulator
          </Link>
        </p>
      </header>

      <div className="space-y-4">
        <Panel
          title="Queues"
          aside={
            <span className="text-xs text-zinc-500">
              from the routing rules (SPEC §3)
            </span>
          }
        >
          {queues.length === 0 ? (
            <p className="text-sm text-zinc-500">
              Nothing outstanding. Generate a case in the{" "}
              <Link className="underline" href="/simulator">
                simulator
              </Link>
              .
            </p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {queues.map((q) => {
                const active =
                  filters.queue !== null &&
                  (q.queue ?? UNROUTED_QUEUE) === filters.queue;
                return (
                  <li key={q.queue ?? UNROUTED_QUEUE}>
                    <Link
                      href={queueHref(q.queue)}
                      className={`flex items-baseline gap-2 rounded border px-3 py-2 text-sm hover:border-zinc-400 ${
                        active
                          ? "border-zinc-900 dark:border-zinc-100"
                          : "border-zinc-200 dark:border-zinc-800"
                      }`}
                    >
                      <span className="font-mono text-xs">
                        {queueName(q.queue)}
                      </span>
                      <strong>{q.n}</strong>
                      {q.high > 0 && (
                        <span className="text-xs text-red-700 dark:text-red-300">
                          {q.high} high
                        </span>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <Panel title="Filters">
          <form className="flex flex-wrap items-end gap-3" method="get">
            <label className="flex flex-col gap-1 text-xs text-zinc-500">
              Queue
              <select
                className={field}
                name="queue"
                defaultValue={filters.queue ?? ""}
              >
                <option value="">all queues</option>
                {queues.map((q) => (
                  <option
                    key={q.queue ?? UNROUTED_QUEUE}
                    value={q.queue ?? UNROUTED_QUEUE}
                  >
                    {queueName(q.queue)}
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
              Status
              <select
                className={field}
                name="status"
                defaultValue={filters.status ?? ""}
              >
                <option value="">outstanding</option>
                {CASE_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              className="rounded bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900"
            >
              Apply
            </button>
            <Link className="pb-1.5 text-xs underline" href="/console">
              Clear
            </Link>
          </form>
        </Panel>

        <Panel
          title="Work queue"
          aside={
            <span className="text-xs text-zinc-500">
              highest priority, longest waiting first
            </span>
          }
        >
          {rows.length === 0 ? (
            <p className="text-sm text-zinc-500">Nothing matches.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase text-zinc-500">
                    <th className="py-1 pe-3">Waiting</th>
                    <th className="py-1 pe-3">Priority</th>
                    <th className="py-1 pe-3">Queue</th>
                    <th className="py-1 pe-3">Status</th>
                    <th className="py-1 pe-3">Category</th>
                    <th className="py-1 pe-3">Order</th>
                    <th className="py-1 pe-3">Customer</th>
                    <th className="py-1 pe-3">Notes</th>
                    <th className="py-1"></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr
                      key={row.id}
                      className="border-t border-zinc-100 dark:border-zinc-800"
                    >
                      <td className="py-1.5 pe-3 whitespace-nowrap text-xs">
                        {ageLabel(row.created_at, now)}
                      </td>
                      <td className="py-1.5 pe-3">
                        <PriorityBadge priority={row.priority} />
                      </td>
                      <td className="py-1.5 pe-3 font-mono text-xs">
                        {queueName(row.queue)}
                      </td>
                      <td className="py-1.5 pe-3">
                        <StatusBadge status={row.status} />
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
                      <td className="py-1.5 pe-3 text-xs text-zinc-500">
                        {row.note_count > 0 ? row.note_count : "—"}
                      </td>
                      <td className="py-1.5">
                        <Link
                          className="text-xs underline"
                          href={`/console/${row.id}`}
                        >
                          work on it
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </main>
  );
}
