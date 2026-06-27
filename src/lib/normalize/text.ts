/**
 * Free-text normalization (SPEC.md §2) for fields like `description` /
 * `question`: trim and collapse internal whitespace so the captured value is
 * clean for the agent handoff.
 */
export function normalizeText(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}
