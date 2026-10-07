export const DAY_MS = 86_400_000;

/**
 * Fewer daily peaks than this and there is no trend, only a few days.
 * Seven because the load most databases carry has a weekly shape, and a
 * line through Monday to Thursday projects a weekend that will not happen.
 */
export const MIN_TREND_DAYS = 7;

/** `day` is where the period starts, in days since the epoch. It need not be a whole number. */
export interface Peak { day: number; value: number }

/**
 * The highest reading of each 24-hour period, counted BACK from `to`.
 *
 * Not calendar days. A window rarely starts or ends at midnight UTC, so
 * calendar days gave it a fragment at each end, and a fragment's "peak" is
 * whatever hour it happened to hold: a window ending at 01:00 closed on one
 * hour of overnight trough, and a rising week read as falling. Counted back
 * from the end, every period is whole.
 */
export function dailyPeaks(
  points: readonly { at: number; value: number | null }[],
  to: number,
): Peak[] {
  const byPeriod = new Map<number, number>();
  for (const p of points) {
    if (p.value === null) continue;
    const period = Math.floor((to - p.at - 1) / DAY_MS);
    if (period < 0) continue;
    const seen = byPeriod.get(period);
    if (seen === undefined || p.value > seen) byPeriod.set(period, p.value);
  }
  return [...byPeriod]
    .sort((a, b) => b[0] - a[0])
    .map(([period, value]) => ({ day: to / DAY_MS - period - 1, value }));
}

export interface TrendLine { perDay: number; intercept: number }

/**
 * A least-squares straight line through the daily peaks, each placed at the
 * middle of its period. Null under MIN_TREND_DAYS.
 *
 * PEAKS, not every reading: connections follow the working day and
 * transaction ID age falls each time vacuum freezes, so a fit through raw
 * points measures the trough as much as the approach to the limit.
 */
export function fitPeaks(peaks: readonly Peak[]): TrendLine | null {
  if (peaks.length < MIN_TREND_DAYS) return null;
  const xs = peaks.map((p) => p.day + 0.5);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = peaks.reduce((a, p) => a + p.value, 0) / peaks.length;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < peaks.length; i += 1) {
    sxx += (xs[i]! - mx) ** 2;
    sxy += (xs[i]! - mx) * (peaks[i]!.value - my);
  }
  if (sxx === 0) return null;
  const perDay = sxy / sxx;
  return { perDay, intercept: my - perDay * mx };
}

/** The line's value at a moment in epoch milliseconds. */
export function valueAt(line: TrendLine, at: number): number {
  return line.intercept + line.perDay * (at / DAY_MS);
}

/**
 * Days from `at` until the line reaches `ceiling`. Null when it is not
 * rising: a flat or falling line never arrives, and a date invented for it
 * would be read as a forecast.
 */
export function daysUntil(line: TrendLine, ceiling: number, at: number): number | null {
  // A slope this small is a flat line with floating-point noise on it.
  if (line.perDay <= 1e-9) return null;
  const now = valueAt(line, at);
  return now >= ceiling ? 0 : (ceiling - now) / line.perDay;
}
