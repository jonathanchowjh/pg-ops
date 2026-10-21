import { describe, expect, it } from 'vitest';
import { horizon, type HorizonRow } from '../src/checks/horizon.js';

const hzRow = (over: Partial<HorizonRow> = {}): HorizonRow => ({
  kind: 'backend', who: '1', xmin_age: 1, age_secs: null, detail: 'x · unknown', backend_start: '2026-10-20 08:00:00+00', waiting: false, total: 1, ...over,
});

/**
 * The pre-LIMIT count travels on every row via `total` (`count(*) OVER ()`),
 * so `map` detects truncation from that column, never from the LIMIT constant.
 */
describe('horizon.map', () => {
  it('signals truncation when the pre-LIMIT count exceeds the returned rows', () => {
    const rows = Array.from({ length: 11 }, (_, i) => hzRow({ who: String(i), total: 15 }));
    const d = horizon.map(rows);
    expect(d.truncated).toBe(true);
    expect(d.holders).toHaveLength(11);
  });

  it('does not signal truncation when every matching row was returned', () => {
    const rows = Array.from({ length: 3 }, (_, i) => hzRow({ who: String(i), total: 3 }));
    expect(horizon.map(rows).truncated).toBe(false);
  });

  it('does not signal truncation on an empty result', () => {
    expect(horizon.map([])).toEqual({ holders: [], truncated: false });
  });
});
