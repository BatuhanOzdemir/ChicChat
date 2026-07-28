"use client";

import type { HandoffPackage } from "@/db/cases";
import type { IntakeState } from "@/lib/intake";

interface InspectorPanelProps {
  session: IntakeState | null;
  sessionMeta: { created_at: string; updated_at: string } | null;
  completedCase: HandoffPackage | null;
  error: string | null;
  notice: string | null;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2 border-b border-zinc-100 py-1 last:border-0 dark:border-zinc-800">
      <span className="text-zinc-500">{label}</span>
      <span className="text-right font-mono text-xs">{value}</span>
    </div>
  );
}

export function InspectorPanel({
  session,
  sessionMeta,
  completedCase,
  error,
  notice,
}: InspectorPanelProps) {
  const collected = session ? Object.entries(session.fields) : [];

  return (
    <section className="space-y-4 rounded-xl border border-zinc-200 p-4 text-sm dark:border-zinc-800">
      <h2 className="font-medium">Live internals</h2>

      {error && (
        <p className="rounded bg-red-100 p-2 text-xs text-red-800 dark:bg-red-950 dark:text-red-200">
          <strong>error:</strong> {error}
        </p>
      )}
      {notice && (
        <p className="rounded bg-amber-100 p-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100">
          {notice}
        </p>
      )}

      <div>
        <h3 className="mb-1 text-xs font-semibold uppercase text-zinc-500">
          Session
        </h3>
        {session ? (
          <div>
            <Row label="status" value={session.status} />
            <Row label="category" value={session.categoryKey ?? "—"} />
            <Row label="subcategory" value={session.subcategoryKey ?? "—"} />
            <Row
              label="awaiting field"
              value={session.pendingFieldKey ?? "—"}
            />
            {sessionMeta && (
              <Row
                label="last activity"
                value={new Date(sessionMeta.updated_at).toLocaleString()}
              />
            )}
          </div>
        ) : (
          <p className="text-xs text-zinc-500">No active session.</p>
        )}
      </div>

      <div>
        <h3 className="mb-1 text-xs font-semibold uppercase text-zinc-500">
          Collected fields ({collected.length})
        </h3>
        {collected.length === 0 ? (
          <p className="text-xs text-zinc-500">Nothing captured yet.</p>
        ) : (
          <ul className="space-y-1 font-mono text-xs">
            {collected.map(([key, value]) => (
              <li key={key} className="break-all">
                <span className="text-zinc-500">{key}:</span>{" "}
                {value.normalized ?? "—"}
                {value.raw !== value.normalized && (
                  <span className="text-zinc-400"> (raw: {value.raw})</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h3 className="mb-1 text-xs font-semibold uppercase text-zinc-500">
          Persisted case
        </h3>
        {completedCase ? (
          <pre className="max-h-72 overflow-auto rounded bg-zinc-950 p-2 text-[11px] leading-relaxed text-zinc-100">
            {JSON.stringify(completedCase, null, 2)}
          </pre>
        ) : (
          <p className="text-xs text-zinc-500">
            Appears here when an intake completes.
          </p>
        )}
      </div>
    </section>
  );
}
