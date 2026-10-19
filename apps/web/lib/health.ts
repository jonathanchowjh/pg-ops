import {
  GATES, GATE_ORDER, XID_WRAPAROUND, readHealthHistory, type Gate, type HealthHistory, type HealthMetric, type HealthPoint,
} from '@pgops/checks';
import type { HealthChartPoint } from '@/components/health-chart';
import { readStore } from './check';
import { formatBytes, formatUnit, formatUtc, plural, type Unit } from './format';
import { DAY_MS, MIN_TREND_DAYS, dailyPeaks, daysUntil, fitPeaks, valueAt } from './trend';

export const FLEET_HOURS = 48;
/**
 * About one point per 24 minutes over 48 hours. Sixty databases by six
 * charts at this density is 43,000 points in the page; at the raw minute it
 * would be a million.
 */
export const FLEET_POINTS = 120;
export const HEALTH_POINTS = 180;

export const HISTORY_OFF =
  'History is off. Set PGOPS_STORE_URL to a Postgres database pgops may create its own schema in, then restart.';
export const COLLECTING = 'Collecting. The first chart appears in a minute.';

const RECENT_MS = 5 * 60_000;

/**
 * What to say when a window holds too few rows to draw.
 *
 * "Collecting" is true only when pgops has just started for this database:
 * it has never stored a row, or its newest is minutes old and the window
 * ends now. A database that is down also has an empty window, because an
 * unreachable database writes no rows. So does a window from the URL that
 * covers a stretch nothing was recorded in.
 */
export function emptyReason(lastAt: number | null, windowTo: number, now: number): string {
  if (lastAt === null) return COLLECTING;
  if (now - lastAt < RECENT_MS && now - windowTo < RECENT_MS) return COLLECTING;
  return `No readings in this window. The last was at ${formatUtc(lastAt)} UTC.`;
}

export type HealthRead =
  | { ok: true; histories: HealthHistory[] }
  | { ok: false; kind: 'off' | 'error'; message: string };

/**
 * Stored health for some databases over a window. Reads the store and
 * nothing else: no monitored database is contacted, which is why the fleet
 * page can poll and a database that is down still shows its past.
 */
export async function healthFor(
  names: readonly string[],
  from: Date,
  to: Date,
  points: number,
): Promise<HealthRead> {
  const read = await readStore((store) => readHealthHistory(store, { names, from, to, points }));
  if (read.ok) return { ok: true, histories: read.value };
  return { ok: false, kind: read.kind, message: read.kind === 'off' ? HISTORY_OFF : read.message };
}

const NO_READING = 'No reading in this window.';
const NEEDS_TWO = 'A rate needs two readings a minute apart, with no statistics reset between them.';
/**
 * Worded without the verb an operator would type. The DDL guard in
 * guards.test.ts matches that verb followed by any word, case-insensitively,
 * and would read this sentence as a privilege statement.
 */
const SESSIONS_HIDDEN =
  'This role cannot see other sessions, so it cannot count them. It needs the pg_read_all_stats role.';
const CREDITED_LATE =
  'Postgres credits a statement when it finishes, so a long one lands in its last minute.';

export interface ChartSpec {
  metric: HealthMetric;
  gate: Gate;
  label: string;
  unit: Unit;
  /** `server` figures are the same from every database on that server, and the page says so. */
  scope: 'database' | 'server';
  /** A level is sampled once a minute; a rate covers the whole minute. Only levels get a trend. */
  kind: 'level' | 'rate';
  fleet: boolean;
  ceiling?: 'maxConnections' | 'wraparound';
  inner?: HealthMetric;
  innerLabel?: string;
  /** False where the change is small against the size of the thing. */
  zero?: boolean;
  /** Shown in place of the plot when the whole window is null. */
  empty: string;
  caveat?: string;
}

/**
 * Every chart, in gate order. The pages are built from this list: the fleet
 * page takes the `fleet` six, the database page groups all of them by gate.
 */
