"use client";

import { useState, useTransition, type ReactNode } from "react";
import type { ConfigActionResult } from "./actions";

/** Save one section without navigating away or resetting its siblings' drafts. */
export function ConfigForm({
  action,
  children,
  className,
  resetOnSuccess = false,
}: {
  action: (data: FormData) => Promise<ConfigActionResult>;
  children: ReactNode;
  className?: string;
  resetOnSuccess?: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  return (
    <form
      className={className}
      onChange={() => {
        setFailed(false);
        setMessage("Unsaved changes in this section.");
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;
        const form = event.currentTarget;
        const data = new FormData(form);
        startTransition(async () => {
          try {
            const result = await action(data);
            setFailed(Boolean(result.error));
            setMessage(result.error ?? "Saved.");
            if (!result.error && resetOnSuccess) form.reset();
          } catch {
            setFailed(true);
            setMessage(
              "Could not save. Your edits are still here; please try again.",
            );
          }
        });
      }}
    >
      <fieldset disabled={pending} className="contents">
        {children}
      </fieldset>
      {message && (
        <p role={failed ? "alert" : "status"} className="w-full text-xs">
          {pending ? "Saving…" : message}
        </p>
      )}
    </form>
  );
}
