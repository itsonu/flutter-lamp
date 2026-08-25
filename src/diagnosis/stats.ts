/**
 * Shared deterministic statistics.
 *
 * These live in one place because they are consumed by both performance
 * diagnosis and window comparison, and two percentile implementations that
 * disagree at the edges would make "p95 went up" unfalsifiable.
 */

/** Nearest-rank percentile over an ascending-sorted array. */
export function percentile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return round2(sorted[index]);
}

export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return round2(values.reduce((a, b) => a + b, 0) / values.length);
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