export const HEALTH_CHARTS: readonly ChartSpec[] = [
  { metric: 'serverConnections', gate: 'connect', label: 'Connections', unit: 'count', scope: 'server',
    kind: 'level', fleet: true, ceiling: 'maxConnections', inner: 'connections',
    innerLabel: 'this database', empty: SESSIONS_HIDDEN },
  { metric: 'sessionsPerSec', gate: 'connect', label: 'New sessions', unit: 'perSec', scope: 'database',
    kind: 'rate', fleet: false, empty: NEEDS_TWO },
  { metric: 'badSessions', gate: 'connect', label: 'Sessions lost, killed or crashed', unit: 'count',
    scope: 'database', kind: 'rate', fleet: false, empty: NEEDS_TWO },

  { metric: 'blocked', gate: 'wait', label: 'Blocked sessions', unit: 'count', scope: 'database',
    kind: 'level', fleet: true, empty: NO_READING },
  { metric: 'longestWaitSecs', gate: 'wait', label: 'Longest lock wait', unit: 'secs', scope: 'database',
    kind: 'level', fleet: false, empty: NO_READING },
  { metric: 'avgIdleInTxn', gate: 'wait', label: 'Idle in transaction, average sessions', unit: 'sessions',
    scope: 'database', kind: 'rate', fleet: false, empty: NEEDS_TWO, caveat: CREDITED_LATE },
  { metric: 'idleInTxn', gate: 'wait', label: 'Idle in transaction, sampled', unit: 'count',
    scope: 'database', kind: 'level', fleet: false, empty: SESSIONS_HIDDEN },
  { metric: 'deadlocks', gate: 'wait', label: 'Deadlocks', unit: 'count', scope: 'database',
    kind: 'rate', fleet: false, empty: NEEDS_TWO },

  { metric: 'avgActive', gate: 'work', label: 'Average active sessions', unit: 'sessions',
    scope: 'database', kind: 'rate', fleet: true, empty: NEEDS_TWO, caveat: CREDITED_LATE },
  { metric: 'active', gate: 'work', label: 'Active sessions, sampled', unit: 'count', scope: 'database',
    kind: 'level', fleet: false, empty: SESSIONS_HIDDEN },
  { metric: 'longestQuerySecs', gate: 'work', label: 'Longest running statement', unit: 'secs',
    scope: 'database', kind: 'level', fleet: false, empty: SESSIONS_HIDDEN },
  { metric: 'commitsPerSec', gate: 'work', label: 'Commits', unit: 'perSec', scope: 'database',
    kind: 'rate', fleet: false, inner: 'ownPerSec', innerLabel: 'statements pgops itself sent',
    empty: NEEDS_TWO },
  { metric: 'rollbacksPerSec', gate: 'work', label: 'Rollbacks', unit: 'perSec', scope: 'database',
    kind: 'rate', fleet: false, empty: NEEDS_TWO },
  { metric: 'hitPct', gate: 'work', label: 'Buffer hit rate', unit: 'pct', scope: 'database',
    kind: 'rate', fleet: true, empty: 'No block was read in this window, so there is no rate.',
    caveat: 'A miss here is often served from the operating system\'s cache.' },
  { metric: 'tempBytesPerSec', gate: 'work', label: 'Written to temp files', unit: 'bytesPerSec',
    scope: 'database', kind: 'rate', fleet: false, empty: NEEDS_TWO },

  { metric: 'replicationLagSecs', gate: 'keep-up', label: 'Replication lag', unit: 'secs', scope: 'server',
    kind: 'level', fleet: true,
    empty: 'No standby reported a replay lag. None is attached, or this role cannot read replication state.' },
  { metric: 'walBytesPerSec', gate: 'keep-up', label: 'WAL written', unit: 'bytesPerSec', scope: 'server',
    kind: 'rate', fleet: false, empty: NEEDS_TWO },
  { metric: 'xidAge', gate: 'keep-up', label: 'Transaction ID age', unit: 'count', scope: 'database',
    kind: 'level', fleet: true, ceiling: 'wraparound', empty: NO_READING },
  { metric: 'xminAge', gate: 'keep-up', label: 'Oldest snapshot, in transactions', unit: 'count',
    scope: 'server', kind: 'level', fleet: false, empty: NO_READING },
  { metric: 'sizeBytes', gate: 'keep-up', label: 'Database size', unit: 'bytes', scope: 'database',
    kind: 'level', fleet: false, zero: false, empty: NO_READING },
];

/** A chart's props, as plain data. Everything here survives the trip into a client component. */
export interface BoardChart {
  metric: HealthMetric;
  label: string;
  unit: Unit;
  scope: 'database' | 'server';
  points: HealthChartPoint[];
  inner?: HealthChartPoint[];
  innerLabel?: string;
  ceiling: number | null;
  zero: boolean;
  empty: string;
  caveat: string | null;
  note: string | null;
  fit: { fromValue: number; toValue: number } | null;
}

const seriesOf = (points: readonly HealthPoint[], metric: HealthMetric): HealthChartPoint[] =>
  points.map((p) => ({ at: p.at, value: p[metric] }));

function latest(points: readonly HealthPoint[], metric: HealthMetric): number | null {
  for (let i = points.length - 1; i >= 0; i -= 1) {
    const v = points[i]![metric];
    if (v !== null) return v;
  }
  return null;
}

export function chartFor(spec: ChartSpec, points: readonly HealthPoint[]): BoardChart {
  const ceiling = spec.ceiling === 'wraparound'
    ? XID_WRAPAROUND
    : spec.ceiling === 'maxConnections' ? latest(points, 'maxConnections') : null;
  return {
    metric: spec.metric,
    label: spec.label,
    unit: spec.unit,
    scope: spec.scope,
    points: seriesOf(points, spec.metric),
    ...(spec.inner ? { inner: seriesOf(points, spec.inner), innerLabel: spec.innerLabel } : {}),
    ceiling,
    zero: spec.zero ?? true,
    empty: spec.empty,
    caveat: spec.caveat ?? null,
    note: null,
    fit: null,
  };
}

