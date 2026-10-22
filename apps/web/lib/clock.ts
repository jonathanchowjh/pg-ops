/**
 * The clock's arithmetic: which window a URL asks for, where a moment falls
 * in it, and how the cursor moves; and the words for what it draws. Pure,
 * and shared by the server, which reads the window, and the client, which
 * moves the cursor inside it.
 *
 * `BUCKET_MS` and `CLASSES` are copies of the checks package's, which a
 * client component cannot import without pulling `pg` into the browser.
 * guards.test.ts ("the class list") holds each pair equal.
 */

export const BUCKET_MS = 15_000;
export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
/** The four windows the bar offers, in seconds, as the URL carries them. */
export const WINDOWS = [900, 3600, 21_600, 86_400] as const;
const DEFAULT_WINDOW_SECS = 3600;
const MIN_WINDOW_SECS = 120;
/** Session rows, and raw samples, at two hours or closer. */
const RAW_WINDOW_MS = 2 * 3_600_000;
const COLUMNS = 120;

/** The five classes, bottom up. A copy of `CLASSES` in @pgops/checks, as `BUCKET_MS` is. */
export const CLASSES = ['cpu', 'io', 'idle', 'other', 'lock'] as const;

/** A class as a series: the band's legend and every readout. */
export const CLASS_NAMES = {
  cpu: 'CPU', io: 'IO', idle: 'Idle in transaction', other: 'Other wait', lock: 'Lock wait',
} as const;

/** A class as what one session is doing: beside a session's duration. */
export const CLASS_STATES = {
  cpu: 'on CPU', io: 'on IO', idle: 'idle in txn', other: 'waiting', lock: 'lock wait',
} as const;

/** An event as a mark's label. A kind with no name here is not drawn: `chain-end`, `reachable`. */
export const EVENT_NAMES: Record<string, string> = {
  'chain-begin': 'lock chain', terminate: 'terminated', analyze: 'analyze', vacuum: 'vacuum',
  reset: 'statistics reset', unreachable: 'unreachable',
};

export interface Grid {
  from: number;
  to: number;
  columns: number;
  /** Read from the samples; false reads the minute rollup. */
  raw: boolean;
  /** The window ends now. */
  live: boolean;
  /** The window asked for, in seconds, for the bar's pressed button and the next URL. */
  winSecs: number;
}

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/** A page's search parameters as Next hands them over. */
export type Search = Record<string, string | string[] | undefined>;
/** The first value of a parameter, or ''. A repeated `?find=a&find=b` arrives as an array. */
export const one = (v: string | string[] | undefined): string => first(v) ?? '';

/**
 * The window a URL asks for. Anything unusable falls back instead of
 * throwing: a window that is not a number, shorter than two minutes or
 * longer than a day; an end in the future or more than a day back.
 *
 * A wide window is laid on whole minutes, because the rollup is per minute:
 * each column is a whole number of them, and the window ends when the
 * minute holding its end closes. On a live page that is up to a minute
 * ahead of now, which is where the live sample falls.
 */
export function gridFor(sp: { win?: string | string[]; end?: string | string[] }, now: number): Grid {
  const asked = Number(first(sp.win));
  const winSecs = Number.isFinite(asked) && asked >= MIN_WINDOW_SECS && asked <= DAY_MS / 1000
    ? Math.round(asked) : DEFAULT_WINDOW_SECS;
  const win = winSecs * 1000;
  const end = Number(first(sp.end));
  const live = !(Number.isFinite(end) && end > 0 && end < now);
  const until = live ? now : Math.max(end, now - DAY_MS + win);
  if (win <= RAW_WINDOW_MS) {
    return { from: until - win, to: until, columns: COLUMNS, raw: true, live, winSecs };
  }
  const minutes = win / MINUTE_MS;
  const perColumn = Math.ceil(minutes / COLUMNS);
  const columns = Math.floor(minutes / perColumn);
  const to = Math.ceil(until / MINUTE_MS) * MINUTE_MS;
  return { from: to - columns * perColumn * MINUTE_MS, to, columns, raw: false, live, winSecs };
}

