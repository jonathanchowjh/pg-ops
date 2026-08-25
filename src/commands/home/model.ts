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

/**
 * How the cockpit spends its lines.
 *
 * Unlike the three list views, `Home` renders no `Table`, so nothing clips it:
 * whatever it produces is what Ink is handed. Its height is
 * `stateRows + longRunningRows + fixed chrome`, and `stateRows` is unbounded in
 * principle — `SESSIONS_SQL` is a `GROUP BY state` with no `LIMIT`, so a busy
 * database can report six or more. Add the tab strip's two lines and an
 * ordinary busy box overflows an 80x24 terminal, which is worse than it sounds:
 * Ink clears the whole terminal and its scrollback for any frame at or above
 * `rows` (see `INK_CLEAR_RESERVE`), so the screen flashes every 5s poll.
 *
 * Two levers, spent in this order:
 *
 *  1. **The blank line between panels.** Four of them. They are the first thing
 *     to go, because compactness costs legibility while a wiped scrollback
 *     costs the operator the context that sent them here.
 *  2. **State rows.** Only after the spacing is already gone, and never below
 *     one — a cockpit showing no sessions at all during a sessions incident is
 *     not a cockpit. What is dropped is reported as `+N more`, never silently:
 *     the same rule `Table` follows for dropped columns.
 *
 * `longRunning` is not a lever: `LONG_RUNNING_SQL` already has `LIMIT 3`, and
 * those three rows are the panel's entire content.
 */
export interface HomeBudget {
  /** `marginBottom` between panels: 1 when it fits, 0 when it does not. */
  spacing: 0 | 1;
  /** How many SESSIONS state rows to render. At least 1 whenever there is one. */
  stateRows: number;
  /** How many state rows were dropped — rendered as `+N more`, never hidden. */
  hiddenStates: number;
}

/**
 * Fixed lines `Home` renders regardless of data, at `spacing` 0:
 * SESSIONS header, BLOCKED header + body, LONG-RUNNING header,
 * CONNECTIONS header + body, HEALTH header + 2 verdict lines.
 */
const HOME_FIXED_LINES = 9;
/** The four `marginBottom={1}`s, present only at `spacing` 1. */
const HOME_SPACING_LINES = 4;

export function budgetHome(opts: { maxLines: number; states: number; longRunning: number }): HomeBudget {
  // Both panels render one "nothing here" line when empty, so an empty panel
  // costs the same as a one-row one. Budgeting for 0 would under-count.
  const states = Math.max(1, opts.states);
  const longRunning = Math.max(1, opts.longRunning);
  const base = HOME_FIXED_LINES + longRunning;

  if (base + HOME_SPACING_LINES + states <= opts.maxLines) {
    return { spacing: 1, stateRows: opts.states, hiddenStates: 0 };
  }
  if (base + states <= opts.maxLines) {
    return { spacing: 0, stateRows: opts.states, hiddenStates: 0 };
  }
  // Compact and still over: clip. The `+N more` line occupies one of the rows
  // it is reporting on, so it is subtracted here rather than added later.
  const room = Math.max(1, opts.maxLines - base - 1);
  const stateRows = Math.min(opts.states, room);
  return { spacing: 0, stateRows, hiddenStates: opts.states - stateRows };
}
