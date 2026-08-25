import { describe, expect, it } from 'vitest';
import {
  budgetHome,
  verdictBlocked, verdictConnections, verdictLongRunning,
  verdictSessions, verdictSlots, verdictWraparound,
} from './model.js';

describe('cockpit verdicts', () => {
  it('sessions: ok at 60s idle-in-txn, warn above, critical at 300s', () => {
    expect(verdictSessions({ byState: [], oldestIdleInTxnSecs: null }).level).toBe('ok');
    expect(verdictSessions({ byState: [], oldestIdleInTxnSecs: 60 }).level).toBe('ok');
    expect(verdictSessions({ byState: [], oldestIdleInTxnSecs: 61 }).level).toBe('warn');
    expect(verdictSessions({ byState: [], oldestIdleInTxnSecs: 300 }).level).toBe('critical');
  });
  it('blocked: ok at zero, warn when any, critical when longest wait ≥ 60s', () => {
    expect(verdictBlocked({ blockedCount: 0, longestWaitSecs: null, suspectPid: null }).level).toBe('ok');
    expect(verdictBlocked({ blockedCount: 2, longestWaitSecs: 10, suspectPid: 1 }).level).toBe('warn');
    expect(verdictBlocked({ blockedCount: 2, longestWaitSecs: 60, suspectPid: 1 }).level).toBe('critical');
  });
  it('long-running: warn above 30s, critical above 300s', () => {
    expect(verdictLongRunning([]).level).toBe('ok');
    expect(verdictLongRunning([{ pid: 1, runningSecs: 31, query: '' }]).level).toBe('warn');
    expect(verdictLongRunning([{ pid: 1, runningSecs: 301, query: '' }]).level).toBe('critical');
  });
  it('connections: warn under 20% headroom, critical under 10%', () => {
    expect(verdictConnections({ used: 50, max: 100, headroom: 50 }).level).toBe('ok');
    expect(verdictConnections({ used: 81, max: 100, headroom: 19 }).level).toBe('warn');
    expect(verdictConnections({ used: 91, max: 100, headroom: 9 }).level).toBe('critical');
  });
  it('wraparound: warn at 75%, critical at 90%', () => {
    expect(verdictWraparound({ pctOfHorizon: 74 }).level).toBe('ok');
    expect(verdictWraparound({ pctOfHorizon: 75 }).level).toBe('warn');
    expect(verdictWraparound({ pctOfHorizon: 90 }).level).toBe('critical');
  });
  it('slots: warn when an inactive slot retains more than 1 GB', () => {
    expect(verdictSlots({ inactiveCount: 0, retainedBytes: 0, worstSlot: null }).level).toBe('ok');
    expect(verdictSlots({ inactiveCount: 1, retainedBytes: 2 * 1024 ** 3, worstSlot: 'debezium' }).level).toBe('warn');
    expect(verdictSlots({ inactiveCount: 1, retainedBytes: 2 * 1024 ** 3, worstSlot: 'debezium' }).note).toContain('debezium');
  });
});

/**
 * The cockpit's line budget. Pure, so it can be pinned at sizes the render
 * tests cannot reach — `ink-testing-library`'s stdout stub exposes no `rows`
 * at all, so a rendered cockpit is always measured against the 24-row
 * fallback.
 *
 * Both levers are asserted at their boundary, from both sides. A budget test
 * that only checks the roomy case proves nothing: the roomy case is what you
 * get by doing no arithmetic.
 */
describe('budgetHome', () => {
  // 3 states + 3 long-running is the size that sits exactly on the spacing
  // threshold: 9 fixed + 3 long-running + 4 spacing + 3 states = 19.
  const mid = { states: 3, longRunning: 3 };

  it('keeps the blank lines between panels when they fit', () => {
    expect(budgetHome({ maxLines: 19, ...mid })).toEqual({ spacing: 1, stateRows: 3, hiddenStates: 0 });
  });

  it('drops the spacing before it drops a row — one line under, all rows survive', () => {
    expect(budgetHome({ maxLines: 18, ...mid })).toEqual({ spacing: 0, stateRows: 3, hiddenStates: 0 });
    // ...and it keeps them all the way down to the compact floor (9 + 3 + 3).
    expect(budgetHome({ maxLines: 15, ...mid })).toEqual({ spacing: 0, stateRows: 3, hiddenStates: 0 });
  });

  it('clips rows only after the spacing is already gone, and says how many', () => {
    // 14 leaves room for 9 fixed + 3 long-running + 1 `+N more` + 1 row.
    expect(budgetHome({ maxLines: 14, ...mid })).toEqual({ spacing: 0, stateRows: 1, hiddenStates: 2 });
  });

  it('never renders zero state rows, however small the terminal claims to be', () => {
    // A cockpit showing no sessions at all during a sessions incident is not a
    // cockpit. It goes over budget instead — visibly, rather than by lying.
    const tiny = budgetHome({ maxLines: 1, states: 6, longRunning: 3 });
    expect(tiny.stateRows).toBe(1);
    expect(tiny.hiddenStates).toBe(5);
  });

  it('budgets an empty panel as the one line it actually renders', () => {
    // Both panels print a "nothing here" line when empty, so zero rows costs
    // the same as one. Budgeting for 0 would under-count by two lines.
    //
    // 15 is the only value that proves it, and finding that out took a review:
    // an empty cockpit needs 9 + 1 + 1 + 4 = 15 to keep its spacing. Assert at
    // 13 and both `Math.max(1, …)` clamps can be deleted while the test stays
    // green — it would name the clamps as its subject and protect neither.
    expect(budgetHome({ maxLines: 15, states: 0, longRunning: 0 })).toEqual({
      spacing: 1,
      stateRows: 0,
      hiddenStates: 0,
    });
    // One under, and the spacing is what gives — not a row, because there is
    // no row to give.
    expect(budgetHome({ maxLines: 14, states: 0, longRunning: 0 })).toEqual({
      spacing: 0,
      stateRows: 0,
      hiddenStates: 0,
    });
  });
});