/** The query string for a window. Live has no `end`. */
export function windowQuery(winSecs: number, end: number | null): string {
  return end === null ? `?win=${winSecs}` : `?win=${winSecs}&end=${Math.round(end)}`;
}

/**
 * What a change of window keeps: the find text and the open folds. Folds
 * are repeated `open=` values, because a quoted table name may hold any
 * character; one empty value means every fold is shut, which is not the
 * same as saying nothing.
 */
export function keepQuery(find: string, open: readonly string[] | null): string {
  const p = new URLSearchParams();
  if (find !== '') p.set('find', find);
  for (const name of open ?? []) p.append('open', name);
  if (open !== null && open.length === 0) p.set('open', '');
  const s = p.toString();
  return s === '' ? '' : `&${s}`;
}

/** The folds a URL holds open, or null when it says nothing and the tree chooses. */
export function openFrom(v: string | string[] | undefined): Set<string> | null {
  if (v === undefined) return null;
  return new Set((Array.isArray(v) ? v : [v]).filter((s) => s !== ''));
}

/** The open folds with one flipped. */
export function toggled(open: readonly string[], key: string): string[] {
  return open.includes(key) ? open.filter((k) => k !== key) : [...open, key];
}

/** Where a moment falls across the window, 0 at its start and 1 at its end. */
export function fractionAt(grid: Pick<Grid, 'from' | 'to'>, t: number): number {
  return (t - grid.from) / (grid.to - grid.from);
}

/** A twelve-pixel sans character's width, roughly: what a label's box is reckoned from. */
export const CHAR_PX = 6.6;

/**
 * Events on a plot `width` pixels wide, in the window and in order. A label
 * reads rightwards from its mark, or `leftward` where it would run past the
 * plot. A mark is `named` when its label clears the last named one's; the
 * rest are marks with their label left to the readout.
 */
export function labelMarks<T extends { at: number; label: string }>(
  marks: readonly T[], grid: Pick<Grid, 'from' | 'to'>, width: number,
): (T & { x: number; named: boolean; leftward: boolean })[] {
  let end = -Infinity;
  return marks.filter((m) => m.at >= grid.from && m.at <= grid.to).sort((a, b) => a.at - b.at).map((m) => {
    const x = fractionAt(grid, m.at);
    const px = x * width;
    // Four pixels from the mark, two of padding each side.
    const w = m.label.length * CHAR_PX + 8;
    const leftward = px + w > width;
    const [left, right] = leftward ? [px - w, px] : [px, px + w];
    const named = left >= 0 && left > end + 4;
    if (named) end = right;
    return { ...m, x, named, leftward };
  });
}

/**
 * The moment under a point `x` of the way across, snapped to a sample, and
 * never off the window: a live window's edges are not on a sample, and a
 * click at its left edge must pin, not round out of it and go live.
 */
export function timeAt(grid: Pick<Grid, 'from' | 'to'>, x: number): number {
  const t = grid.from + Math.max(0, Math.min(1, x)) * (grid.to - grid.from);
  const first = Math.ceil(grid.from / BUCKET_MS) * BUCKET_MS;
  const last = Math.ceil(grid.to / BUCKET_MS) * BUCKET_MS - BUCKET_MS;
  return Math.max(first, Math.min(last, Math.round(t / BUCKET_MS) * BUCKET_MS));
}

/** The column a moment falls in. */
export function columnAt(grid: Pick<Grid, 'from' | 'to' | 'columns'>, t: number): number {
  return Math.max(0, Math.min(grid.columns - 1, Math.floor(fractionAt(grid, t) * grid.columns)));
}

/**
 * The cursor one step on. A step is a sample, or a column where a column is
 * wider. Null is live: stepping forward off the end of a live window returns
 * there. `cursor` null is live too, and steps back from the window's end.
 */
