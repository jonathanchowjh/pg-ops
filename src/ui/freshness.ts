/** Relative freshness label for the status bar, e.g. "updated 3s ago". */
export function formatFreshness(secondsAgo: number): string {
  if (!Number.isFinite(secondsAgo) || secondsAgo < 1) return 'updated just now';
  if (secondsAgo < 60) return `updated ${Math.floor(secondsAgo)}s ago`;
  return `updated ${Math.floor(secondsAgo / 60)}m ago`;
}

/**
 * The status-bar freshness label for a view's `lastPollAt` (usePoll).
 *
 * `undefined` means no poll has succeeded yet — there is no freshness to report
 * for numbers that were never measured, and "updated just now" would be a lie.
 * Every view renders this identically (deep-review I2).
 */
export function freshnessLabel(lastPollAt: number | undefined, now: number = Date.now()): string {
  if (lastPollAt === undefined) return 'not updated yet';
  return formatFreshness((now - lastPollAt) / 1000);
}
