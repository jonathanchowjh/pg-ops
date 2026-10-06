import { formatBytes, formatCount, plural } from '@/lib/format';
import type { PageRates } from '@/lib/rates';

/**
 * Commits, rollbacks, deadlocks and temp spill, over the last poll interval.
 *
 * Shared by the Queries page (where it is the whole panel) and the Triage
 * page (where it is also the compact summary, imported from here rather than
 * written twice) — see rates.ts for why the interval is measured on the
 * server's own clock and not the host's.
 *
 * A deadlock is the one thing here rendered in the critical ink without a
 * verdict: it is a count of a thing that should be zero, not a threshold
 * judgement.
 *
 * `compact` is the Triage band's one-line slot, where this panel lives by
 * construction. It used to be a hand-written span in the triage page listing
 * commits, rollbacks and deadlocks — a second copy of the formatting this
 * component's docblock claims to prevent, and the reason B11's own-share
 * clause reached the Queries page and the loud panel but not the single line
 * an operator reads on the page where the defect was found. The line is
 * owned here now: the three readings it carried, plus the clause, and none
 * of the detail a one-line slot has no room for.
 */
export function Throughput({ rates: r, compact = false }: { rates: PageRates | null; compact?: boolean }) {
  if (r === null) {
    const text = 'Rates need two readings — rates after the next refresh.';
    return compact
      ? <span className="text-muted-foreground">{text}</span>
      : <p className="text-sm text-muted-foreground">{text}</p>;
  }
  // B11. pg_stat_database counts every transaction against the database, and
  // each poll of each page is one — it cannot be filtered by application, so
  // A8's marker does not reach this counter and the console was reporting its
  // own heartbeat as the application's load.
  //
  // Stated beside the rate rather than taken out of it: the count is per web
  // process (see lib/pools.ts), so a second replica's polling is invisible
  // here, and a subtracted rate would read as the application's load while
  // being wrong by exactly the amount nobody can see. Two numbers side by
  // side are honest; one corrected number is not.
  //
  // Omitted at zero: a database doing real work with a quiet console should
  // not carry a "0 of them" clause on a line read at a glance, and the
  // absence says the same thing.
  //
  // A LABELLED RATE, not a share of the number beside it. The first wording
  // was "N of them this console's own reads", and driving it put
  // "4 commits/s · 5 of them this console's own reads" on the Triage page:
  // this count runs about one statement ahead of the server snapshot it is
  // compared against — the `databaseActivity` query itself commits after the
  // counters it reports — and the two numbers round independently. A subset
  // claim that exceeds its own total reads as a rendering fault. As two
  // labelled readings the same numbers cannot contradict each other, and the
  // tilde says the comparison is approximate, which it is.
  const own = Math.round(r.ownPerSec) > 0
    ? `this console ~${formatCount(Math.round(r.ownPerSec))}/s`
    : null;
  if (compact) {
    const short = [
      `${formatCount(Math.round(r.commitsPerSec))} commits/s`,
      `${formatCount(Math.round(r.rollbacksPerSec))} rollbacks/s`,
      r.deadlocks > 0 ? plural(r.deadlocks, 'deadlock') : null,
      own,
    ].filter((p): p is string => p !== null);
    return (
      <span>
        {short.map((p, i) => (
          <span key={p} className={p.includes('deadlock') ? 'font-medium text-critical-ink' : undefined}>
            {i > 0 ? ' · ' : ''}{p}
          </span>
        ))}
      </span>
    );
  }
  const parts = [
    `${formatCount(Math.round(r.commitsPerSec))} commits/s`,
    `${formatCount(Math.round(r.rollbacksPerSec))} rollbacks/s`,
    r.deadlocks > 0 ? plural(r.deadlocks, 'deadlock') : null,
    r.tempBytesPerSec > 0 ? `${formatBytes(r.tempBytesPerSec)}/s to temp files` : null,
    r.cacheHitPct === null ? null : `${r.cacheHitPct.toFixed(1)}% cache hit`,
    own,
  ].filter((p): p is string => p !== null);
  return (
    <p className="text-sm">
      <span className="text-muted-foreground">last {Math.round(r.seconds)}s · </span>
      {parts.map((p, i) => (
        <span key={p} className={p.includes('deadlock') ? 'font-medium text-critical-ink' : undefined}>
          {i > 0 ? ' · ' : ''}{p}
        </span>
      ))}
    </p>
  );
}