export function step(grid: Grid, cursor: number | null, dir: -1 | 1): number | null {
  const by = Math.max(BUCKET_MS, (grid.to - grid.from) / grid.columns);
  const next = (cursor ?? grid.to) + dir * by;
  if (next >= grid.to) return grid.live ? null : grid.to - by;
  return Math.max(grid.from, next);
}

/** The next event strictly after the cursor, or the last one strictly before it. */
export function hop(events: readonly { at: number }[], cursor: number, dir: -1 | 1): number | null {
  const sorted = events.map((e) => e.at).sort((a, b) => a - b);
  const found = dir > 0 ? sorted.find((t) => t > cursor) : sorted.reverse().find((t) => t < cursor);
  return found ?? null;
}

/** A dragged selection as the window to zoom to: at least two minutes, ending where the drag did. */
export function zoomTo(a: number, b: number): { winSecs: number; end: number } {
  const from = Math.min(a, b);
  const to = Math.max(a, b);
  return { winSecs: Math.max(MIN_WINDOW_SECS, Math.round((to - from) / BUCKET_MS) * (BUCKET_MS / 1000)), end: to };
}

/** The window's end that brings `t` into view, three tenths from the right, as the mock does. */
export function endShowing(grid: Grid, t: number): number {
  return t + 0.3 * (grid.to - grid.from);
}

const two = (n: number): string => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A clock time, 16:13:52. `offsetMins` is the zone: 0 for UTC, and for
 * local time `-new Date(t).getTimezoneOffset()`, which only a browser
 * knows. That is why times are formatted on the client.
 */
export function clockTime(t: number, offsetMins: number, seconds = true): string {
  const d = new Date(t + offsetMins * MINUTE_MS);
  return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}${seconds ? `:${two(d.getUTCSeconds())}` : ''}`;
}

/** A clock time with its date once it is more than twelve hours from `now`. */
export function stamp(t: number, offsetMins: number, now: number): string {
  const d = new Date(t + offsetMins * MINUTE_MS);
  const date = Math.abs(now - t) > DAY_MS / 2 ? `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ` : '';
  return `${date}${clockTime(t, offsetMins)}`;
}

interface Tick { t: number; at: number; label: string }

const STEPS_SECS = [60, 120, 300, 600, 900, 1800, 3600, 7200, 10_800, 21_600, 43_200];

/**
 * Axis ticks on round clock times: about one per 92 px, never within 4 % of
 * an edge. Midnight is labelled with its date.
 */
export function axisTicks(grid: Pick<Grid, 'from' | 'to'>, widthPx: number, offsetMins: number): Tick[] {
  const span = (grid.to - grid.from) / 1000;
  const want = Math.max(2, Math.floor(widthPx / 92));
  const stepMs = (STEPS_SECS.find((s) => span / s <= want) ?? 43_200) * 1000;
  const shift = offsetMins * MINUTE_MS;
  const out: Tick[] = [];
  for (let t = Math.ceil((grid.from + shift) / stepMs) * stepMs - shift; t <= grid.to; t += stepMs) {
    const at = fractionAt(grid, t);
    if (at <= 0.04 || at >= 0.96) continue;
    const d = new Date(t + shift);
    const midnight = stepMs >= 3_600_000 && d.getUTCHours() === 0 && d.getUTCMinutes() === 0;
    out.push({ t, at, label: midnight ? `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}` : clockTime(t, offsetMins, false) });
  }
  return out;
}

/** When the database was last marked unreachable at a moment, or null if it was reachable then. */
export function downSince(transitions: readonly { at: number; kind: 'unreachable' | 'reachable' }[], at: number): number | null {
  let since: number | null = null;
  for (const t of transitions) {
    if (t.at > at) break;
    since = t.kind === 'unreachable' ? t.at : null;
  }
  return since;
}
