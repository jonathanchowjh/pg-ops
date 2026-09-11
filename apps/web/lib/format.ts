/**
 * Ported in spirit from the TUI's formatDuration. Hours drop seconds because a
 * 27-hour transaction's second count is noise, and the column it sits in is
 * narrow on every surface that renders it.
 */
export function formatDuration(secs: number | null): string {
  if (secs === null) return '—';
  const s = Math.max(0, Math.floor(secs));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export function formatCount(n: number): string {
  return new Intl.NumberFormat('en-US').format(n);
}

/**
 * Durations that arrive in MILLISECONDS, which is what pg_stat_statements
 * reports and what the Queries page ranks by.
 *
 * `formatDuration` cannot do this job. It floors to whole seconds, so every
 * query mean below a second — which is very nearly all of them — rendered as
 * "0s": the column the page sorts by was unreadable for the ordinary case.
 * Dividing by 1000 and reusing the seconds formatter was itself a fix for the
 * opposite bug (a 250ms value read as seconds rendered "250h 0m"); it cured
 * the overflow and produced this.
 *
 * Precision falls as magnitude rises, because that is how the number is read:
 * a tenth of a millisecond matters at 3ms and is noise at 3 minutes.
 */
export function formatMillis(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  if (ms <= 0) return '0ms';
  // Anything faster than this is below the resolution worth printing, and
  // "0ms" would read as "free" for a statement that did do work.
  if (ms < 0.1) return '<0.1ms';
  if (ms < 100) return `${Number(ms.toFixed(1))}ms`;
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${Number((ms / 1_000).toFixed(1))}s`;
  return formatDuration(ms / 1_000);
}

/**
 * Byte counts, for WAL retained by a replication slot.
 *
 * Binary units, because that is what Postgres reports and what its own
 * settings use — `max_slot_wal_keep_size` is written in MB meaning 2^20, and
 * a console that printed 1.05 GB where the server means 1 GiB would be
 * inviting an off-by-7% comparison against the setting the operator is about
 * to change.
 *
 * The suffixes stay the familiar KB/MB/GB rather than KiB/MiB/GiB, matching
 * `pg_size_pretty`, which is the string this number will be compared against
 * in psql two minutes later.
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
  // One decimal below ten, none above: "1.2 GB" is a different quantity from
  // "1.9 GB" to someone deciding whether to drop a slot, while "847 MB" and
  // "847.3 MB" are the same decision.
  return `${value < 10 ? Number(value.toFixed(1)) : Math.round(value)} ${units[unit]}`;
}
