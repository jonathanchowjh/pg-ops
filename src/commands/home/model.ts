import type {
  BlockedPanel, ConnectionsPanel, LongRunningRow, SessionsPanel, SlotsCard, WraparoundCard,
} from './query.js';

/**
 * Pure verdict logic for the triage cockpit (plan §M2). Each function turns
 * one panel's data into a single ok/warn/critical verdict plus an optional
 * human-readable note — no Postgres, no Ink, 100% unit-tested (the analog of
 * locks/chain.ts and sessions/model.ts).
 *
 * Thresholds are the contract (see task brief's Global Constraints) — do not
 * adjust without updating model.test.ts's boundary cases.
 */

export type VerdictLevel = 'ok' | 'warn' | 'critical';
export interface Verdict { level: VerdictLevel; note?: string }

const GB = 1024 ** 3;

/** idle-in-transaction: ok <= 60s, warn > 60s, critical >= 300s (5 min). */
export function verdictSessions(p: SessionsPanel): Verdict {
  const s = p.oldestIdleInTxnSecs;
  if (s == null || s <= 60) return { level: 'ok' };
  return { level: s >= 300 ? 'critical' : 'warn', note: `oldest idle-in-transaction ${Math.round(s)}s` };
}

/** blocked: ok at zero, warn when any, critical when the longest wait >= 60s. */
export function verdictBlocked(p: BlockedPanel): Verdict {
  if (p.blockedCount === 0) return { level: 'ok' };
  const critical = (p.longestWaitSecs ?? 0) >= 60;
  return { level: critical ? 'critical' : 'warn', note: `${p.blockedCount} pid(s) waiting` };
}

/** long-running: warn > 30s, critical > 300s (5 min). Rows are pre-sorted longest-first. */
export function verdictLongRunning(rows: LongRunningRow[]): Verdict {
  const longest = rows[0]?.runningSecs ?? 0;
  if (longest > 300) return { level: 'critical', note: `pid ${rows[0]?.pid} running ${Math.round(longest)}s` };
  if (longest > 30) return { level: 'warn' };
  return { level: 'ok' };
}

/** connections: warn when headroom < 20% of max, critical when < 10%. */
export function verdictConnections(p: ConnectionsPanel): Verdict {
  const pct = p.max > 0 ? (p.headroom / p.max) * 100 : 100;
  if (pct < 10) return { level: 'critical', note: `${p.headroom} connections left` };
  if (pct < 20) return { level: 'warn', note: `${p.headroom} connections left` };
  return { level: 'ok' };
}

/** wraparound: warn >= 75% of the freeze-max-age horizon, critical >= 90%. */
export function verdictWraparound(c: WraparoundCard): Verdict {
  if (c.pctOfHorizon >= 90) return { level: 'critical', note: 'see dba-playbook/03' };
  if (c.pctOfHorizon >= 75) return { level: 'warn', note: 'see dba-playbook/03' };
  return { level: 'ok' };
}

/** slots: warn when an inactive slot retains more than 1 GB of WAL. */
export function verdictSlots(c: SlotsCard): Verdict {
  if (c.inactiveCount > 0 && c.retainedBytes > GB) {
    return { level: 'warn', note: `inactive slot '${c.worstSlot}' retaining WAL — see dba-playbook/04` };
  }
  return { level: 'ok' };
}
