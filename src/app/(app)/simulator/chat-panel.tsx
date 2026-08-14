"use client";

import { useEffect, useRef, useState } from "react";
import type { ListRow } from "@/lib/whatsapp";
import type { TranscriptEntry } from "./types";

interface ChatPanelProps {
  transcript: TranscriptEntry[];
  busy: boolean;
  rtl: boolean;
  onSendText: (text: string) => void;
  onTapOption: (row: ListRow) => void;
}

const BUBBLE: Record<TranscriptEntry["role"], string> = {
  customer: "ms-auto bg-emerald-100 dark:bg-emerald-900/60",
  bot: "me-auto bg-white dark:bg-zinc-800",
  system:
    "mx-auto bg-amber-100 text-amber-900 dark:bg-amber-900/50 dark:text-amber-100",
};

export function ChatPanel({
  transcript,
  busy,
  rtl,
  onSendText,
  onTapOption,
}: ChatPanelProps) {
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript.length]);

  function submit() {
    const text = draft.trim();
    if (text === "" || busy) return;
    setDraft("");
    onSendText(text);
  }

  const lastBot = [...transcript].reverse().find((e) => e.role === "bot");
  const openOptions = lastBot?.options ?? [];

  return (
    <section
      dir={rtl ? "rtl" : "ltr"}
      className="flex min-h-[32rem] flex-1 flex-col rounded-xl border border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900"
    >
      <header className="flex items-center gap-2 rounded-t-xl bg-emerald-700 px-4 py-2 text-sm font-medium text-white">
        <span className="grid size-7 place-items-center rounded-full bg-emerald-600">
          💬
        </span>
        ChicChat (simulated WhatsApp)
      </header>

      <div className="flex-1 space-y-2 overflow-y-auto p-4">
        {transcript.length === 0 && (
          <p className="py-8 text-center text-sm text-zinc-500">
            Send a message to start an intake.
          </p>
        )}
        {transcript.map((entry) => (
          <div key={entry.id} className="flex">
            <div
              className={`max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm shadow-sm ${BUBBLE[entry.role]}`}
            >
              {entry.isPhoto && <div className="mb-1 text-2xl">🖼️</div>}
              {entry.text}
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {openOptions.length > 0 && (
        <div className="flex flex-wrap gap-2 border-t border-zinc-200 p-3 dark:border-zinc-800">
          {openOptions.map((row) => (
            <button
              key={row.id}
              type="button"
              disabled={busy}
              onClick={() => onTapOption(row)}
              title={row.description ?? row.title}
              className="rounded-full border border-emerald-600 px-3 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50 dark:text-emerald-300 dark:hover:bg-emerald-900/40"
            >
              {row.title}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 border-t border-zinc-200 p-3 dark:border-zinc-800">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder="Type a message…"
          aria-label="Message"
          className="flex-1 rounded-full border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800"
        />
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          className="rounded-full bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
        >
          {busy ? "…" : "Send"}
        </button>
      </div>
    </section>
  );
}
