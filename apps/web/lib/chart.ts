import type { Unit } from './format';

/** A reading on a chart's time axis. A null is a hole the line breaks at. */
export interface ChartPoint { at: number; value: number | null }

/** How many gridline intervals a plot aims for. Fewer when the step rounds up. */
const INTERVALS = 5;

const DECIMAL = [1, 2, 5];
/** Seconds, minutes and hours a reader expects to see ruled. */
const SECONDS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14_400, 21_600, 43_200, 86_400];
const BINARY = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512];

/**
 * The smallest round step no smaller than `raw`, in the unit's own idea of
 * round: 1, 2, 5 and their decades; whole seconds, minutes and hours for a
 * duration; powers of two above a kilobyte for bytes, so a tick prints as
 * "256 KB" and not "250 KB".
 */
function roundStep(raw: number, unit: Unit): number {
  if (unit === 'secs' && raw <= 86_400) return SECONDS.find((s) => s >= raw)!;
  if (unit === 'millis' && raw >= 1000 && raw <= 86_400_000) return SECONDS.find((s) => s * 1000 >= raw)! * 1000;
  if ((unit === 'bytes' || unit === 'bytesPerSec') && raw >= 1024) {
    let scale = 1024;
    while (raw > scale * 512) scale *= 1024;
    return BINARY.find((b) => b * scale >= raw)! * scale;
  }
  const decade = 10 ** Math.floor(Math.log10(raw));
  return (DECIMAL.find((d) => d * decade >= raw) ?? 10) * decade;
}

/**
 * Gridline offsets for an axis that spans at least `range`: 0, one step,
 * two steps, up to the first round multiple at or above `range`. Counts and
 * seconds are never ruled finer than one.
 *
 * `[0]` for an empty range. A series that never left zero gets its baseline
 * and no invented scale above it.
 */
export function ticks(range: number, unit: Unit): number[] {
  if (!(range > 0)) return [0];
  const floor = unit === 'count' || unit === 'secs' ? 1 : 0;
  const step = roundStep(Math.max(range / INTERVALS, floor), unit);
  const n = Math.ceil(range / step - 1e-9);
  // `3 * 0.1` is 0.30000000000000004; a tick is printed, so round it.
  return Array.from({ length: n + 1 }, (_, i) => Number((i * step).toPrecision(12)));
}

/**
 * Break a series wherever pgops stopped looking, so the line does not assert
 * values across a hole.
 *
 * The break is at three times the median spacing. A capture already in
 * progress on another replica is skipped, never queued, so a single missing
 * tick is normal. Two consecutive misses are not.
 */
export function withGaps(points: readonly { at: number; value: number }[]): ChartPoint[] {
  if (points.length < 3) return [...points];
  const gaps = points.slice(1).map((p, i) => p.at - points[i]!.at);
  const median = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)]!;
  const out: ChartPoint[] = [points[0]!];
  for (let i = 1; i < points.length; i += 1) {
    if (gaps[i - 1]! > median * 3) out.push({ at: points[i - 1]!.at + gaps[i - 1]! / 2, value: null });
    out.push(points[i]!);
  }
  return out;
}

/**
 * A captured series as chart props: holes marked, and the time axis running
 * from the first capture to the last, because a capture has no window of
 * its own.
 */
export function captured(points: readonly { at: Date; value: number }[]): { points: ChartPoint[]; from: number; to: number } {
  const ms = points.map((p) => ({ at: p.at.getTime(), value: p.value }));
  return { points: withGaps(ms), from: ms[0]?.at ?? 0, to: ms[ms.length - 1]?.at ?? 0 };
}

/** The index of the point nearest a moment, or -1 for no points. */
export function nearest(points: readonly ChartPoint[], at: number): number {
  let best = -1;
  for (let i = 0; i < points.length; i += 1) {
    if (best === -1 || Math.abs(points[i]!.at - at) < Math.abs(points[best]!.at - at)) best = i;
  }
  return best;
}
