/**
 * Analytics arithmetic (SPEC §8) — pure, so "median" and "abandonment rate"
 * have one definition with tests, instead of being buried in SQL.
 */

/** Median of a numeric sample; null for an empty sample (never 0, which lies). */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Share of intakes that were abandoned rather than finished, as a 0–1 fraction.
 * Null when nothing finished or abandoned yet — a rate over zero cases is
 * meaningless, not zero.
 */
export function abandonmentRate(
  completed: number,
  abandoned: number,
): number | null {
  const total = completed + abandoned;
  if (total <= 0) return null;
  return abandoned / total;
}

/** Seconds → a short human duration ("4m 12s"), for the console. */
export function formatDuration(seconds: number | null): string {
  if (seconds === null) return "—";
  const whole = Math.max(0, Math.round(seconds));
  if (whole < 60) return `${whole}s`;
  const minutes = Math.floor(whole / 60);
  if (minutes < 60) return `${minutes}m ${whole % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function formatPercent(fraction: number | null): string {
  return fraction === null ? "—" : `${Math.round(fraction * 100)}%`;
}
