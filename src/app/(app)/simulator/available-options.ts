import type { ListRow } from "@/lib/whatsapp";
import type { TranscriptEntry } from "./types";

export function availableOptions(
  entries: TranscriptEntry[],
  active: boolean,
): ListRow[] {
  if (!active) return [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.role === "bot" && !entry.notification) return entry.options ?? [];
  }
  return [];
}
