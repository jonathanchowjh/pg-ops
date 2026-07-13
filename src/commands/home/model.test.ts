import { describe, expect, it } from 'vitest';
import {
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
