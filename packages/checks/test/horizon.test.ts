import { describe, expect, it } from 'vitest';
import { horizon, type HorizonRow } from '../src/checks/horizon.js';

const t = horizon.thresholds!;
const holder = (over: Partial<import('../src/checks/horizon.js').HorizonHolder> = {}) => ({
  kind: 'backend' as const, who: '4021', xminAge: 1, ageSecs: 60, detail: 'app · idle in transaction', backendStart: '2026-10-20 08:00:00+00', waiting: false, ...over,
});

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

describe('horizon', () => {
  it('is ok with nothing holding a snapshot', () => {
    expect(horizon.verdict!({ holders: [], truncated: false }, t)).toEqual({ level: 'ok' });
  });

  it('is ok when the horizon has barely moved, however long it has been open', () => {
    // Eleven minutes on a quiet database is ~22 transactions of pinned garbage.
    // The axis is xid distance, not wall-clock.
    const v = horizon.verdict!({ holders: [holder({ xminAge: 22, ageSecs: 660 })], truncated: false }, t);
    expect(v).toEqual({ level: 'ok' });
  });

  it('warns on a backend that has pinned the horizon far back, and names it', () => {
    const v = horizon.verdict!({ holders: [holder({ xminAge: 60_000_000, ageSecs: 900 })], truncated: false }, t);
    expect(v.level).toBe('warn');
    expect(v.note).toContain('4021');
    expect(v.note).toContain('60000000');
  });

  /**
   * A slot cannot be timed in seconds, so it must be judged on xid distance.
   * Otherwise the holder most likely to pin the horizon for months is the one
   * the console calls fine.
   */
  it('judges a slot on transactions, though it can never know its seconds', () => {
    const d = { holders: [holder({ kind: 'slot', who: 'sub_1', xminAge: 900_000_000, ageSecs: null, detail: 'inactive' })], truncated: false };
    const v = horizon.verdict!(d, t);
    expect(v.level).toBe('critical');
    expect(v.note).toContain('sub_1');
    expect(v.note).toContain('slot');
  });

  it('escalates on a prepared transaction too, and picks the worst holder', () => {
    const d = {
      holders: [
        holder({ xminAge: 60_000_000 }),
        holder({ kind: 'prepared', who: 'gid-1', xminAge: 300_000_000, ageSecs: 4000, detail: 'app' }),
      ],
      truncated: false,
    };
    const v = horizon.verdict!(d, t);
    expect(v.level).toBe('critical');
    // The worst holder is named, not the first one in the list.
    expect(v.note).toContain('gid-1');
  });

  it('says how long when it knows, and does not pretend when it does not', () => {
    const timed = horizon.verdict!({ holders: [holder({ xminAge: 60_000_000, ageSecs: 900 })], truncated: false }, t);
    expect(timed.note).toContain('15m');
    const untimed = horizon.verdict!({ holders: [holder({ kind: 'slot', who: 's', xminAge: 60_000_000, ageSecs: null })], truncated: false }, t);
    expect(untimed.note).not.toContain('m ');
    expect(untimed.note).not.toMatch(/\d+m$/);
  });

  /**
   * The other tests' values sit well clear of both lines, so only this one
   * tells `>=` from `>`. The threshold is inclusive: it is the value at which
   * a holder becomes a problem.
   */
  it('flips at each threshold itself, not one transaction past it', () => {
    const at = (xminAge: number) =>
      horizon.verdict!({ holders: [holder({ xminAge })], truncated: false }, t).level;
    expect(at(49_999_999)).toBe('ok');
    expect(at(50_000_000)).toBe('warn');
    expect(at(199_999_999)).toBe('warn');
    expect(at(200_000_000)).toBe('critical');
  });
});
