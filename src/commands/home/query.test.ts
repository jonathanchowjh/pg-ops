import { describe, expect, it } from 'vitest';
import { mapSessionsPanel, mapSlotsPanel, panelErrorMessage } from './query.js';

describe('mapSessionsPanel', () => {
  it('picks the LONGER duration when the aborted variant has MORE sessions', () => {
    // Real incident shape: many sessions piled up in the aborted state after a
    // retried failing statement, but a single plain 'idle in transaction'
    // session has been stuck far longer and is the one pinning vacuum.
    const byState = [
      { state: 'idle in transaction (aborted)', sessions: 12, longestInStateSecs: 45 },
      { state: 'idle in transaction', sessions: 1, longestInStateSecs: 840 },
      { state: 'active', sessions: 3, longestInStateSecs: 2 },
    ];
    expect(mapSessionsPanel(byState).oldestIdleInTxnSecs).toBe(840);
  });

  it('reports the aborted variant when it is the only idle-in-txn state present', () => {
    const byState = [
      { state: 'idle in transaction (aborted)', sessions: 2, longestInStateSecs: 120 },
      { state: 'active', sessions: 1, longestInStateSecs: 1 },
    ];
    expect(mapSessionsPanel(byState).oldestIdleInTxnSecs).toBe(120);
  });

  it('returns null when no idle-in-transaction states are present', () => {
    const byState = [
      { state: 'active', sessions: 5, longestInStateSecs: 3 },
      { state: 'idle', sessions: 10, longestInStateSecs: 500 },
    ];
    expect(mapSessionsPanel(byState).oldestIdleInTxnSecs).toBeNull();
  });

  it('preserves byState unchanged (panel still shows each state separately)', () => {
    const byState = [
      { state: 'idle in transaction', sessions: 1, longestInStateSecs: 10 },
      { state: 'idle in transaction (aborted)', sessions: 2, longestInStateSecs: 20 },
    ];
    expect(mapSessionsPanel(byState).byState).toEqual(byState);
  });
});

describe('mapSlotsPanel', () => {
  it('coerces numeric-string fields and passes worstSlot through', () => {
    const row = { inactive: '1', retained_bytes: '2147483648', worst_slot: 'etl_to_snowflake' };
    expect(mapSlotsPanel(row)).toEqual({
      inactiveCount: 1,
      retainedBytes: 2147483648,
      worstSlot: 'etl_to_snowflake',
    });
  });

  it('defaults to zero/null when the row is undefined', () => {
    expect(mapSlotsPanel(undefined)).toEqual({
      inactiveCount: 0,
      retainedBytes: 0,
      worstSlot: null,
    });
  });
});

describe('panelErrorMessage', () => {
  it('uses the error message when there is one', () => {
    expect(panelErrorMessage(new Error('permission denied'))).toBe('permission denied');
  });

  it('unwraps an AggregateError, whose own message is empty', () => {
    // What Node actually throws when the database is down and the host resolves
    // to both ::1 and 127.0.0.1 — a panel must not render as `n/a ()`.
    const err = new AggregateError([
      new Error('connect ECONNREFUSED ::1:1'),
      new Error('connect ECONNREFUSED 127.0.0.1:1'),
    ]);
    expect(err.message).toBe('');
    expect(panelErrorMessage(err)).toBe('connect ECONNREFUSED ::1:1; connect ECONNREFUSED 127.0.0.1:1');
  });

  it('never returns an empty string, whatever it was handed', () => {
    for (const thrown of [new AggregateError([]), 'boom', null, undefined, {}]) {
      expect(panelErrorMessage(thrown)).not.toBe('');
    }
  });
});
