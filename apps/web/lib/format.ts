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
