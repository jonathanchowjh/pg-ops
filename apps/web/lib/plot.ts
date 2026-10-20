import { DAY_MS, HOUR_MS } from './clock';

/**
 * A population laid out on two log axes, and readings laid on a window's
 * columns, worked out where a test can reach them. The components draw what
 * these return and decide nothing.
 */

/** Points a scatter draws at most. Past this the page is megabytes of circles nobody can tell apart. */
export const SCATTER_MAX = 2_000;
/** Points named on the plot. The rest are named on hover. */
export const NAMED = 6;

export interface Mark {
  /** Unique on the plot, and the React key: a relation's name or a statement's id, never its text. */
  id: string;
  /** Empty: never named on the plot. */
  label: string;
  /** Null: in the band at the left, for "never" and "none". Zero or less sits on the plot's left edge. */
  x: number | null;
  y: number;
  /** Drawn in warning ink: the thing to hunt. */
  flag: boolean;
  /** What it is kept by, and named by, when there are too many. */
  weight: number;
  href: string | null;
  /** The readout's lines under the label. */
  lines: string[];
}

/** A log axis: the powers of ten it runs between. */
export interface LogAxis { lo: number; hi: number }

/** The decades that hold every positive value, and at least one. */
export function logAxis(values: readonly number[]): LogAxis {
  let min = Infinity;
  let max = 0;
  for (const v of values) {
    if (!(v > 0) || !Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (max === 0) return { lo: 0, hi: 1 };
  const lo = Math.floor(Math.log10(min));
  const hi = Math.ceil(Math.log10(max));
  return { lo, hi: hi === lo ? lo + 1 : hi };
}

/** Where a value falls along a log axis, 0 to 1. Zero and less sit at 0. */
export function along(axis: LogAxis, v: number): number {
  if (!(v > 0)) return 0;
  return Math.max(0, Math.min(1, (Math.log10(v) - axis.lo) / (axis.hi - axis.lo)));
}

/** The powers of ten an axis is ruled at. */
export function decades(axis: LogAxis): number[] {
  return Array.from({ length: axis.hi - axis.lo + 1 }, (_, i) => Number((10 ** (axis.lo + i)).toPrecision(1)));
}

/**
 * The same for bytes: 1, 10 and 100 of a binary unit, so a rule prints "10 KB"
 * where 10⁴ would print "9.8 KB". An axis that holds fewer than two of those
 * is ruled at 2 and 5 of them as well.
 */
export function byteDecades(axis: LogAxis): number[] {
  const within = (ms: number[]): number[] => Array.from({ length: 7 }, (_, k) => ms.map((m) => m * 1024 ** k)).flat()
    .filter((v) => v >= 10 ** axis.lo && v <= 10 ** axis.hi).sort((a, b) => a - b);
  const round = within([1, 10, 100]);
  return round.length >= 2 ? round : within([1, 2, 5, 10, 20, 50, 100, 200, 500]);
}

/**
 * A linear byte axis's rules, from zero: steps of a binary unit that print
 * round in `formatBytes`. Past 200 of a unit the step is 512 of it, whose
 * multiples are 0.5 of the next.
 */
export function byteSteps(max: number): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / 4;
  const unit = 1024 ** Math.max(0, Math.floor(Math.log(raw) / Math.log(1024)));
  const step = [1, 2, 5, 10, 20, 50, 100, 200, 512, 1024].find((m) => m * unit >= raw)! * unit;
  const count = Math.ceil(max / step - 1e-9);
  return Array.from({ length: count + 1 }, (_, i) => i * step);
}

/**
 * A line of equal x × y across the plot, clipped to it, in the same 0-to-1
 * coordinates as a point. Null when it misses the plot. On calls a second
 * against mean time it is a line of equal cost.
 */
export function isoLine(x: LogAxis, y: LogAxis, product: number): { x1: number; y1: number; x2: number; y2: number } | null {
  const from = Math.max(10 ** x.lo, product / 10 ** y.hi);
  const to = Math.min(10 ** x.hi, product / 10 ** y.lo);
  if (!(from < to)) return null;
  return { x1: along(x, from), y1: along(y, product / from), x2: along(x, to), y2: along(y, product / to) };
}

export interface Placed extends Mark {
  /** Null: in the band. */
  cx: number | null;
  cy: number;
  named: boolean;
}

export interface Scatter { marks: Placed[]; dropped: number; x: LogAxis; y: LogAxis }

/**
 * Lay a population out. The flagged are kept first and then the heaviest,
 * so a cap never hides the thing to hunt; the axes are the kept points'.
 * Drawn lightest first, so what was kept for a reason is on top.
 */
export function layScatter(marks: readonly Mark[], max = SCATTER_MAX): Scatter {
  const kept = [...marks]
    .sort((a, b) => Number(b.flag) - Number(a.flag) || b.weight - a.weight || a.id.localeCompare(b.id))
    .slice(0, max);
  const x = logAxis(kept.flatMap((m) => (m.x === null ? [] : [m.x])));
  const y = logAxis(kept.map((m) => m.y));
  const byWeight = [...kept].sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
  const named = new Set(byWeight.filter((m) => m.label !== '').slice(0, NAMED).map((m) => m.id));
  return {
    marks: byWeight.reverse().map((m) => ({ ...m, cx: m.x === null ? null : along(x, m.x), cy: along(y, m.y), named: named.has(m.id) })),
    dropped: marks.length - kept.length,
    x, y,
  };
}

/**
 * Readings each kept once a span (an hour's rollup, a capture) laid on a
 * window's columns: a column takes the reading whose span its middle falls
 * in, or null where none was kept. A step, never a line between two
 * readings: an hourly figure says nothing of the minutes inside it.
 */
export function onColumns(
  grid: { from: number; to: number; columns: number },
  points: readonly { at: number; value: number }[],
  spanMs: number,
): (number | null)[] {
  const width = (grid.to - grid.from) / grid.columns;
  const sorted = [...points].sort((a, b) => a.at - b.at);
  return Array.from({ length: grid.columns }, (_, c) => {
    const mid = grid.from + (c + 0.5) * width;
    let found: number | null = null;
    for (const p of sorted) {
      if (p.at > mid) break;
      if (mid < p.at + spanMs) found = p.value;
    }
    return found;
  });
}

/**
 * Per-second rates from a counter kept once a minute: each minute against
 * the one before, over the seconds between, laid at the interval's start.
 * A fall, a missing reading or a change of `epoch` (a statistics reset)
 * gives no rate, not a zero.
 */
export function perSecond<T extends { at: number }>(
  points: readonly T[],
  pick: (p: T) => number | null,
  epoch: (p: T) => unknown = () => null,
): { at: number; value: number }[] {
  const sorted = [...points].sort((a, b) => a.at - b.at);
  const out: { at: number; value: number }[] = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    const a = pick(prev);
    const b = pick(cur);
    if (a === null || b === null || b < a || epoch(prev) !== epoch(cur) || cur.at <= prev.at) continue;
    out.push({ at: prev.at, value: (b - a) / ((cur.at - prev.at) / 1000) });
  }
  return out;
}


