import Link from "next/link";
import { notFound } from "next/navigation";
import { formatDuration } from "@/lib/cases/analytics";
import { getDatabase } from "@/db/client";
import { getCaseDetail } from "@/db/case-queries";
import { currentMerchantId } from "@/server/merchant/current";
import {
  formatWhen,
  maskedPhone,
  Panel,
  PriorityBadge,
  queueName,
  StatusBadge,
} from "../ui";

export const dynamic = "force-dynamic";

export default async function CaseDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const db = getDatabase();
  // Scoped to the selected merchant, so another tenant's case is a 404 here.
  const merchantId = await currentMerchantId(db);
  const detail = merchantId ? await getCaseDetail(db, merchantId, id) : null;
  if (!detail) notFound();

  const photos = detail.fields.filter(
    (f) => f.type === "media" && f.normalized_value,
  );
  const intakeSeconds =
    detail.intake_started_at === null
      ? null
      : (new Date(detail.created_at).getTime() -
          new Date(detail.intake_started_at).getTime()) /
        1000;

  // Timeline from the timestamps we actually have. Status transitions and the
  // conversation transcript arrive with the agent console (SPEC §9).
  const timeline = [
    ...(detail.intake_started_at
      ? [{ at: detail.intake_started_at, what: "Intake started" }]
      : []),
    ...detail.fields.map((f) => ({
      at: f.created_at,
      what: `Captured ${f.field_key}`,
    })),
    { at: detail.created_at, what: `Case created (${detail.status})` },
  ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  return (
    <main className="mx-auto max-w-4xl p-6 text-zinc-900 dark:text-zinc-100">
      <header className="mb-4">
        <Link className="text-xs underline" href="/cases">
          ← all cases
        </Link>
        <h1 className="mt-1 flex flex-wrap items-center gap-2 text-2xl font-semibold">
          {detail.category_label}
          <StatusBadge status={detail.status} />
          <PriorityBadge priority={detail.priority} />
          <span className="font-mono text-xs font-normal text-zinc-500">
            {queueName(detail.queue)}
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
          · customer {maskedPhone(detail.customer_wa_id)} · tier{" "}
          {detail.integration_tier} · {formatWhen(detail.created_at)} · intake
          took {formatDuration(intakeSeconds)} ·{" "}
          <Link className="underline" href={`/console/${detail.id}`}>
            work on it in the agent console
          </Link>
        </p>
      </header>

      <div className="space-y-4">
        <Panel title="Captured fields">
          {detail.fields.length === 0 ? (
            <p className="text-sm text-zinc-500">Nothing captured.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase text-zinc-500">
                    <th className="py-1 pe-3">Field</th>
                    <th className="py-1 pe-3">Normalized</th>
                    <th className="py-1 pe-3">Raw (as sent)</th>
                    <th className="py-1">Type</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.fields.map((f) => (
                    <tr
                      key={f.field_key}
                      className="border-t border-zinc-100 dark:border-zinc-800"
                    >
                      <td className="py-1.5 pe-3 font-mono text-xs">
                        {f.field_key}
                      </td>
                      <td className="py-1.5 pe-3">
                        {f.normalized_value ?? "—"}
                      </td>
                      <td className="py-1.5 pe-3 text-zinc-500">
                        {f.raw_value ?? "—"}
                      </td>
                      <td className="py-1.5 text-xs text-zinc-500">
                        {f.type ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel title={`Selected items (${detail.items.length})`}>
          {detail.items.length === 0 ? (
            <p className="text-sm text-zinc-500">
              None — Tier 0 captures the item as text (SPEC §6.4).
            </p>
          ) : (
            <ul className="space-y-1 text-sm">
              {detail.items.map((item) => (
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
        </Panel>

        <Panel title={`Photos (${photos.length})`}>
          {photos.length === 0 ? (
            <p className="text-sm text-zinc-500">No photo attached.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {photos.map((p) => (
                <li key={p.field_key} className="flex items-center gap-2">
                  <span>🖼️</span>
                  <code className="text-xs">{p.normalized_value}</code>
                  <span className="text-xs text-zinc-500">
                    WhatsApp media id — private-bucket download lands with KVKK
                    storage
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Timeline">
          <ol className="space-y-1 text-sm">
            {timeline.map((entry, index) => (
              <li key={`${entry.at}-${index}`} className="flex gap-3">
                <span className="w-40 shrink-0 text-xs text-zinc-500">
                  {formatWhen(entry.at)}
                </span>
                <span>{entry.what}</span>
              </li>
            ))}
          </ol>
        </Panel>
      </div>
    </main>
  );
}
