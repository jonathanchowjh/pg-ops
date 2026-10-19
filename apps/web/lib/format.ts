/**
 * Hours drop seconds because a 27-hour transaction's second count is noise,
 * and the column it sits in is narrow.
 */
export function formatDuration(secs: number | null): string {
  if (secs === null) return '—';
  const s = Math.max(0, Math.floor(secs));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/**
 * A count and its noun, agreeing. The plural is passed where it is not just
 * `+s`. Zero takes the plural: "0 sequences".
 */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

/**
 * A count is a whole number, which is why this rounds. The fractional inputs
 * come from the chart, whose axis ticks are interpolated between the bounds
 * of a series.
 */
export function formatCount(n: number): string {
  return new Intl.NumberFormat('en-US').format(Math.round(n));
}

/** A count in three characters or so: 950, 1.2K, 48M. For an axis tick and a readout, never for a figure someone compares. */
export function formatCompact(n: number): string {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

/** A rate with its unit said beside it. A statement run three times a thousand seconds must not print as 0. */
export function formatRate(v: number): string {
  if (!(v > 0)) return '0';
  if (v < 0.1) {
    // One significant digit, in plain decimals: a statistics reset months ago gives rates that print as 1e-7.
    const r = Number(v.toPrecision(1));
    return r.toFixed(Math.max(1, -Math.floor(Math.log10(r))));
  }
  if (v < 10) return v.toFixed(1);
  return formatCompact(Math.round(v));
}

/**
 * Durations that arrive in milliseconds, which is what pg_stat_statements
 * reports. `formatDuration` floors to whole seconds, so it would render every
 * query mean below a second as "0s". Precision falls as magnitude rises.
 */
export function formatMillis(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  if (ms <= 0) return '0ms';
  // "0ms" would read as "free" for a statement that did do work.
  if (ms < 0.1) return '<0.1ms';
  if (ms < 100) return `${Number(ms.toFixed(1))}ms`;
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${Number((ms / 1_000).toFixed(1))}s`;
  return formatDuration(ms / 1_000);
}

/**
 * Byte counts, in binary units, because that is what Postgres reports and
 * what its own settings use — `max_slot_wal_keep_size` is written in MB
 * meaning 2^20. The suffixes are KB/MB/GB rather than KiB/MiB/GiB, matching
 * `pg_size_pretty`.
 */
export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return '—';
  const n = Math.max(0, bytes);
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // One decimal below ten, none above.
  return `${value < 10 ? Number(value.toFixed(1)) : Math.round(value)} ${units[unit]}`;
}

/**
 * What a health figure measures. A string and not a formatting function
 * because chart props cross from a server page into a client component, and
 * a function cannot make that trip.
 */
export type Unit = 'count' | 'sessions' | 'secs' | 'millis' | 'bytes' | 'bytesPerSec' | 'perSec' | 'pct' | 'compact' | 'rate';

export function formatUnit(unit: Unit, v: number): string {
  switch (unit) {
    case 'count': return formatCount(Math.round(v));
    // An average number of sessions is usually a fraction; 0.25 must not print as 0.
    case 'sessions': return v === 0 ? '0' : v < 0.1 ? v.toFixed(3) : v < 10 ? v.toFixed(2) : v.toFixed(1);
    case 'secs': return formatDuration(v);
    case 'millis': return formatMillis(v);
    case 'bytes': return formatBytes(v);
    case 'bytesPerSec': return `${formatBytes(v)}/s`;
    case 'perSec':
      if (v === 0) return '0/s';
      if (v < 0.1) return `${v.toFixed(2)}/s`;
      return v < 10 ? `${v.toFixed(1)}/s` : `${formatCount(Math.round(v))}/s`;
    case 'pct': return `${v.toFixed(1)}%`;
    case 'compact': return formatCompact(v);
    case 'rate': return `${formatRate(v)}/s`;
  }
}

/**
 * A chart's time label. UTC and fixed-width, so the server and the browser
 * print the same string and a URL shared between time zones means one thing.
 */
export function formatUtc(ms: number): string {
  return new Date(ms).toISOString().slice(5, 16).replace('T', ' ');
}