/**
 * Is this hour normal for this hour: the mean of each hour of the day over
 * the `days` before the one `now` is in, or over the days since the first
 * reading when that is fewer, and that day's own hours. An hour
 * with no reading was quiet, which is zero; an hour the day has not reached
 * is null. `offsetMins` is the reader's zone, so only a browser can call
 * this truthfully.
 */
export function byHourOfDay(
  hours: readonly { at: number; sessions: number }[], now: number, offsetMins: number, days = 7,
): { mean: number[]; today: (number | null)[] } {
  const shift = offsetMins * 60_000;
  const dayOf = (t: number): number => Math.floor((t + shift) / DAY_MS);
  const hourOf = (t: number): number => Math.floor((t + shift - dayOf(t) * DAY_MS) / HOUR_MS);
  const thisDay = dayOf(now);
  const sums = Array.from({ length: 24 }, () => 0);
  const today: (number | null)[] = Array.from({ length: 24 }, (_, h) => (h <= hourOf(now) ? 0 : null));
  let first = thisDay;
  for (const p of hours) {
    const day = dayOf(p.at);
    if (day === thisDay) today[hourOf(p.at)] = p.sessions;
    else if (day < thisDay && day >= thisDay - days) {
      sums[hourOf(p.at)]! += p.sessions;
      first = Math.min(first, day);
    }
  }
  // Over the days since the first reading: a store two days old has two days to mean, not seven.
  const held = Math.max(1, thisDay - first);
  return { mean: sums.map((s) => s / held), today };
}
