import Link from "next/link";
import { notFound } from "next/navigation";
import { formatDuration } from "@/lib/cases/analytics";
import { nextStatuses } from "@/lib/cases/workflow";
import { buildHandoff } from "@/db/cases";
import { getDatabase } from "@/db/client";
import { getCaseDetail } from "@/db/case-queries";
import { DEMO_MERCHANT_ID } from "@/db/config";
import { getCaseWorkflow, listCaseEvents } from "@/db/console";
import { listTranscript } from "@/db/transcript";
import {
  formatWhen,
  maskedPhone,
  Panel,
  PriorityBadge,
  queueName,
  StatusBadge,
} from "../../cases/ui";
import { addNote, changeStatus } from "../actions";

/**
 * One case, as an agent works it (SPEC §9): the handoff package, the
 * conversation it came from (read-only), what has happened to it, and the two
 * actions available — move status, add an internal note.
 */
export const dynamic = "force-dynamic";

const EVENT_ICON: Record<string, string> = {
  routing: "→",
  status_change: "⇄",
  note: "✎",
};

export default async function ConsoleCasePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const { error } = await searchParams;
  const db = getDatabase();

  // Establishes merchant scope for everything below; `buildHandoff` and the
  // event/transcript reads are keyed on the case id from here on.
  const detail = await getCaseDetail(db, DEMO_MERCHANT_ID, id);
  if (!detail) notFound();

  const [workflow, handoff, events, transcript] = await Promise.all([
    getCaseWorkflow(db, DEMO_MERCHANT_ID, id),
    buildHandoff(db, id),
    listCaseEvents(db, DEMO_MERCHANT_ID, id),
    listTranscript(db, DEMO_MERCHANT_ID, id),
  ]);
  if (!workflow) notFound();

  const intakeSeconds =
    detail.intake_started_at === null
      ? null
      : (new Date(detail.created_at).getTime() -
          new Date(detail.intake_started_at).getTime()) /
        1000;

  const moves = nextStatuses(workflow.status);

  return (
    <main className="mx-auto max-w-5xl p-6 text-zinc-900 dark:text-zinc-100">
      <header className="mb-4">
        <Link className="text-xs underline" href="/console">
          ← work queue
        </Link>
        <h1 className="mt-1 flex flex-wrap items-center gap-2 text-2xl font-semibold">
          {detail.category_label}
          <StatusBadge status={workflow.status} />
          <PriorityBadge priority={workflow.priority} />
          <span className="font-mono text-xs font-normal text-zinc-500">
            {queueName(workflow.queue)}
          </span>
        </h1>
        <p className="text-sm text-zinc-500">
          <code>{detail.category_key}</code>
          {detail.subcategory_key && (
            <>
              {" / "}
              <code>{detail.subcategory_key}</code>
            </>
          )}{" "}
          · customer {maskedPhone(detail.customer_wa_id)} · opened{" "}
          {formatWhen(detail.created_at)} · intake took{" "}
          {formatDuration(intakeSeconds)}
          {workflow.resolved_at &&
            ` · closed ${formatWhen(workflow.resolved_at)}`}
          {" · "}
          <Link className="underline" href={`/cases/${id}`}>
            merchant view
          </Link>
        </p>
      </header>

      {typeof error === "string" && error !== "" && (
        <p className="mb-4 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
          {error}
        </p>
      )}

      <div className="space-y-4">
        <Panel
          title="Actions"
          aside={
            <span className="text-xs text-zinc-500">
              internal only — nothing is sent to the customer
            </span>
          }
        >
          {moves.length === 0 ? (
            <p className="text-sm text-zinc-500">
              This case is {workflow.status}; there is nowhere left to move it.
            </p>
          ) : (
            <form
              action={changeStatus}
              className="flex flex-wrap items-end gap-2"
            >
              <input type="hidden" name="case_id" value={id} />
              <label className="flex flex-1 flex-col gap-1 text-xs text-zinc-500">
                Note (optional, saved with the change)
                <input
                  className="w-full rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                  name="note"
                  placeholder="refund approved, awaiting carrier pickup"
                />
              </label>
              <div className="flex flex-wrap gap-2">
                {moves.map((to) => (
                  <button
                    key={to}
                    type="submit"
                    name="to"
                    value={to}
                    className="rounded bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900"
                  >
                    {to.replace(/_/g, " ")}
                  </button>
                ))}
              </div>
            </form>
          )}

          <form action={addNote} className="mt-3 flex items-end gap-2">
            <input type="hidden" name="case_id" value={id} />
            <label className="flex flex-1 flex-col gap-1 text-xs text-zinc-500">
              Internal note
              <input
                className="w-full rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                name="note"
                placeholder="called the carrier, reference 44821"
              />
            </label>
            <button
              type="submit"
              className="rounded border border-zinc-300 px-3 py-1.5 text-xs font-medium hover:border-zinc-500 dark:border-zinc-700"
            >
              Add note
            </button>
          </form>
        </Panel>

        <Panel
          title="Handoff package"
          aside={
            <span className="text-xs text-zinc-500">
              normalized values, ready to act on
            </span>
          }
        >
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            {Object.entries(handoff.fields).map(([key, value]) => (
              <div key={key} className="flex gap-2">
                <dt className="font-mono text-xs text-zinc-500">{key}</dt>
                <dd>{value ?? "—"}</dd>
              </div>
            ))}
          </dl>

          {handoff.items.length > 0 && (
            <ul className="mt-3 space-y-1 text-sm">
              {handoff.items.map((item) => (
                <li key={item.line_item_id}>
                  <span className="font-mono text-xs">{item.line_item_id}</span>{" "}
                  {item.title}
                  {item.variant && (
                    <span className="text-zinc-500"> · {item.variant}</span>
                  )}{" "}
                  <span className="text-xs text-zinc-500">×{item.qty}</span>
                </li>
              ))}
            </ul>
          )}

          {handoff.photos.length > 0 && (
            <ul className="mt-3 space-y-1 text-sm">
              {handoff.photos.map((photo) => (
                <li key={photo} className="flex items-center gap-2">
                  <span>🖼️</span>
                  <code className="text-xs">{photo}</code>
                </li>
              ))}
            </ul>
          )}

          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-zinc-500">
              raw JSON (for pasting into another tool)
            </summary>
            <pre className="mt-2 overflow-x-auto rounded bg-zinc-100 p-3 text-xs dark:bg-zinc-900">
              {JSON.stringify(handoff, null, 2)}
            </pre>
          </details>
        </Panel>

        <Panel
          title={`Transcript (${transcript.length})`}
          aside={
            <span className="text-xs text-zinc-500">
              read-only — replying from ChicChat is not in v0.2
            </span>
          }
        >
          {transcript.length === 0 ? (
            <p className="text-sm text-zinc-500">
              No messages recorded for this case.
            </p>
          ) : (
            <ol className="space-y-2 text-sm">
              {transcript.map((entry, index) => (
                <li
                  key={`${entry.created_at}-${index}`}
                  className={
                    entry.direction === "inbound"
                      ? ""
                      : "ps-6 text-zinc-600 dark:text-zinc-400"
                  }
                >
                  <div className="text-xs text-zinc-500">
                    {entry.direction === "inbound"
                      ? maskedPhone(detail.customer_wa_id)
                      : "ChicChat"}{" "}
                    · {entry.kind} · {formatWhen(entry.created_at)}
                  </div>
                  <div className="whitespace-pre-wrap">{entry.body ?? "—"}</div>
                </li>
              ))}
            </ol>
          )}
        </Panel>

        <Panel title="History">
          <ol className="space-y-1 text-sm">
            {events.length === 0 && (
              <li className="text-sm text-zinc-500">Nothing yet.</li>
            )}
            {events.map((event) => (
              <li key={event.id} className="flex gap-3">
                <span className="w-40 shrink-0 text-xs text-zinc-500">
                  {formatWhen(event.created_at)}
                </span>
                <span className="w-4 shrink-0">
                  {EVENT_ICON[event.kind] ?? "·"}
                </span>
                <span>
                  {event.kind === "status_change" && (
                    <>
                      {event.from_status} → <strong>{event.to_status}</strong>
                      {event.body && ` · ${event.body}`}
                    </>
                  )}
                  {event.kind !== "status_change" && event.body}
                  <span className="ms-2 text-xs text-zinc-500">
                    {event.actor}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        </Panel>
      </div>
    </main>
  );
}