const HOUR_MS = 3_600_000;

export const WINDOWS = [
  { key: '6h', label: '6 hours', ms: 6 * HOUR_MS },
  { key: '48h', label: '48 hours', ms: 48 * HOUR_MS },
  { key: '7d', label: '7 days', ms: 7 * DAY_MS },
  { key: '30d', label: '30 days', ms: 30 * DAY_MS },
  { key: '90d', label: '90 days', ms: 90 * DAY_MS },
] as const;

const DEFAULT_WINDOW = WINDOWS[1];
/** Shorter than this and not even one two-minute bucket per chart column is worth drawing. */
const MIN_WINDOW_MS = 10 * 60_000;

export interface HealthWindow {
  /** A named window, or null for a start and end taken from the URL. */
  key: string | null;
  from: number;
  to: number;
}

/**
 * The window a URL asks for.
 *
 * Anything that is not a usable window falls back to the default instead of
 * throwing or drawing an empty axis: unparseable dates, a backwards or
 * too-short range, one longer than retention, one that ends in the future.
 */
export function parseWindow(
  sp: Record<string, string | string[] | undefined>,
  now: number,
): HealthWindow {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const from = Date.parse(one(sp.from) ?? '');
  const to = Date.parse(one(sp.to) ?? '');
  if (Number.isFinite(from) && Number.isFinite(to)
      && to - from >= MIN_WINDOW_MS && to - from <= 90 * DAY_MS && to <= now + 60_000) {
    return { key: null, from, to };
  }
  const named = WINDOWS.find((w) => w.key === one(sp.window)) ?? DEFAULT_WINDOW;
  return { key: named.key, from: now - named.ms, to: now };
}

export interface BoardGroup { gate: Gate; title: string; charts: BoardChart[] }

/**
 * Every chart for one database, grouped under the four gates in gate order.
 * Titles come from GATES, the same record the tabs and the triage bands
 * read, so the Health page cannot name a gate differently from the rest.
 */
export function boardGroups(
  points: readonly HealthPoint[],
  win: { from: number; to: number },
): BoardGroup[] {
  const trended = win.to - win.from >= MIN_TREND_DAYS * DAY_MS;
  return GATE_ORDER.map((gate) => ({
    gate,
    title: GATES[gate].title,
    charts: HEALTH_CHARTS.filter((c) => c.gate === gate).map((spec) => {
      const chart = chartFor(spec, points);
      return trended ? { ...chart, ...trendFor(spec, chart, win) } : chart;
    }),
  }));
}

/**
 * What a level did over a window of seven days or more.
 *
 * Every level states its change. A projection is added only where pgops
 * knows the ceiling (connections against the limit, transaction ID age
 * against wraparound). Size gets a growth rate and no date: the ceiling is
 * the disk, and pgops cannot see the disk.
 */
function trendFor(
  spec: ChartSpec,
  chart: BoardChart,
  win: { from: number; to: number },
): Pick<BoardChart, 'note' | 'fit'> {
  const none = { note: null, fit: null };
  if (spec.kind !== 'level') return none;
  const peaks = dailyPeaks(chart.points, win.to);
  if (peaks.length === 0) return none;
  if (peaks.length < MIN_TREND_DAYS) {
    const left = MIN_TREND_DAYS - peaks.length;
    return { note: `Trend needs ${MIN_TREND_DAYS} days of history; ${plural(left, 'more day')} to go.`, fit: null };
  }
  const delta = peaks[peaks.length - 1]!.value - peaks[0]!.value;
  const change = `${delta >= 0 ? '+' : '−'}${formatUnit(spec.unit, Math.abs(delta))} over ${peaks.length} days, by daily peak.`;
  const line = fitPeaks(peaks);
  const isSize = spec.metric === 'sizeBytes';
  if (line === null || (chart.ceiling === null && !isSize)) return { note: change, fit: null };

  const fit = { fromValue: valueAt(line, win.from), toValue: valueAt(line, win.to) };
  if (isSize) {
    const growth = line.perDay > 0 ? ` Growing ${formatBytes(line.perDay)} a day.` : '';
    return { note: `${change}${growth}`, fit };
  }
  const days = daysUntil(line, chart.ceiling!, win.to);
  const projection = days === null
    ? 'Not rising.'
    : `A straight line through the daily peaks reaches ${formatUnit(spec.unit, chart.ceiling!)} in about ${plural(Math.round(days), 'day')}.`;
  return { note: `${change} ${projection}`, fit };
}
