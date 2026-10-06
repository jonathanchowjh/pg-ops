import { describe, expect, it } from 'vitest';
import { horizon, type HorizonRow } from '../src/checks/horizon.js';

const t = horizon.thresholds!;
const holder = (over: Partial<import('../src/checks/horizon.js').HorizonHolder> = {}) => ({
  kind: 'backend' as const, who: '4021', xminAge: 1, ageSecs: 60, detail: 'app · idle in transaction', ...over,
});

const hzRow = (over: Partial<HorizonRow> = {}): HorizonRow => ({
  kind: 'backend', who: '1', xmin_age: 1, age_secs: null, detail: 'x · unknown', total: 1, ...over,
});

/**
 * Review round 1, GAP 1: `truncated` was never exercised anywhere in this
 * package's test suite. `horizon.test.ts` tested only `verdict`; the
 * integration test's one scenario never produced eleven holders; and
 * `cleanup-page.test.tsx` sets `HorizonData` literally through its mock,
 * which bypasses `map` entirely. Mutating `map` to `truncated: false`
 * unconditionally passed every test that existed before these three.
 *
 * Same technique as long-running.ts's own truncation tests: the pre-LIMIT
 * count travels on every row via `total` (`count(*) OVER ()`), so `map`
 * — pure over `rows` alone — detects truncation from that column, never
 * from the LIMIT constant itself.
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
    // The axis is xid distance, not wall-clock: see this task's docblock.
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
   * THE DEFECT THIS TASK WAS REWRITTEN FOR. The earlier draft asserted `ok`
   * here. A slot cannot be timed in seconds, which is exactly why it must be
   * judged on the axis it CAN be measured on — otherwise the one holder most
   * likely to pin the horizon for months is the one holder the console calls
   * fine. "We cannot measure this the way we measure the others" must never
   * render as "this is fine", the same rule the README states for a check that
   * could not run at all.
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
    // The WORST holder is named, not the first one in the list.
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
   * Review round 1, GAP 2: every existing test value sits well clear of
   * both threshold lines (22, 60,000,000, 300,000,000 against 50e6/200e6),
   * so swapping `>=` for `>` at either threshold survived the whole suite
   * above. `>=` versus `>` is otherwise invisible to it; only pinning the
   * flip point itself catches that.
   *
   * The threshold is INCLUSIVE — the same register long-running.ts's own
   * boundary sweep documents (see its I5 comment): a threshold is the value
   * AT WHICH a holder becomes a problem, worded that way in every
   * `because` string in this package, so a holder sitting exactly on
   * 50,000,000 or 200,000,000 transactions is already warn/critical, not
   * one transaction short of it.
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
