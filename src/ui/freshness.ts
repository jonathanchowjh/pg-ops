/** Relative freshness label for the status bar, e.g. "updated 3s ago". */
export function formatFreshness(secondsAgo: number): string {
  if (!Number.isFinite(secondsAgo) || secondsAgo < 1) return 'updated just now';
  if (secondsAgo < 60) return `updated ${Math.floor(secondsAgo)}s ago`;
  return `updated ${Math.floor(secondsAgo / 60)}m ago`;
}
