/**
 * Shared presentation for the case views (SPEC §8). Server components.
 */
import type { ReactNode } from "react";

const STATUS_TONE: Record<string, string> = {
  open: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-200",
  in_progress:
    "bg-indigo-100 text-indigo-900 dark:bg-indigo-900/60 dark:text-indigo-100",
  needs_info:
    "bg-amber-100 text-amber-900 dark:bg-amber-900/60 dark:text-amber-100",
  handed_off: "bg-sky-100 text-sky-900 dark:bg-sky-900/60 dark:text-sky-100",
  escalated:
    "bg-orange-100 text-orange-900 dark:bg-orange-900/60 dark:text-orange-100",
  resolved: "bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200",
  abandoned: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200",
};

export function StatusBadge({ status }: { status: string }) {
  const tone = STATUS_TONE[status] ?? STATUS_TONE.resolved;
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${tone}`}>
      {status}
    </span>
  );
}

const PRIORITY_TONE: Record<string, string> = {
  high: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200",
  normal: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  low: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
};

export function PriorityBadge({ priority }: { priority: string }) {
  const tone = PRIORITY_TONE[priority] ?? PRIORITY_TONE.normal;
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${tone}`}>
      {priority}
    </span>
  );
}

/** A case with no matching routing rule belongs to no queue (SPEC §3). */
export function queueName(queue: string | null): string {
  return queue ?? "unrouted";
}

export function Panel({
  title,
  children,
  aside,
}: {
  title: string;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="font-medium">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-28 rounded border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
    </div>
  );
}

/** Phone numbers are shown masked in list views, per SPEC §12. */
export function maskedPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length <= 4 ? `****${digits}` : `****${digits.slice(-4)}`;
}

export function formatWhen(value: string): string {
  return new Date(value).toLocaleString();
}
