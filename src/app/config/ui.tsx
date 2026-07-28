/**
 * Shared presentation bits for the taxonomy editor. Server components: the
 * editor is plain forms posting to server actions, so it needs no client JS.
 */
import type { ReactNode } from "react";

export const input =
  "rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900";
export const smallButton =
  "rounded border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800";
export const primaryButton =
  "rounded bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900";
export const dangerButton =
  "rounded border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950";

export function Field({
  label,
  children,
  width = "w-full",
}: {
  label: string;
  children: ReactNode;
  width?: string;
}) {
  return (
    <label className={`flex flex-col gap-1 text-xs text-zinc-500 ${width}`}>
      {label}
      {children}
    </label>
  );
}

export function Card({
  title,
  children,
  tone = "default",
}: {
  title?: string;
  children: ReactNode;
  tone?: "default" | "muted";
}) {
  const border =
    tone === "muted"
      ? "border-dashed border-zinc-300 dark:border-zinc-700"
      : "border-zinc-200 dark:border-zinc-800";
  return (
    <section className={`rounded-lg border p-4 ${border}`}>
      {title && <h2 className="mb-3 font-medium">{title}</h2>}
      {children}
    </section>
  );
}

export function ErrorBanner({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p className="mb-4 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
      {message}
    </p>
  );
}
